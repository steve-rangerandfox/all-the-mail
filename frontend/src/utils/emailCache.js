// Persistent email-body cache backed by IndexedDB. Survives page reload,
// so re-opening an email you've seen before is ~instant instead of a
// network round-trip. Falls back to in-memory only if IndexedDB is
// unavailable (private browsing, old Safari, etc.) — never throws.
//
// Shape: key = `${accountId}:${messageId}` → { body, headers, attachments, ts }
// The composite key is the canonical mail identity (see utils/mailIdentity).
// TTL: 7 days. We rely on backend Gmail truth to refresh stale bodies.
//
// Stale-while-revalidate is enforced by the caller — it should call get()
// to render immediately, then trigger the network fetch and call set()
// when fresh data arrives.

import { mailKey } from './mailIdentity';

const DB_NAME = 'atm_email_cache';
const DB_VERSION = 2; // bump: added 'lists' store
const STORE = 'bodies';
const LISTS_STORE = 'lists';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Lists go stale faster than bodies. 5 min is the SWR refresh window —
// after that the cached list is still painted instantly, but the
// background refresh is more critical. Bodies are immutable so 7-day
// works for them.
const LIST_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 2000;
// In-memory fallback caps. Without these, a long-lived tab in private
// browsing (where IDB is unavailable) accumulates body strings until the
// renderer OOMs. Bodies dominate (~30KB each); lists are cheap. Cap each
// independently so a deluge in one doesn't push the other out.
const MAX_MEM_BODIES = 500;
const MAX_MEM_LISTS = 100;

let _dbPromise = null;
let _idbAvailable = typeof indexedDB !== 'undefined';
const _memFallback = new Map();

// Insertion-ordered LRU eviction. Map iteration order is insertion
// order; oldest key is the first one yielded by .keys().
function _capMap(map, max) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function openDb() {
  if (!_idbAvailable) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('ts', 'ts', { unique: false });
        }
        // v2 — list cache for SWR rendering of mail lists.
        if (!db.objectStoreNames.contains(LISTS_STORE)) {
          const lstore = db.createObjectStore(LISTS_STORE, { keyPath: 'key' });
          lstore.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _idbAvailable = false; resolve(null); };
    } catch {
      _idbAvailable = false;
      resolve(null);
    }
  });
  return _dbPromise;
}

// Canonical composite key (imported so the persisted IndexedDB key stays in
// lockstep with the rest of the app's mail identity).
const makeKey = mailKey;

export async function getCached(accountId, messageId) {
  const key = makeKey(accountId, messageId);
  if (_memFallback.has(key)) {
    const entry = _memFallback.get(key);
    if (Date.now() - entry.ts < TTL_MS) return entry;
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v || Date.now() - v.ts >= TTL_MS) return resolve(null);
        resolve(v);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function setCached(accountId, messageId, body, headers, attachments) {
  if (!body) return;
  const key = makeKey(accountId, messageId);
  const entry = { key, accountId, messageId, body, headers: headers || null, attachments: attachments || [], ts: Date.now() };
  // Re-insert to bump LRU position even if already present
  _memFallback.delete(key);
  _memFallback.set(key, entry);
  _capMap(_memFallback, MAX_MEM_BODIES);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
  } catch { /* ignore */ }
}

// Bulk write — used by the batch-prefetch path so we don't open one
// transaction per body when we just got 25-200 of them at once.
export async function setManyCached(items) {
  if (!items?.length) return;
  for (const it of items) {
    if (it?.body && it?.messageId) {
      const k = makeKey(it.accountId, it.messageId);
      _memFallback.delete(k);
      _memFallback.set(k, { ...it, ts: Date.now() });
    }
  }
  _capMap(_memFallback, MAX_MEM_BODIES);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const it of items) {
      if (!it?.body || !it?.messageId) continue;
      store.put({ key: makeKey(it.accountId, it.messageId), accountId: it.accountId, messageId: it.messageId, body: it.body, headers: it.headers || null, attachments: it.attachments || [], ts: Date.now() });
    }
  } catch { /* ignore */ }
}

// Hydrate cached bodies for a list of {accountId, messageId} pairs. Returns
// three maps the caller can merge into React state. Skips entries that miss or
// are stale.
//
// The returned maps are keyed by the COMPOSITE mail key (`${accountId}:${id}`),
// NOT the bare messageId — two accounts can share a provider-local id, and
// keying the output by id alone would collapse them (one account's cached body
// would overwrite the other's). The consuming state (emailBodies/emailHeaders/
// emailAttachments in useEmail) is keyed the same way.
export async function hydrateForIds(ids) {
  const bodies = {}, headers = {}, attachments = {};
  if (!ids?.length) return { bodies, headers, attachments };
  const db = await openDb();
  // No DB → in-memory only
  if (!db) {
    for (const { accountId, messageId } of ids) {
      const key = makeKey(accountId, messageId);
      const e = _memFallback.get(key);
      if (e && Date.now() - e.ts < TTL_MS) {
        bodies[key] = e.body;
        if (e.headers) headers[key] = e.headers;
        if (e.attachments) attachments[key] = e.attachments;
      }
    }
    return { bodies, headers, attachments };
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      let pending = ids.length;
      if (!pending) return resolve({ bodies, headers, attachments });
      const now = Date.now();
      for (const { accountId, messageId } of ids) {
        const key = makeKey(accountId, messageId);
        const r = store.get(key);
        r.onsuccess = () => {
          const v = r.result;
          if (v && now - v.ts < TTL_MS) {
            bodies[key] = v.body;
            if (v.headers) headers[key] = v.headers;
            if (v.attachments) attachments[key] = v.attachments;
          }
          if (--pending === 0) resolve({ bodies, headers, attachments });
        };
        r.onerror = () => { if (--pending === 0) resolve({ bodies, headers, attachments }); };
      }
    } catch { resolve({ bodies, headers, attachments }); }
  });
}

// ---- List cache (SWR for inbox lists) -------------------------------------
//
// Stores the metadata-list response per (accountId, category). Used by
// useEmail.loadEmailsForAccount to paint the inbox instantly on cold reload
// before the network response lands. List TTL is short (5 min) — past that,
// the cached list is still useful as a placeholder, but we treat the
// network response as authoritative.

const _listMemFallback = new Map();

function makeListKey(accountId, category) { return `${accountId || ''}:${category}`; }

export async function setCachedList(accountId, category, emails) {
  if (!Array.isArray(emails)) return;
  const key = makeListKey(accountId, category);
  const entry = { key, accountId, category, emails, ts: Date.now() };
  _listMemFallback.delete(key);
  _listMemFallback.set(key, entry);
  _capMap(_listMemFallback, MAX_MEM_LISTS);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(LISTS_STORE, 'readwrite');
    tx.objectStore(LISTS_STORE).put(entry);
  } catch { /* ignore */ }
}

// Hydrate cached lists for many (accountId, category) pairs in one
// transaction. Resolves to { [accountId]: { [category]: emails[] } }.
// Skips entries older than 24h.
export async function hydrateLists(pairs) {
  const out = {};
  if (!pairs?.length) return out;
  const db = await openDb();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  if (!db) {
    for (const { accountId, category } of pairs) {
      const e = _listMemFallback.get(makeListKey(accountId, category));
      if (e && e.ts > cutoff) {
        if (!out[accountId]) out[accountId] = {};
        out[accountId][category] = e.emails;
      }
    }
    return out;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(LISTS_STORE, 'readonly');
      const store = tx.objectStore(LISTS_STORE);
      let pending = pairs.length;
      if (!pending) return resolve(out);
      for (const { accountId, category } of pairs) {
        const r = store.get(makeListKey(accountId, category));
        r.onsuccess = () => {
          const v = r.result;
          if (v && v.ts > cutoff) {
            if (!out[accountId]) out[accountId] = {};
            out[accountId][category] = v.emails;
          }
          if (--pending === 0) resolve(out);
        };
        r.onerror = () => { if (--pending === 0) resolve(out); };
      }
    } catch { resolve(out); }
  });
}

// Cap-and-evict — run occasionally so the store doesn't grow unbounded.
// Removes oldest entries (by ts) past MAX_ENTRIES. Best-effort, never throws.
export async function maybeEvict() {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const total = countReq.result;
      if (total <= MAX_ENTRIES) return;
      const toRemove = total - MAX_ENTRIES;
      const idx = store.index('ts');
      let removed = 0;
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || removed >= toRemove) return;
        cur.delete();
        removed++;
        cur.continue();
      };
    };
  } catch { /* ignore */ }
}
