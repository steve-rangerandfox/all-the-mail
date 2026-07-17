// Canonical composer-session initializer.
//
// Every entry into the composer — new message, reply, reply-all, forward, or a
// reopened draft — must deliberately (re)initialize the FULL set of composer
// fields. Historically App.js set these ad hoc and forgot `composeDraftId`,
// which leaked a previous session's draft id into the next composition (a
// cross-account hazard). This module is the single source of truth for the
// shape of a composer session and for how each mode derives its recipients,
// subject, quoted content, and body, so the reset is total and testable.
//
// It is intentionally pure: no React, no network. Callers pass the already-
// loaded full original body (from the reader path) and headers; this module
// never fetches. That keeps "a composer that needs source content must not
// appear ready with an empty quote" enforceable by the caller (await the body,
// then build the session).

import { stripName, getEmailOnly, ensurePrefix, splitList, uniqLower, sanitizeDocHtml } from './helpers';
import { dedupeRecipients, excludeAddresses, stringifyRecipients } from './recipients';

// HTML-escape a plain-text value bound for an HTML context. External email
// header fields (sender, subject, recipients, date) are attacker-controllable,
// so they must be literal text in the quoted block — never live markup.
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decide which Gmail draft id a reopened draft should use.
 *   - the row's own draftId (list enrichment) wins;
 *   - otherwise a server-resolved id;
 *   - if neither is known, block (do NOT reopen as a new draft — that would
 *     orphan/duplicate the original provider draft).
 * @returns {{ draftId: string|null, block: boolean }}
 */
export function chooseReopenDraftId(rowDraftId, resolvedDraftId) {
  const draftId = rowDraftId || resolvedDraftId || null;
  return { draftId, block: !draftId };
}

/** A fully-blank composer session — the canonical empty shape. */
export function blankComposerSession() {
  return {
    mode: 'compose',
    originalEmail: null,
    fromAccountId: '',
    draftId: null,
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
    baselineBody: '',
    showCcBcc: false,
    // Original recipients captured so a deliberate From switch can recompute
    // reply-all self-exclusion against the newly-selected sending address.
    replyContext: null,
  };
}

/** Strip HTML to visible text for "did the user actually write anything" checks. */
export function htmlToText(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/​/g, '')
    .trim();
}

/**
 * True when a composer holds work worth preserving before it is replaced.
 * Any recipient, subject, or attachment counts; body counts only if the user
 * changed it from the initial template (signature/quote) it was opened with.
 */
export function composerHasContent(fields = {}) {
  const { to, cc, bcc, subject, body = '', baselineBody = '', attachments = [] } = fields;
  if ([to, cc, bcc, subject].some(v => (v || '').trim())) return true;
  if (attachments && attachments.length > 0) return true;
  return htmlToText(body) !== htmlToText(baselineBody);
}

/**
 * Reply/reply-all/forward recipient computation.
 *   reply     → To = original sender; Cc/Bcc empty.
 *   replyAll  → To = original sender; Cc = other To+Cc recipients; self excluded.
 *   forward   → all empty (must not retain original recipients).
 */
export function computeRecipients({ mode, oFrom = '', oTo = '', oCc = '', selfEmail = '' }) {
  if (mode === 'forward') return { to: '', cc: '', bcc: '' };

  const senderToken = getEmailOnly(oFrom);
  if (mode === 'reply') {
    return { to: senderToken, cc: '', bcc: '' };
  }

  // reply-all
  const self = (selfEmail || '').toLowerCase();
  const toTokens = excludeAddresses(uniqLower(splitList(senderToken)), self ? [self] : []);
  const ccTokens = excludeAddresses(
    uniqLower([...splitList(oTo), ...splitList(oCc)]),
    [self, ...toTokens.map(getEmailOnly)].filter(Boolean)
  );
  const to = (toTokens[0] || senderToken).trim();
  const cc = stringifyRecipients(dedupeRecipients(ccTokens));
  return { to, cc, bcc: '' };
}

/**
 * Build the quoted-content HTML that trails the user's message.
 *   reply/reply-all → attribution line + <blockquote> of the FULL original body.
 *   forward         → "Forwarded message" header block + FULL original body.
 * Visually secondary (muted, left border) and fully present in the editor so
 * what the user sees is exactly what will send.
 */
export function buildQuotedHtml({ mode, headers = {}, email = {}, fullBodyHtml = '' }) {
  const fromRaw = headers.from || email.from || '';
  const fromName = escapeHtml(stripName(fromRaw));
  const fromEmail = escapeHtml(getEmailOnly(fromRaw));
  const dateStr = escapeHtml(headers.date || (email.date ? new Date(email.date).toLocaleString() : ''));
  // Security boundary (invariant): the original body is external HTML — run it
  // through the repository's canonical editable-HTML sanitizer BEFORE it ever
  // reaches the composer/editor, and escape every header field as literal text.
  // No parallel sanitizer: sanitizeDocHtml (utils/helpers) is the owner.
  const bodyHtml = fullBodyHtml
    ? sanitizeDocHtml(fullBodyHtml)
    : (email.snippet ? `<p>${escapeHtml(email.snippet)}</p>` : '');

  if (mode === 'forward') {
    const lines = [
      '---------- Forwarded message ----------',
      `From: ${fromName} &lt;${fromEmail}&gt;`,
      `Date: ${dateStr}`,
      `Subject: ${escapeHtml(headers.subject || email.subject || '')}`,
      `To: ${escapeHtml(headers.to || '')}`,
    ];
    if (headers.cc) lines.push(`Cc: ${escapeHtml(headers.cc)}`);
    return `<br><br><div class="atm-quote gmail_quote">${lines.join('<br>')}<br><br>${bodyHtml}</div>`;
  }

  const attribution = dateStr
    ? `On ${dateStr}, ${fromName} &lt;${fromEmail}&gt; wrote:`
    : `${fromName} wrote:`;
  return (
    `<br><br><div class="atm-quote gmail_quote">${attribution}` +
    `<blockquote class="atm-quote-block gmail_quote" ` +
    `style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555;">` +
    `${bodyHtml}</blockquote></div>`
  );
}

/**
 * Assemble a complete composer session for a given mode.
 *
 * @param {string} mode 'compose' | 'reply' | 'replyAll' | 'forward'
 * @param {object|null} email source message (null for a fresh compose)
 * @param {string} fromAccountId the deliberately-chosen sending account
 * @param {object} headers original message headers (from/to/cc/subject/date)
 * @param {string} fullBodyHtml the FULL original body (from the reader path)
 * @param {string} selfEmail the sending account's own address (for exclusion)
 * @param {string} signatureHtml optional signature to prepend
 * @param {boolean} includeSignature whether the signature should be inserted
 */
export function buildComposerSession({
  mode = 'compose',
  email = null,
  fromAccountId = '',
  headers = {},
  fullBodyHtml = '',
  selfEmail = '',
  signatureHtml = '',
  includeSignature = false,
} = {}) {
  const session = blankComposerSession();
  session.mode = mode;
  session.originalEmail = email;
  session.fromAccountId = fromAccountId;

  const oFrom = headers.replyTo || headers.from || email?.from || '';
  const oTo = headers.to || '';
  const oCc = headers.cc || '';
  const oSubject = headers.subject || email?.subject || '';

  let quoted = '';
  if (mode !== 'compose' && email) {
    const rcpts = computeRecipients({ mode, oFrom, oTo, oCc, selfEmail });
    session.to = rcpts.to;
    session.cc = rcpts.cc;
    session.bcc = rcpts.bcc;
    session.subject = ensurePrefix(oSubject, mode === 'forward' ? 'Fwd:' : 'Re:');
    session.showCcBcc = !!(rcpts.cc || rcpts.bcc);
    quoted = buildQuotedHtml({ mode, headers, email, fullBodyHtml });
    // Keep the original recipient sets so a From switch can recompute exclusion.
    session.replyContext = { oFrom, oTo, oCc };
  }

  const sig = includeSignature && signatureHtml ? `<br><br>${signatureHtml}` : '';
  session.body = mode === 'compose' ? sig : `${sig}${quoted}`;
  session.baselineBody = session.body;
  return session;
}

/**
 * Recompute reply-all self-exclusion after a deliberate From-account switch.
 * No-op unless we have the captured original recipient context (reply-all).
 * Returns the new { to, cc }.
 */
export function recomputeForFrom(session, newSelfEmail) {
  if (!session?.replyContext || session.mode !== 'replyAll') {
    return { to: session?.to || '', cc: session?.cc || '' };
  }
  const { oFrom, oTo, oCc } = session.replyContext;
  const { to, cc } = computeRecipients({ mode: 'replyAll', oFrom, oTo, oCc, selfEmail: newSelfEmail });
  return { to, cc };
}
