// Recipient parsing / validation / dedup for the composer.
//
// The composer keeps To/Cc/Bcc as comma-separated strings (the historical
// value/onChange contract shared with RecipientAutocomplete and the send/draft
// payloads). This module is the single owner of how those strings are parsed
// into individual recipients, validated, de-duplicated, and how the logged-in
// user's own address is excluded on reply-all. Keeping it pure and separate
// means the chip UI and the reply-all math are tested without mounting the app.

// Shape check. Accepts `user@domain.tld`, `Display Name <user@domain.tld>`,
// and `"Display Name" <user@domain.tld>`. Deliverability is still Gmail's job;
// this only catches the common typo cases before a 400 round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The bare email address inside a token, unwrapping `Name <addr>` if present. */
export function extractEmail(token) {
  const m = String(token || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(token || '')).trim();
}

/** True when a single recipient token contains a syntactically valid address. */
export function isValidAddress(token) {
  return EMAIL_RE.test(extractEmail(token));
}

/** Split a comma-separated recipient string into trimmed, non-empty tokens. */
export function parseRecipients(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Join recipient tokens back into the canonical comma-separated string. */
export function stringifyRecipients(tokens) {
  return (tokens || []).join(', ');
}

/**
 * De-duplicate tokens case-insensitively by their bare address, keeping the
 * first occurrence (which preserves any display name the user typed first).
 */
export function dedupeRecipients(tokens) {
  const seen = new Set();
  const out = [];
  for (const t of tokens || []) {
    const key = extractEmail(t).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Recipient tokens whose address fails the shape check (for pre-send UX). */
export function findInvalidRecipients(value) {
  return parseRecipients(value).filter(t => !isValidAddress(t));
}

/**
 * Remove any tokens whose bare address is in `emails` (compared lowercased).
 * Used for reply-all self-exclusion and cross-field dedup.
 */
export function excludeAddresses(tokens, emails) {
  const excluded = new Set((emails || []).map(e => extractEmail(e).toLowerCase()).filter(Boolean));
  return (tokens || []).filter(t => !excluded.has(extractEmail(t).toLowerCase()));
}

/**
 * Remove from `tokens` any address already present in `others` (lowercased).
 * Cross-field dedup: e.g. drop from Cc anyone already in To.
 */
export function removeDuplicatesOf(tokens, others) {
  return excludeAddresses(tokens, (others || []).map(extractEmail));
}
