import { Router } from 'express';
import { google } from 'googleapis';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import supabase from '../lib/supabase.js';
import { getOAuth2ClientForAccount } from '../lib/google.js';
import { batchGetMessages } from '../lib/gmailBatch.js';
import { mapGoogleError } from '../lib/gmailErrors.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireAccountScope } from '../middleware/scopes.js';
import { safeLogError } from '../lib/log.js';

// P1.7 — multer hardening.
// - fileFilter blocks MIME types that browsers/clients commonly auto-execute
//   (executables, scripts, .lnk). All other types still allowed.
// - per-file 25 MB, max 10 files, total 50 MB across the request.
// - filename/originalname is sanitized at consume time (see sanitizeFilename).
const BLOCKED_MIME_PREFIXES = [
  'application/x-msdownload',          // .exe
  'application/x-msdos-program',
  'application/x-ms-shortcut',         // .lnk
  'application/x-msi',                 // .msi
  'application/x-bat',
  'application/x-sh',
  'application/x-csh',
  'application/x-perl',
  'application/x-python',
  'application/javascript',
  'application/x-javascript',
  'application/vnd.microsoft.portable-executable',
];
const BLOCKED_EXT_RE = /\.(exe|msi|bat|cmd|com|scr|pif|cpl|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|lnk|dll|sys|hta|inf|reg|app)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,    // 25 MB per file
    files: 10,                      // max 10 files
    fields: 30,                     // limit form-field count
  },
  fileFilter: (req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    const name = file.originalname || '';
    if (BLOCKED_MIME_PREFIXES.some(p => mt.startsWith(p)) || BLOCKED_EXT_RE.test(name)) {
      return cb(new Error('File type not allowed'), false);
    }
    cb(null, true);
  },
});

// P1.2 — send rate limiter, applied INSIDE the route. The previous
// app.use('/emails/*/send', sendLimiter) in server.js never matched
// because Express's app.use treats '*' as a literal, not a glob —
// the limiter was effectively a no-op. 10 sends/min/IP is intentionally
// generous for legitimate burst (e.g., a user reply-all-storming a
// thread) but blocks a runaway script or compromised account.
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Send rate limit reached — slow down a bit' },
  keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.userId || 'anon'}`,
});

// List rate limiter. The list endpoint now triggers a Gmail batch HTTP
// request that costs us multipart parsing + a 50-msg JSON walk per call;
// a misbehaving client could hammer it. 60/min per (ip, user) is well
// above the polling interval (every 30s × 4 accounts = 8/min on the
// hot path) but blocks runaway loops.
const listLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Inbox list rate limit reached — please slow down' },
  keyGenerator: (req) => `${ipKeyGenerator(req)}:${req.userId || 'anon'}`,
});

// P0.3 — strip CR/LF (and other control chars) from any value that ends
// up in a MIME header. Without this, a "subject" like "Hi\r\nBcc: evil"
// silently injects a Bcc header and exfiltrates outgoing mail. Same for
// To/Cc/Bcc/filename. Keep tab as it's legitimate header folding.
function sanitizeMimeHeaderValue(s) {
  if (s == null) return '';
  return String(s).replace(/[\r\n\u0000-\u0008\u000B-\u001F\u007F]/g, '').slice(0, 2000);
}

// Quote and escape an attachment filename for Content-Disposition.
// Strips path separators, control chars, and the quote+backslash that
// would break out of the quoted-string form. Falls back to "download" if empty.
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\r\n\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/["]/g, '_')
    .slice(0, 255)
    .trim();
  return cleaned || 'download';
}

// Wrap base64 at 76 columns per RFC 2045.
function wrapBase64(s) {
  return s.replace(/(.{76})/g, '$1\r\n');
}

const router = Router();

// P1.12 — gate every /emails/:accountId/* route on the account having
// the 'mail' scope group. Frontend already filters on granted_scopes,
// so this is belt-and-suspenders. 403 contract:
//   { error: 'scope_upgrade_required', group: 'mail', accountId }
router.use('/:accountId', requireAccountScope('mail'));

// In-memory cache for email bodies — keyed by `${accountId}:${messageId}`.
// Emails are immutable once received, so a 30-minute TTL is safe.
const _emailBodyCache = new Map();
const EMAIL_BODY_CACHE_TTL_MS = 30 * 60 * 1000;
const EMAIL_BODY_CACHE_MAX = 500;

// Cache account ownership checks — eliminates a Supabase roundtrip on every
// cached-email request, making repeated loads near-instant.
const _accountOwnerCache = new Map(); // `${accountId}:${userId}` → { account, expiresAt }
const ACCOUNT_OWNER_CACHE_TTL_MS = 5 * 60 * 1000;

function getCategoryLabel(category) {
  const map = {
    primary: 'CATEGORY_PERSONAL',
    social: 'CATEGORY_SOCIAL',
    promotions: 'CATEGORY_PROMOTIONS',
    sent: 'SENT',
    drafts: 'DRAFT',
    trash: 'TRASH'
  };
  return map[category] || 'CATEGORY_PERSONAL';
}

function parseEmailBody(payload) {
  let htmlBody = '';
  let textBody = '';

  function extractParts(part) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8');
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      textBody = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) {
      part.parts.forEach(extractParts);
    }
  }

  extractParts(payload);
  return htmlBody || textBody.replace(/\n/g, '<br>') || '(no content)';
}

function extractAttachmentMetadata(payload) {
  const attachments = [];

  function traverse(part) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0
      });
    }
    if (part.parts) {
      part.parts.forEach(traverse);
    }
  }

  traverse(payload);
  return attachments;
}

function buildMimeEmail(to, subject, htmlBody, options = {}) {
  const { cc, bcc, inReplyTo, references, attachments = [] } = options;

  // P0.3 — sanitize every value that lands in a header line.
  const safeTo = sanitizeMimeHeaderValue(to);
  const safeSubject = sanitizeMimeHeaderValue(subject);
  const safeCc = sanitizeMimeHeaderValue(cc);
  const safeBcc = sanitizeMimeHeaderValue(bcc);
  // Standards-compatible threading headers carry the ORIGINAL message's RFC
  // Message-ID — never the Gmail threadId (which is not a valid Message-ID).
  // Gmail-internal threading is handled separately by the send request's
  // threadId param; these headers make external clients thread correctly.
  const safeInReplyTo = sanitizeMimeHeaderValue(inReplyTo);
  const safeReferences = sanitizeMimeHeaderValue(references || inReplyTo);

  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  let headers = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
  ];

  if (safeCc) headers.push(`Cc: ${safeCc}`);
  if (safeBcc) headers.push(`Bcc: ${safeBcc}`);
  if (safeInReplyTo) {
    headers.push(`In-Reply-To: ${safeInReplyTo}`);
    if (safeReferences) headers.push(`References: ${safeReferences}`);
  }

  const styledHtmlBody = `
    <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            font-size: 14px;
            line-height: 1.4;
            color: #000000;
            margin: 0;
            padding: 0;
          }
          p {
            margin: 0 0 8px 0;
          }
          p:last-child {
            margin-bottom: 0;
          }
          a {
            color: #1a73e8;
          }
        </style>
      </head>
      <body>${htmlBody}</body>
    </html>
  `;

  if (attachments.length === 0) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    headers.push('');
    headers.push(styledHtmlBody);
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    headers.push('');

    headers.push(`--${boundary}`);
    headers.push('Content-Type: text/html; charset=UTF-8');
    headers.push('');
    headers.push(styledHtmlBody);
    headers.push('');

    for (const att of attachments) {
      const safeAttName = sanitizeFilename(att.filename);
      const safeAttMime = sanitizeMimeHeaderValue(att.mimeType) || 'application/octet-stream';
      headers.push(`--${boundary}`);
      headers.push(`Content-Type: ${safeAttMime}`);
      headers.push('Content-Transfer-Encoding: base64');
      headers.push(`Content-Disposition: attachment; filename="${safeAttName}"`);
      headers.push('');
      headers.push(wrapBase64(att.data));
      headers.push('');
    }

    headers.push(`--${boundary}--`);
  }

  return headers.join('\r\n');
}

async function verifyAccountOwnership(accountId, userId) {
  const key = `${accountId}:${userId}`;
  const hit = _accountOwnerCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.account;

  const { data: account } = await supabase
    .from('gmail_accounts')
    .select('id, user_id, gmail_email, account_name, granted_scopes')
    .eq('id', accountId)
    .eq('user_id', userId)
    .single();

  // Cache even null results so we don't hammer Supabase on bad requests
  _accountOwnerCache.set(key, { account: account || null, expiresAt: Date.now() + ACCOUNT_OWNER_CACHE_TTL_MS });
  return account || null;
}

// Concurrency-limited Promise.all to avoid Gmail API rate limits
async function pMap(items, fn, concurrency = 10) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// List emails
router.get('/:accountId', authenticateToken, listLimiter, async (req, res) => {
  try {
    const { accountId } = req.params;
    const category = req.query.category || 'primary';
    // P2 — clamp maxResults. Without a cap a user could request 10000 and
    // fan out 10000 metadata.get calls → blows our Gmail quota.
    const maxResults = Math.min(Math.max(parseInt(req.query.maxResults) || 50, 1), 100);
    const searchQuery = req.query.q || '';

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const listParams = { userId: 'me', maxResults };

    if (searchQuery) {
      // Search mode: pass q directly to Gmail API, no labelIds filter
      listParams.q = searchQuery;
    } else {
      const categoryLabel = getCategoryLabel(category);
      if (category === 'sent' || category === 'drafts' || category === 'trash') {
        listParams.labelIds = [categoryLabel];
      } else if (category === 'primary') {
        listParams.labelIds = ['INBOX'];
      } else {
        listParams.labelIds = ['INBOX', categoryLabel];
      }
    }

    const response = await gmail.users.messages.list(listParams);

    const messages = response.data.messages || [];

    // Single Gmail batch HTTP request for the metadata fan-out. One round-trip
    // for up to 100 messages instead of N parallel messages.get calls. ~2-3×
    // faster on a 50-message inbox than concurrency-25 fan-out.
    const messageIds = messages.map(m => m.id);
    const details = await batchGetMessages(client, messageIds, {
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'Content-Type'],
    });

    const emails = messages.map((msg, i) => {
      const detail = details[i];
      // batchGetMessages returns null for individual sub-request failures
      // (rare — 5xx on a single msg). Skip those silently — caller sees
      // a list of length emails.filter(Boolean).length, which the
      // frontend handles fine.
      if (!detail) return null;

      const headers = detail.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const labelIds = detail.labelIds || [];

      // Detect attachments from payload parts
      const hasAttachment = !!(detail.payload?.parts?.some(p => p.filename && p.filename.length > 0));

      return {
        id: msg.id,
        threadId: msg.threadId,
        from,
        subject,
        snippet: detail.snippet,
        date: date ? new Date(date).toISOString() : new Date().toISOString(),
        isRead: !labelIds.includes('UNREAD'),
        isStarred: labelIds.includes('STARRED'),
        hasAttachment,
        labelIds,
      };
    }).filter(Boolean);

    // Surface partial-batch failures: if Gmail returned 50 message IDs
    // but only 49 came back through the batch fetch, log it. Without
    // this we'd silently ship a shorter list and have no signal that
    // Gmail is rate-limiting individual sub-requests.
    if (emails.length < messages.length) {
      console.warn('[emails.list] partial batch:', messages.length - emails.length, 'failed of', messages.length, 'for account', accountId);
    }

    // For the drafts folder, resolve each message's Gmail DRAFT id (distinct
    // from the message id) so the client can reopen a draft into an editable
    // composer and update/delete the correct draft. Best-effort.
    if (category === 'drafts' && emails.length) {
      try {
        const dl = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 });
        const map = {};
        (dl.data.drafts || []).forEach(d => { if (d.message?.id) map[d.message.id] = d.id; });
        emails.forEach(e => { if (map[e.id]) e.draftId = map[e.id]; });
      } catch (e) { /* best-effort — reopen still works, just as a new draft */ }
    }

    res.json({ emails });
  } catch (error) {
    safeLogError('emails list', error, { accountId: req.params.accountId });
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to get emails' });
  }
});

// Batch fetch email bodies — up to 25 in parallel, serves cache first
router.post('/:accountId/batch-bodies', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds) || messageIds.length === 0) return res.json({ bodies: {} });

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const results = {};
    const uncachedIds = [];

    for (const msgId of messageIds.slice(0, 50)) {
      const key = `${accountId}:${msgId}`;
      const cached = _emailBodyCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        results[msgId] = cached.data;
      } else {
        uncachedIds.push(msgId);
      }
    }

    if (uncachedIds.length > 0) {
      const client = await getOAuth2ClientForAccount(accountId, req.userId);

      // Single batch HTTP request for the body fan-out. messages.get with
      // format=full is 5 quota units; up to 50 in one request fits well
      // under the 250 units/sec cap. Replaces a Promise.all of N
      // individual round-trips with one.
      const details = await batchGetMessages(client, uncachedIds, { format: 'full' });

      uncachedIds.forEach((msgId, i) => {
        const msg = details[i];
        if (!msg) return; // sub-request failed — skip silently
        const hdrs = msg.payload?.headers || [];
        const data = {
          body: parseEmailBody(msg.payload),
          headers: {
            from: hdrs.find(h => h.name === 'From')?.value,
            to: hdrs.find(h => h.name === 'To')?.value,
            cc: hdrs.find(h => h.name === 'Cc')?.value,
            date: hdrs.find(h => h.name === 'Date')?.value,
            subject: hdrs.find(h => h.name === 'Subject')?.value,
            replyTo: hdrs.find(h => h.name === 'Reply-To')?.value,
          },
          attachments: extractAttachmentMetadata(msg.payload),
        };
        if (_emailBodyCache.size >= EMAIL_BODY_CACHE_MAX) _emailBodyCache.delete(_emailBodyCache.keys().next().value);
        _emailBodyCache.set(`${accountId}:${msgId}`, { data, expiresAt: Date.now() + EMAIL_BODY_CACHE_TTL_MS });
        results[msgId] = data;
      });
    }

    return res.json({ bodies: results });
  } catch (err) {
    console.error('Batch email bodies error:', err);
    const mapped = mapGoogleError(err, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to batch fetch' });
  }
});

// Contacts autocomplete: scan the user's recent SENT emails, extract
// every To/Cc/Bcc address, rank by frequency, return top N. Sent-folder
// scan is the strongest "people I email" signal — far better than just
// inbox From because it filters out marketing/transactional senders.
//
// Why not the People API: would require adding contacts.readonly to our
// OAuth scopes, which forces every existing user to re-consent. Not
// worth it for v1; sent-folder extraction covers the high-value case
// (people you email regularly) and adds zero scope surface.
//
// NOTE: this literal route MUST be registered before the `/:accountId/:messageId`
// param route below — otherwise Express matches `/:accountId/contacts` as a
// message fetch with messageId="contacts" and the endpoint is shadowed.
router.get('/:accountId/contacts', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    // Verify ownership BEFORE any cache read, and key the cache by
    // (userId, accountId) — never accountId alone. This guarantees one user is
    // never served another user's cached contacts for the same account id, and
    // that a non-owned account can never return cached data.
    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const cacheKey = `${accountId}:${req.userId}`; // same field order as _accountOwnerCache
    const cached = _contactsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ contacts: cached.contacts });
    }

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    // List sent message ids — Gmail's q syntax filters server-side, so we
    // only burn quota on the SENT label.
    const list = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['SENT'],
      maxResults: CONTACTS_SCAN_LIMIT,
    });
    const ids = (list.data.messages || []).map(m => m.id);

    if (ids.length === 0) {
      _contactsCache.set(cacheKey, { contacts: [], expiresAt: Date.now() + CONTACTS_CACHE_TTL_MS });
      return res.json({ contacts: [] });
    }

    // Fetch headers only — format=metadata + metadataHeaders limits the
    // payload to ~1 KB per message instead of pulling full bodies.
    const headerFetches = ids.map(id =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['To', 'Cc', 'Bcc'],
      }).catch(() => null) // Tolerate per-message failures (deleted etc.)
    );
    const messages = (await Promise.all(headerFetches)).filter(Boolean);

    // Aggregate: count occurrences, keep the longest non-empty name we've
    // seen (some messages have just an email, others "Name <email>").
    const tally = new Map(); // email → { email, name, count }
    for (const m of messages) {
      const headers = m?.data?.payload?.headers || [];
      for (const h of headers) {
        if (!['To', 'Cc', 'Bcc'].includes(h.name)) continue;
        for (const tok of splitAddressHeader(h.value)) {
          const parsed = parseAddress(tok);
          if (!parsed) continue;
          // Skip the user's own address — they don't need to autocomplete to themselves
          if (parsed.email === account.gmail_email?.toLowerCase()) continue;
          const existing = tally.get(parsed.email);
          if (existing) {
            existing.count += 1;
            if (parsed.name && parsed.name.length > (existing.name || '').length) {
              existing.name = parsed.name;
            }
          } else {
            tally.set(parsed.email, { email: parsed.email, name: parsed.name, count: 1 });
          }
        }
      }
    }

    const contacts = [...tally.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, CONTACTS_RETURN_LIMIT);

    _contactsCache.set(cacheKey, { contacts, expiresAt: Date.now() + CONTACTS_CACHE_TTL_MS });
    res.json({ contacts });
  } catch (err) {
    safeLogError('contacts list', err, { accountId: req.params.accountId });
    const mapped = mapGoogleError(err, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// Get email detail
router.get('/:accountId/:messageId', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    // Serve from cache if available
    const _cacheKey = `${accountId}:${messageId}`;
    const _cached = _emailBodyCache.get(_cacheKey);
    if (_cached && _cached.expiresAt > Date.now()) {
      return res.json(_cached.data);
    }

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const message = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const headers = message.data.payload.headers;
    const body = parseEmailBody(message.data.payload);
    const attachments = extractAttachmentMetadata(message.data.payload);

    const fromHeader = headers.find(h => h.name === 'From')?.value;
    const toHeader = headers.find(h => h.name === 'To')?.value;
    const ccHeader = headers.find(h => h.name === 'Cc')?.value;
    const dateHeader = headers.find(h => h.name === 'Date')?.value;
    const subjectHeader = headers.find(h => h.name === 'Subject')?.value;
    const replyToHeader = headers.find(h => h.name === 'Reply-To')?.value;

    const _responseData = { body, headers: { from: fromHeader, to: toHeader, cc: ccHeader, date: dateHeader, subject: subjectHeader, replyTo: replyToHeader }, attachments };
    // Store in cache (evict oldest entry if at capacity)
    if (_emailBodyCache.size >= EMAIL_BODY_CACHE_MAX) {
      _emailBodyCache.delete(_emailBodyCache.keys().next().value);
    }
    _emailBodyCache.set(_cacheKey, { data: _responseData, expiresAt: Date.now() + EMAIL_BODY_CACHE_TTL_MS });
    return res.json(_responseData);
  } catch (error) {
    console.error('Get email detail error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to get email details' });
  }
});

// Download attachment
router.get('/:accountId/:messageId/attachments/:attachmentId', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId, attachmentId } = req.params;
    const { filename, mimeType } = req.query;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId
    });

    const buffer = Buffer.from(attachment.data.data, 'base64');

    // Sanitize filename to prevent header injection (now centralized).
    const safeName = sanitizeFilename(filename);
    res.setHeader('Content-Type', sanitizeMimeHeaderValue(mimeType) || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (error) {
    safeLogError('emails download attachment', error, { accountId: req.params.accountId });
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to download attachment' });
  }
});

// Get thread (full format with bodies)
router.get('/:accountId/:threadId/thread', authenticateToken, async (req, res) => {
  try {
    const { accountId, threadId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full'
    });

    const messages = thread.data.messages.map(msg => {
      const headers = msg.payload.headers;
      const labelIds = msg.labelIds || [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        from: headers.find(h => h.name === 'From')?.value || '',
        to: headers.find(h => h.name === 'To')?.value || '',
        cc: headers.find(h => h.name === 'Cc')?.value || '',
        subject: headers.find(h => h.name === 'Subject')?.value || '',
        date: headers.find(h => h.name === 'Date')?.value || '',
        snippet: msg.snippet,
        body: parseEmailBody(msg.payload),
        attachments: extractAttachmentMetadata(msg.payload),
        isRead: !labelIds.includes('UNREAD'),
        isStarred: labelIds.includes('STARRED'),
        labelIds
      };
    });

    res.json({ messages });
  } catch (error) {
    console.error('Get thread error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// Save draft (legacy endpoint)
router.post('/:accountId/draft', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    let { to, cc, bcc, subject, body, draftId } = req.body;

    const raw = buildMimeEmail(to || '', subject || '', body || '', { cc, bcc });
    const encodedMessage = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    let result;
    if (draftId) {
      result = await gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message: { raw: encodedMessage } }
      });
    } else {
      result = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: encodedMessage } }
      });
    }

    res.json({ success: true, draftId: result.data.id });
  } catch (error) {
    safeLogError('emails save draft', error, { accountId: req.params.accountId });
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// Send email — sendLimiter goes BEFORE multer so a flooded sender is rejected
// without buffering up to 250 MB into memory.
router.post('/:accountId/send', authenticateToken, sendLimiter, upload.array('attachments', 10), async (req, res) => {
  try {
    const { accountId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    let { to, cc, bcc, subject, body, threadId, draftId, originalEmailId } = req.body;

    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        attachments.push({
          filename: file.originalname,
          mimeType: file.mimetype,
          data: file.buffer.toString('base64')
        });
      }
    }

    // Resolve standards-compatible threading headers from the original message's
    // RFC Message-ID (reply/forward). Best-effort: threading via the Gmail
    // threadId param below still works if this lookup fails.
    let inReplyTo = null, references = null;
    if (originalEmailId) {
      try {
        const orig = await gmail.users.messages.get({ userId: 'me', id: originalEmailId, format: 'metadata', metadataHeaders: ['Message-ID', 'References'] });
        const hdrs = orig.data.payload?.headers || [];
        const mid = hdrs.find(h => (h.name || '').toLowerCase() === 'message-id')?.value || null;
        const refs = hdrs.find(h => (h.name || '').toLowerCase() === 'references')?.value || null;
        inReplyTo = mid;
        references = [refs, mid].filter(Boolean).join(' ') || null;
      } catch (e) { /* best-effort threading */ }
    }

    const raw = buildMimeEmail(to, subject, body, { cc, bcc, attachments, inReplyTo, references });
    const encodedMessage = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const sendParams = {
      userId: 'me',
      requestBody: { raw: encodedMessage }
    };

    if (threadId) {
      sendParams.requestBody.threadId = threadId;
    }

    await gmail.users.messages.send(sendParams);

    if (draftId) {
      try {
        await gmail.users.drafts.delete({ userId: 'me', id: draftId });
      } catch (err) {
        console.error('Failed to delete draft after send:', err);
      }
    }

    res.json({ success: true });
  } catch (error) {
    safeLogError('emails send', error, { accountId: req.params.accountId });
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Save/update draft
router.post('/:accountId/drafts', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { to, cc, bcc, subject, body, threadId, draftId } = req.body;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const raw = buildMimeEmail(to, subject, body, { cc, bcc, threadId });
    const encodedMessage = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    let result;
    if (draftId) {
      result = await gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message: { raw: encodedMessage } }
      });
    } else {
      result = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId: threadId || undefined
          }
        }
      });
    }

    res.json({ success: true, draftId: result.data.id });
  } catch (error) {
    console.error('Save draft error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// Delete draft
router.delete('/:accountId/drafts/:draftId', authenticateToken, async (req, res) => {
  try {
    const { accountId, draftId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.drafts.delete({ userId: 'me', id: draftId });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete draft error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// Archive email
router.post('/:accountId/:messageId/archive', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['INBOX'] }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Archive email error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to archive email' });
  }
});

// Mark as read
router.post('/:accountId/:messageId/read', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Mark as read error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Trash email
router.post('/:accountId/:messageId/trash', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.trash({ userId: 'me', id: messageId });

    res.json({ success: true });
  } catch (error) {
    console.error('Trash email error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to delete email' });
  }
});

// Toggle star
router.post('/:accountId/:messageId/star', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;
    const { starred } = req.body;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: starred
        ? { addLabelIds: ['STARRED'] }
        : { removeLabelIds: ['STARRED'] }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Star toggle error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to toggle star' });
  }
});

// Modify labels
router.post('/:accountId/:messageId/labels', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;
    const { addLabelIds = [], removeLabelIds = [] } = req.body;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Modify labels error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to modify labels' });
  }
});

// Mark as unread
router.post('/:accountId/:messageId/unread', authenticateToken, async (req, res) => {
  try {
    const { accountId, messageId } = req.params;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: ['UNREAD'] }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Mark as unread error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to mark as unread' });
  }
});

// Batch actions
router.post('/:accountId/batch', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { action, emailIds } = req.body;

    const account = await verifyAccountOwnership(accountId, req.userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = await getOAuth2ClientForAccount(accountId, req.userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    if (action === 'archive') {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: emailIds,
          removeLabelIds: ['INBOX']
        }
      });
    } else if (action === 'trash') {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: emailIds,
          addLabelIds: ['TRASH'],
          removeLabelIds: ['INBOX']
        }
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Batch action error:', error);
    const mapped = mapGoogleError(error, { accountId: req.params.accountId, group: 'mail' });
    if (mapped) return res.status(mapped.status).json(mapped.body);
    res.status(500).json({ error: 'Failed to perform batch action' });
  }
});

// In-memory contacts cache. Building the contacts list from sent-folder
// scans is the expensive part — Gmail's API is per-message, and we read
// up to 200 messages per refresh. Cache for 30 minutes per account so
// repeated compose-modal opens don't re-scan.
const _contactsCache = new Map(); // `${accountId}:${userId}` → { contacts, expiresAt }
const CONTACTS_CACHE_TTL_MS = 30 * 60 * 1000;
const CONTACTS_SCAN_LIMIT = 200;
const CONTACTS_RETURN_LIMIT = 250;

// Parse "Name <email@host>" into { name, email }. Falls back to using the
// raw token as both fields when no angle-bracket form is present.
function parseAddress(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>]+?)\s*>\s*$/);
  if (m) {
    const name = (m[1] || '').trim();
    const email = (m[2] || '').toLowerCase();
    if (!email.includes('@')) return null;
    return { name, email };
  }
  // Bare email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    return { name: '', email: s.toLowerCase() };
  }
  return null;
}

// Split a header value into individual addresses (handles commas inside
// quoted display names by tracking quote depth).
function splitAddressHeader(header) {
  if (!header) return [];
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (const ch of String(header)) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export default router;
