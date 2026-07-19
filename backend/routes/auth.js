import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import supabase from '../lib/supabase.js';
import { oauth2Client, signinOAuth2Client, newOAuth2Client, newSigninOAuth2Client, MINIMUM_SCOPES, SERVICE_SCOPES, encryptToken, decryptToken } from '../lib/google.js';
import { JWT_SECRET, authenticateToken } from '../middleware/auth.js';
import { issueOAuthState, consumeOAuthState, revokeJti, newJti } from '../lib/security.js';
import { safeLogError } from '../lib/log.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

const router = Router();

router.get('/google', (req, res) => {
  // P1.12 / two-project split — sign-in goes through the dedicated
  // signinOAuth2Client (separate Cloud project, only declares profile +
  // email on its consent screen, no sensitive scopes). Because Google
  // evaluates the warning per-project-not-per-request, that project
  // never triggers the "Google hasn't verified this app" screen at
  // sign-in. The state payload's `purpose: 'signin'` tells the callback
  // to use newSigninOAuth2Client for the code exchange and to skip
  // gmail_accounts persistence (Project A tokens grant only profile/email
  // and are useless beyond identity verification).
  const authUrl = signinOAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: MINIMUM_SCOPES,
    prompt: 'consent',
    include_granted_scopes: true,
    state: issueOAuthState({ purpose: 'signin' }),
  });
  res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    return res.redirect(`${FRONTEND_URL}?auth=error`);
  }

  try {
    // P0.2: state is decoded BEFORE the code exchange because the chosen
    // OAuth client must match the one that issued the URL. The code
    // exchange will fail with invalid_grant if you mix Project A and
    // Project B clients.
    //   purpose: 'link'           — adding account to existing user
    //   purpose: 'scope_upgrade'  — incremental scope grant (Project B)
    //   purpose: 'signin'         — top-level sign-in (Project A)
    //   missing/expired           — legacy clients pre-PR; treat as
    //                               main-project sign-in (the old path
    //                               that still works for in-flight OAuth
    //                               windows opened before this deploy)
    let linkToUserId = null;
    let isPopup = false;
    let upgradePayload = null;
    let isSigninFlow = false;
    if (state) {
      const payload = consumeOAuthState(state);
      if (payload && payload.purpose === 'link' && payload.userId) {
        linkToUserId = payload.userId;
        isPopup = !!payload.popup;
      } else if (payload && payload.purpose === 'scope_upgrade' && payload.userId && payload.accountId && payload.group) {
        upgradePayload = payload;
      } else if (payload && payload.purpose === 'signin') {
        isSigninFlow = true;
      } else if (payload === null) {
        console.warn('[AUTH] OAuth state token invalid or expired — treating as fresh login');
      }
    }

    // P1.9 — fresh OAuth client per callback. The exported singleton is
    // mutated by setCredentials, which under concurrent callbacks can leak
    // user A's tokens into user B's userinfo.get() call.
    // Pick the client matching the project that issued the auth URL.
    const callbackClient = isSigninFlow ? newSigninOAuth2Client() : newOAuth2Client();
    const { tokens } = await callbackClient.getToken(code);
    callbackClient.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: callbackClient });
    const { data: userInfo } = await oauth2.userinfo.get();

    // P1.12 — scope upgrade short-circuit. We do NOT touch users/sessions:
    // this is an existing logged-in user adding scopes to an existing
    // account. We update encrypted_tokens + granted_scopes for the
    // specific account and bounce them back to where they came from.
    if (upgradePayload) {
      const { userId: upgradeUserId, accountId, group, redirectAfter } = upgradePayload;

      // Verify the user actually granted what we asked for. Google lets
      // users untick boxes on the consent screen; if they did, the
      // requested group's scopes will be missing from tokens.scope.
      const grantedScopeUrls = tokens.scope ? tokens.scope.split(' ') : [];
      const requiredScopes = SERVICE_SCOPES[group] || [];
      const missing = requiredScopes.filter(s => !grantedScopeUrls.includes(s));
      if (missing.length > 0) {
        console.warn('[AUTH] scope_upgrade incomplete', { group, missing });
        const dest = redirectAfter || `${FRONTEND_URL}/app`;
        const sep = dest.includes('?') ? '&' : '?';
        return res.redirect(`${dest}${sep}upgrade_error=incomplete&group=${encodeURIComponent(group)}`);
      }

      // Verify the account belongs to the userId in state. Anyone who
      // intercepts a state token (single-use, but defense-in-depth)
      // cannot point it at a different user's account.
      const { data: targetAccount, error: lookupErr } = await supabase
        .from('gmail_accounts')
        .select('id, user_id, granted_scopes, encrypted_tokens')
        .eq('id', accountId)
        .eq('user_id', upgradeUserId)
        .single();
      if (lookupErr || !targetAccount) {
        console.warn('[AUTH] scope_upgrade account mismatch', { accountId, upgradeUserId });
        return res.redirect(`${FRONTEND_URL}/app?upgrade_error=account_not_found`);
      }

      // Compute the merged short-label set. include_granted_scopes:true
      // means tokens.scope already lists everything previously granted +
      // the new ones; we re-derive the short-label set from scratch.
      const mergedShortLabels = [];
      if (grantedScopeUrls.some(s => s.includes('gmail'))) mergedShortLabels.push('mail');
      if (grantedScopeUrls.some(s => s.includes('drive'))) mergedShortLabels.push('docs');
      if (grantedScopeUrls.some(s => s.includes('calendar'))) mergedShortLabels.push('cals');

      // Google rotates refresh_token only when prompt='consent' AND scopes
      // change. We always pass prompt='consent' for upgrades, so we expect
      // a fresh refresh_token here. If it's missing for any reason, fall
      // back to merging into the existing token blob so we don't break
      // the account.
      const existingTokens = decryptToken(targetAccount.encrypted_tokens);
      const mergedTokens = {
        ...existingTokens,
        access_token: tokens.access_token,
        scope: tokens.scope,
        token_type: tokens.token_type || existingTokens.token_type,
        expiry_date: tokens.expiry_date,
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      };

      const { error: updateErr } = await supabase
        .from('gmail_accounts')
        .update({
          encrypted_tokens: encryptToken(mergedTokens),
          granted_scopes: mergedShortLabels,
        })
        .eq('id', accountId)
        .eq('user_id', upgradeUserId);
      if (updateErr) {
        console.error('[AUTH] scope_upgrade update failed:', updateErr);
        return res.redirect(`${FRONTEND_URL}/app?upgrade_error=db_write`);
      }

      const dest = redirectAfter || `${FRONTEND_URL}/app`;
      const sep = dest.includes('?') ? '&' : '?';
      return res.redirect(`${dest}${sep}upgraded=${encodeURIComponent(group)}`);
    }

    let userId;

    if (linkToUserId) {
      // Adding account to existing user — verify the user exists
      const { data: linkUser } = await supabase
        .from('users')
        .select('*')
        .eq('id', linkToUserId)
        .single();

      if (linkUser) {
        userId = linkUser.id;
      }
    }

    if (!userId) {
      // Normal login flow — find or create user
      const { data: existingUser, error: findErr } = await supabase
        .from('users')
        .select('*')
        .eq('google_id', userInfo.id)
        .single();

      if (findErr && findErr.code !== 'PGRST116') {
        console.error('[AUTH] Error finding user by google_id:', findErr);
      }

      if (existingUser) {
        userId = existingUser.id;
        const { error: updateErr } = await supabase
          .from('users')
          .update({
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
            last_login: new Date().toISOString()
          })
          .eq('id', userId);
        if (updateErr) console.error('[AUTH] Error updating user:', updateErr);
      } else {
        // P0.1 — DO NOT rebind google_id by email match.
        // Previously: if a user row existed with this email but a different
        // google_id, we updated google_id to the newly-authenticating Google
        // account. That allowed account takeover by anyone able to register a
        // Google account with a victim's email (Workspace alias, deleted-and-
        // recreated account, etc.). Now: any email collision with a different
        // google_id is treated as a hard failure; the legit owner can re-link
        // through a (future) admin-supervised recovery flow.
        const { data: userByEmail, error: emailErr } = await supabase
          .from('users')
          .select('id, google_id, email')
          .eq('email', userInfo.email)
          .single();

        if (emailErr && emailErr.code !== 'PGRST116') {
          console.error('[AUTH] Error finding user by email:', emailErr);
        }

        if (userByEmail && userByEmail.google_id && userByEmail.google_id !== userInfo.id) {
          console.warn('[AUTH] Email-collision login blocked', {
            existingUserId: userByEmail.id,
            attemptedGoogleId: userInfo.id,
          });
          return res.redirect(`${FRONTEND_URL}?auth=error&reason=email_in_use`);
        }

        if (userByEmail && !userByEmail.google_id) {
          // Pre-provisioned row with no google_id yet — safe to bind on first login.
          userId = userByEmail.id;
          const { error: updateErr } = await supabase
            .from('users')
            .update({
              google_id: userInfo.id,
              name: userInfo.name,
              picture: userInfo.picture,
              last_login: new Date().toISOString(),
            })
            .eq('id', userId)
            .is('google_id', null); // belt-and-suspenders against TOCTOU
          if (updateErr) console.error('[AUTH] Error binding pre-provisioned user:', updateErr);
        } else {
          const { data: newUser, error } = await supabase
            .from('users')
            .insert({
              google_id: userInfo.id,
              email: userInfo.email,
              name: userInfo.name,
              picture: userInfo.picture,
            })
            .select()
            .single();

          if (error) {
            console.error('[AUTH] Error creating user:', error);
            throw error;
          }
          userId = newUser.id;
        }
      }
    }

    // Two-project split — sign-in flow (Project A) skips gmail_accounts
    // entirely. Project A tokens grant only profile + email and are
    // useless beyond identity verification; storing them would clutter
    // the row and confuse downstream code that assumes encrypted_tokens
    // can authorize Gmail/Drive/Calendar API calls. New users land in
    // the app with zero connected accounts and click "Add Account" to
    // run the Project B OAuth (which DOES persist tokens). Existing
    // users keep their previously-stored Project B tokens — those rows
    // aren't touched here.
    if (!isSigninFlow) {
      // Determine which services the user granted
      const grantedScopes = tokens.scope ? tokens.scope.split(' ') : [];
      const grantedServices = [];
      if (grantedScopes.some(s => s.includes('gmail'))) grantedServices.push('mail');
      if (grantedScopes.some(s => s.includes('drive'))) grantedServices.push('docs');
      if (grantedScopes.some(s => s.includes('calendar'))) grantedServices.push('cals');

      const { data: existingAccount, error: accFindErr } = await supabase
        .from('gmail_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('gmail_email', userInfo.email)
        .single();

      if (accFindErr && accFindErr.code !== 'PGRST116') {
        console.error('[AUTH] Error finding gmail_account:', accFindErr);
      }

      if (!existingAccount) {
        const { error: insertErr } = await supabase.from('gmail_accounts').insert({
          user_id: userId,
          gmail_email: userInfo.email,
          account_name: userInfo.name || userInfo.email,
          picture: userInfo.picture || null,
          encrypted_tokens: encryptToken(tokens),
          granted_scopes: grantedServices
        });
        if (insertErr) {
          console.error('[AUTH] Error inserting gmail_account:', insertErr);
          throw insertErr;
        }
      } else {
        const { error: updateErr } = await supabase
          .from('gmail_accounts')
          .update({
            encrypted_tokens: encryptToken(tokens),
            granted_scopes: grantedServices,
            picture: userInfo.picture || null
          })
          .eq('id', existingAccount.id);
        if (updateErr) {
          console.error('[AUTH] Error updating gmail_account:', updateErr);
          throw updateErr;
        }
      }
    }

    // P1.5 — every JWT carries a unique jti so we can surgically revoke a
    // session on logout (or future "kill session" admin action) without
    // forcing a global secret rotation. Algorithm pinned at HS256 in middleware.
    const jti = newJti();
    const jwtToken = jwt.sign({ userId, jti }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '7d' });

    const isProduction = process.env.FRONTEND_URL?.includes('allthemail.io');
    res.cookie('auth_token', jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      domain: isProduction ? '.allthemail.io' : undefined,
    });

    // Popup link flow: render a tiny HTML page that pings the opener and
    // closes itself. The opener page (App.js) listens for the message and
    // refreshes the account list. This avoids the full-page redirect dance
    // that makes "Add account" feel slow (≥1s of blank navigation).
    if (isPopup) {
      const frontendOrigin = (() => {
        try { return new URL(FRONTEND_URL).origin; } catch { return FRONTEND_URL; }
      })();
      // Override the API-default helmet CSP for this one response. The default
      // `default-src 'none'` blocks our inline script; we need to allow inline
      // for the self-closing popup. Tightened to script-src 'unsafe-inline'
      // only (no external sources, no eval).
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      // Helmet's default Cross-Origin-Opener-Policy is 'same-origin', which
      // forces this response into a different browsing context group from
      // the opener (the React app). When the inline script then runs
      // window.opener.postMessage(...), `window.opener` is null and the
      // message never reaches the app — visible bug: "Add account does
      // nothing." Override to 'unsafe-none' for THIS response only so
      // the popup can communicate back. The opener side is already
      // 'same-origin-allow-popups' (vercel.json), which trusts popups
      // it opened that don't isolate themselves.
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // We tightly target the message at our frontend origin so a hostile
      // opener can't intercept. window.close() is silent if the popup was
      // navigated cross-site, so we also fall back to a plain "you can close
      // this window" message.
      return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Account linked</title><style>body{font:14px/1.5 -apple-system,sans-serif;color:#0a0a0a;background:#fafaf7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{text-align:center}.box h1{font-size:18px;margin:0 0 6px}.box p{margin:0;color:#555}</style></head><body><div class="box"><h1>Account linked</h1><p>You can close this window.</p></div><script>(function(){try{if(window.opener){window.opener.postMessage({type:'atm-account-linked'}, ${JSON.stringify(frontendOrigin)});}}catch(e){}try{window.close();}catch(e){}})();</script></body></html>`);
    }
    res.redirect(`${FRONTEND_URL}/app?auth=success`);
  } catch (error) {
    safeLogError('[AUTH] callback', error);
    res.redirect(`${FRONTEND_URL}?auth=error`);
  }
});

router.post('/logout', (req, res) => {
  // Revoke this session's jti so a stolen-but-still-unexpired cookie copy
  // cannot be replayed. Read the cookie defensively — clearing it also
  // requires us to know it.
  const token = req.cookies?.auth_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded.jti) {
        revokeJti(decoded.jti, decoded.exp ? decoded.exp * 1000 : undefined);
      }
    } catch (_) { /* expired/invalid: nothing to revoke */ }
  }
  const isProduction = process.env.FRONTEND_URL?.includes('allthemail.io');
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: true,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    domain: isProduction ? '.allthemail.io' : undefined,
  });
  res.json({ success: true });
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name')
      .eq('id', req.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Get user profile error:', err);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

export default router;
