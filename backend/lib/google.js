import { google } from 'googleapis';
import crypto from 'crypto';
import supabase from './supabase.js';
import { issueOAuthState } from './security.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const SERVICE_SCOPES = {
  mail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  docs: [
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  cals: [
    // P2 — narrowed from 'calendar' (full r/w on all calendars incl. ACL
    // and calendar settings) to 'calendar.events' (CRUD on events only).
    // Fewer blast-radius on token theft; easier Google CASA review.
    'https://www.googleapis.com/auth/calendar.events',
  ],
  profile: [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
};

const ALL_SCOPES = Object.values(SERVICE_SCOPES).flat();

// P1.12 — minimum scopes for first login. Profile/email only (non-sensitive)
// so the sign-in flow is verification-free and never trips Google's
// "unverified app" warning, and the Cloud project's lifetime 100-OAuth-user
// cap doesn't apply to sign-in.
//
// All Gmail/Drive/Calendar scopes are requested incrementally via
// /accounts/upgrade-scopes/:group when the user activates that feature
// (Variant B from the P1.12 handoff). Those upgrade flows DO show the
// unverified warning until per-scope verification clears, but they fire
// in the right context — the user is connecting an integration — and
// don't gate basic sign-up.
const MINIMUM_SCOPES = [
  ...SERVICE_SCOPES.profile,
];

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// P1.12 / two-project split: a SECOND Cloud project (all-the-mail-signin)
// holds an OAuth client that requests only profile + email at runtime and
// declares no sensitive/restricted scopes on its consent screen. Because
// no sensitive scopes are involved, that project doesn't trigger Google's
// "Google hasn't verified this app" warning at sign-in. Account linking
// and per-feature scope upgrades continue to flow through the existing
// (full-scope) project — those still show the warning until verification
// clears, but they fire in the right context (user explicitly clicking
// "Connect Gmail").
//
// Same redirect URI is intentional — the callback handler branches on
// state.flow to decide which client to use for the token exchange.
const GOOGLE_SIGNIN_CLIENT_ID = process.env.GOOGLE_SIGNIN_CLIENT_ID;
const GOOGLE_SIGNIN_CLIENT_SECRET = process.env.GOOGLE_SIGNIN_CLIENT_SECRET;

const signinOAuth2Client = new google.auth.OAuth2(
  GOOGLE_SIGNIN_CLIENT_ID || GOOGLE_CLIENT_ID,
  GOOGLE_SIGNIN_CLIENT_SECRET || GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

if (!GOOGLE_SIGNIN_CLIENT_ID || !GOOGLE_SIGNIN_CLIENT_SECRET) {
  // Falls back to the main client. Sign-in still works but the warning
  // returns. Configure the env vars on Render for the warning-free path.
  console.warn('[google] GOOGLE_SIGNIN_CLIENT_ID/SECRET not set — sign-in will fall back to the main OAuth client and show the unverified-app warning.');
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// P2 — fail closed in production. A missing ENCRYPTION_KEY in prod means
// OAuth tokens are stored as plain base64 (reversible with zero effort)
// which is functionally plaintext. Refuse to boot rather than silently
// accept the downgrade. In dev we keep the base64 fallback + warning so
// local loops don't require key setup.
if (!ENCRYPTION_KEY && process.env.NODE_ENV === 'production') {
  console.error('FATAL: ENCRYPTION_KEY is required in production');
  process.exit(1);
}

function encryptToken(token) {
  if (!ENCRYPTION_KEY) {
    // Dev-only fallback (prod is gated by the check above).
    console.warn('[SECURITY] No ENCRYPTION_KEY set — tokens stored as base64 only');
    return Buffer.from(JSON.stringify(token)).toString('base64');
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(JSON.stringify(token), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptToken(encrypted) {
  if (!ENCRYPTION_KEY || !encrypted.includes(':')) {
    // Legacy base64 fallback
    return JSON.parse(Buffer.from(encrypted, 'base64').toString());
  }
  const [ivHex, authTagHex, encryptedData] = encrypted.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// In-memory OAuth2 client cache — eliminates a Supabase roundtrip on every request.
// TTL: 50 min (tokens expire at 60 min; refresh extends automatically via the 'tokens' event).
const _clientCache = new Map(); // accountId → { client, expiresAt }
const CLIENT_CACHE_TTL_MS = 50 * 60 * 1000;

// Drop the cached OAuth2 client for an account. Cache keys are
// `${accountId}:${userId}` (see getOAuth2ClientForAccount), so deleting a
// bare accountId — as this previously did — never matched and the cache
// leaked a live client for up to CLIENT_CACHE_TTL_MS after removal. When
// userId is known we delete the exact key; otherwise we sweep every entry
// for that account (belt-and-suspenders for callers without a userId).
function invalidateClientCache(accountId, userId) {
  if (userId) {
    _clientCache.delete(`${accountId}:${userId}`);
    return;
  }
  const prefix = `${accountId}:`;
  for (const key of _clientCache.keys()) {
    if (key.startsWith(prefix)) _clientCache.delete(key);
  }
}

// Revoke a Google OAuth grant at Google's revocation endpoint. Removing an
// account must actually sever our access, not just delete the local row —
// otherwise we keep a live refresh token after the user believes access is
// gone (a privacy-page contradiction and a Google CASA-review blocker).
// Revoking the refresh_token invalidates the entire grant. Best-effort by
// design: a failure here must never block account deletion, so callers
// should not await-throw on it.
async function revokeGoogleGrant(tokens) {
  const token = tokens?.refresh_token || tokens?.access_token;
  if (!token) return { revoked: false, reason: 'no_token' };
  try {
    const client = newOAuth2Client();
    await client.revokeToken(token);
    return { revoked: true };
  } catch (err) {
    return { revoked: false, reason: err?.message || 'revoke_failed' };
  }
}

// P1.8 — userId is REQUIRED. Every caller must pass it; the function refuses
// to load a client for an account that does not belong to the authenticated
// user. This turns a previously per-route-honor-system check into an
// invariant the lib enforces — a future route that forgets to call
// verifyAccountOwnership() now fails closed instead of leaking access.
async function getOAuth2ClientForAccount(accountId, userId) {
  if (!userId) {
    throw new Error('getOAuth2ClientForAccount: userId is required');
  }
  const cacheKey = `${accountId}:${userId}`;
  const cached = _clientCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client;
  }

  const { data: account, error } = await supabase
    .from('gmail_accounts')
    .select('*')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single();

  if (error || !account) throw new Error('Account not found');

  const tokens = decryptToken(account.encrypted_tokens);
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);

  client.on('tokens', async (newTokens) => {
    if (newTokens.refresh_token) {
      tokens.refresh_token = newTokens.refresh_token;
    }
    tokens.access_token = newTokens.access_token;
    tokens.expiry_date = newTokens.expiry_date;
    // Extend cache TTL on refresh
    _clientCache.set(cacheKey, { client, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });
    await supabase
      .from('gmail_accounts')
      .update({ encrypted_tokens: encryptToken(tokens) })
      .eq('id', accountId);
  });

  _clientCache.set(cacheKey, { client, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS });
  return client;
}

// P1.9 — fresh OAuth2 client per OAuth callback. The exported `oauth2Client`
// is a singleton; `setCredentials` mutates it. Two concurrent callbacks
// could read the wrong user's tokens. Use this for the callback path.
function newOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// Same isolation pattern but for the sign-in client. The callback decides
// which factory to call based on state.purpose === 'signin'. Falls back to
// the main client's credentials if the sign-in env vars aren't configured
// so a misconfigured deploy still authenticates (just shows the warning).
function newSigninOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_SIGNIN_CLIENT_ID || GOOGLE_CLIENT_ID,
    GOOGLE_SIGNIN_CLIENT_SECRET || GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// P1.12 — incremental scope upgrade. Builds an OAuth URL that requests
// just the scopes for one feature group (mail/docs/cals). The state token
// is the existing single-use random token from security.js (NOT a JWT) so
// the upgrade flow piggybacks on the same callback handler.
//
// include_granted_scopes:true means Google returns a token whose `scope`
// field carries every scope the user has ever granted to this client +
// the new ones — so we don't accidentally drop access to previously
// granted features when a user upgrades a single group.
function buildUpgradeAuthUrl({ userId, accountId, group, redirectAfter }) {
  const scopes = SERVICE_SCOPES[group];
  if (!scopes || group === 'profile') {
    throw new Error(`Unknown or non-upgradable scope group: ${group}`);
  }
  const state = issueOAuthState({
    purpose: 'scope_upgrade',
    userId,
    accountId,
    group,
    redirectAfter,
  });
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...SERVICE_SCOPES.profile, ...scopes],
    state,
  });
}

// P1.12 — short-label capability check. The gmail_accounts.granted_scopes
// column stores short tags ('mail' | 'docs' | 'cals') — derived in the
// callback from the URL scopes Google grants. Frontend already filters
// account lists with the same .includes() shape (App.js:728-729).
async function accountHasGroup(accountId, userId, group) {
  if (!['mail', 'docs', 'cals'].includes(group)) {
    throw new Error(`Unknown group: ${group}`);
  }
  const { data, error } = await supabase
    .from('gmail_accounts')
    .select('granted_scopes')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single();
  if (error || !data) return false;
  return Array.isArray(data.granted_scopes) && data.granted_scopes.includes(group);
}

export {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  SERVICE_SCOPES,
  ALL_SCOPES,
  MINIMUM_SCOPES,
  oauth2Client,
  signinOAuth2Client,
  newOAuth2Client,
  newSigninOAuth2Client,
  encryptToken,
  decryptToken,
  getOAuth2ClientForAccount,
  invalidateClientCache,
  revokeGoogleGrant,
  buildUpgradeAuthUrl,
  accountHasGroup,
};
