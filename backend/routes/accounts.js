import { Router } from 'express';
import { google } from 'googleapis';
import supabase from '../lib/supabase.js';
import { oauth2Client, ALL_SCOPES, getOAuth2ClientForAccount, buildUpgradeAuthUrl, SERVICE_SCOPES, decryptToken, invalidateClientCache, revokeGoogleGrant } from '../lib/google.js';
import { authenticateToken } from '../middleware/auth.js';
import { issueOAuthState } from '../lib/security.js';
import { safeLogError } from '../lib/log.js';

const router = Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data: accounts, error } = await supabase
      .from('gmail_accounts')
      .select('id, gmail_email, account_name, picture, created_at, granted_scopes')
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ accounts });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ error: 'Failed to get accounts' });
  }
});

router.get('/connect', authenticateToken, (req, res) => {
  // popup=1 lets the frontend open a small window for OAuth instead of
  // navigating away from the app. The flag rides along in the state token
  // so the OAuth callback (which runs on Google's redirect, not under our
  // direct control) knows whether to render a popup-close HTML response
  // or do the legacy full-page redirect to /app.
  //
  // Note: enforceAccountLimit was removed in PR #13 (no more Free tier).
  // Access is now gated at the server.js route group via requireActiveAccess.
  const isPopup = req.query.popup === '1';
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ALL_SCOPES,
    prompt: 'consent',
    include_granted_scopes: true,
    state: issueOAuthState({ purpose: 'link', userId: req.userId, popup: isPopup }),
  });
  res.redirect(authUrl);
});

// P1.12 — incremental scope upgrade. Initiates an OAuth flow that requests
// the scopes for one feature group (mail|docs|cals) on top of whatever the
// account already has. On success the callback updates encrypted_tokens +
// granted_scopes and redirects back to ?redirect= with ?upgraded=<group>.
//
// This is a browser navigation, not an XHR — the user ends up on Google's
// consent screen. The frontend should `window.location.href = <this url>`.
const FRONTEND_URL_FOR_UPGRADE = process.env.FRONTEND_URL || 'http://localhost:3001';

router.get('/upgrade-scopes/:group', authenticateToken, async (req, res) => {
  try {
    const { group } = req.params;
    const accountId = req.query.account;
    const redirectAfter = req.query.redirect || `${FRONTEND_URL_FOR_UPGRADE}/app`;

    if (!SERVICE_SCOPES[group] || group === 'profile') {
      return res.status(400).json({ error: 'Invalid scope group' });
    }
    if (!accountId) {
      return res.status(400).json({ error: 'account query param required' });
    }

    // Verify the account belongs to the caller before issuing a state
    // token. Anyone could otherwise mint upgrade URLs targeting another
    // user's accountId — single-use state stops the *callback* from
    // succeeding, but blocking it earlier means we never even ask Google.
    const { data: account } = await supabase
      .from('gmail_accounts')
      .select('id')
      .eq('id', accountId)
      .eq('user_id', req.userId)
      .single();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const url = buildUpgradeAuthUrl({
      userId: req.userId,
      accountId,
      group,
      redirectAfter,
    });
    res.redirect(url);
  } catch (err) {
    console.error('Upgrade scopes error:', err);
    res.status(500).json({ error: 'Failed to start scope upgrade' });
  }
});

router.delete('/:accountId', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    // Select the encrypted tokens too so we can revoke the Google grant.
    const { data: account } = await supabase
      .from('gmail_accounts')
      .select('id, encrypted_tokens')
      .eq('id', accountId)
      .eq('user_id', req.userId)
      .single();

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const { count } = await supabase
      .from('gmail_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    if (count <= 1) {
      return res.status(400).json({ error: 'Cannot remove your only account' });
    }

    // Sever access at Google BEFORE deleting the row. Best-effort: a revoke
    // failure (network blip, already-revoked token) must not block removal —
    // we log it and continue so the user's delete always succeeds. Also drop
    // the cached OAuth2 client so a stale client can't be reused post-delete.
    try {
      const tokens = decryptToken(account.encrypted_tokens);
      const result = await revokeGoogleGrant(tokens);
      if (!result.revoked) {
        safeLogError('accounts delete revoke', new Error(result.reason || 'revoke_failed'), { accountId });
      }
    } catch (revokeErr) {
      safeLogError('accounts delete revoke', revokeErr, { accountId });
    }
    invalidateClientCache(accountId, req.userId);

    const { error } = await supabase
      .from('gmail_accounts')
      .delete()
      .eq('id', accountId)
      .eq('user_id', req.userId);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to remove account' });
  }
});

// Get labels for an account
router.get('/:accountId/labels', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    const { data: account } = await supabase
      .from('gmail_accounts')
      .select('id')
      .eq('id', accountId)
      .eq('user_id', req.userId)
      .single();

    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const { data } = await gmail.users.labels.list({ userId: 'me' });
    res.json({ labels: data.labels || [] });
  } catch (err) {
    console.error('Get labels error:', err);
    res.status(500).json({ error: 'Failed to get labels' });
  }
});

// Cache the per-account signature for 24h. Signatures change rarely
// (when a user edits their Gmail signature settings) and refetching
// users.settings.sendAs.list on every compose-open is wasteful.
const _signatureCache = new Map(); // accountId → { signature, expiresAt }
const SIGNATURE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Returns the user's Gmail signature for this account, as HTML. Reads
// users.settings.sendAs.list and picks the entry matching the account's
// own email (the "primary" sendAs is the same email as the connected
// account; aliases would have different emails). If signature is empty
// or unset, returns ''.
//
// gmail.readonly does NOT cover gmail.settings.basic, so this requires
// the account to have granted the broader gmail.modify or
// gmail.settings.basic scope. If the API returns 403 we treat it as
// "no signature available" rather than crashing.
router.get('/:accountId/signature', async (req, res) => {
  try {
    const { accountId } = req.params;

    const cached = _signatureCache.get(accountId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ signature: cached.signature });
    }

    const { data: account } = await supabase
      .from('gmail_accounts')
      .select('id, gmail_email')
      .eq('id', accountId)
      .eq('user_id', req.userId)
      .single();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    let signature = '';
    try {
      const { data } = await gmail.users.settings.sendAs.list({ userId: 'me' });
      const sendAsList = data?.sendAs || [];
      // Prefer the entry matching this account's email; fall back to the
      // first isPrimary entry; fall back to the first entry overall.
      const matchByEmail = sendAsList.find(s => s.sendAsEmail?.toLowerCase() === account.gmail_email?.toLowerCase());
      const primary = sendAsList.find(s => s.isPrimary);
      const chosen = matchByEmail || primary || sendAsList[0];
      signature = chosen?.signature || '';
    } catch (err) {
      // 403 = scope not granted (older grants didn't include settings.basic).
      // Other errors = log + treat as empty signature so the compose flow
      // continues to work.
      if (err?.response?.status !== 403 && err?.code !== 403) {
        console.warn('[signature] sendAs.list failed:', err?.message || err);
      }
      signature = '';
    }

    _signatureCache.set(accountId, { signature, expiresAt: Date.now() + SIGNATURE_CACHE_TTL_MS });
    res.json({ signature });
  } catch (err) {
    console.error('Get signature error:', err);
    res.status(500).json({ error: 'Failed to load signature' });
  }
});

export default router;
