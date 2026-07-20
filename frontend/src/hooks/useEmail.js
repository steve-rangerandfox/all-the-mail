import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { API_BASE } from '../utils/constants';
import { stripName } from '../utils/helpers';
import { getCached, setCached, setManyCached, hydrateForIds, maybeEvict, setCachedList, hydrateLists } from '../utils/emailCache';
import { maybeHandleApiError } from '../utils/apiErrors';
import { mailKey, threadKey, emailKey, sameMailItem, snoozeKey } from '../utils/mailIdentity';
import { computeReaderNavigation } from '../utils/readerNav';

export function useEmail({
  connectedAccounts,
  activeView,
  activeCategory,
  searchQuery,
  conversationView,
  sendDelaySeconds,
  setSuccessToast,
  setError,
  setIsAuthed,
  handleLogout,
  splitMode,
  setFullPageReaderOpen,
  setShowMetadata,
  setReaderCompact,
}) {
  const [emails, setEmails] = useState({});
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [selectedThread, setSelectedThread] = useState(null);
  const [, setSelectedThreadActiveMessageId] = useState(null);

  const [emailBodies, setEmailBodies] = useState({});
  const [emailHeaders, setEmailHeaders] = useState({});
  const emailBodiesRef = useRef({});
  const emailHeadersRef = useRef({});
  // Composite (account+message) keys with an in-flight body request. Guards
  // against overlapping duplicate loads — e.g. rapid J/K navigation or a hover
  // racing the reader — so a burst of triggers collapses to one provider call
  // per message rather than N concurrent identical fetches.
  const inFlightDetailsRef = useRef(new Set());
  // (account:category) keys with an in-flight LIST load. Same dedup guarantee
  // for list refreshes: a poll racing a manual refresh, or two callers for the
  // same (account, category), collapse to a single provider request.
  const inFlightListsRef = useRef(new Set());
  // Latest connectedAccounts, read via ref so account-scoped loaders don't take
  // `connectedAccounts` as a hook dependency. That dependency is load-bearing:
  // loadEmailsForAccount fed App.js's loadAccounts, which SETS connectedAccounts
  // (a fresh array each call) — so a connectedAccounts dep made loadAccounts
  // churn identity, re-run its mount effect, and reload accounts+docs+events+mail
  // in a tight loop (~140 req/s idle). Reading via ref keeps the loader stable.
  const connectedAccountsRef = useRef(connectedAccounts);
  useEffect(() => { connectedAccountsRef.current = connectedAccounts; }, [connectedAccounts]);

  const [emailAttachments, setEmailAttachments] = useState({});
  const [isLoadingEmails, setIsLoadingEmails] = useState(false);
  const [isLoadingBody, setIsLoadingBody] = useState(false);
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [emailLoadError, setEmailLoadError] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [batchWorking, setBatchWorking] = useState(false);
  const [starredOverrides, setStarredOverrides] = useState({});
  const [snoozedEmails, setSnoozedEmails] = useState(() => JSON.parse(localStorage.getItem('atm_snoozed') || '{}'));
  const [snoozeDropdownEmailId, setSnoozeDropdownEmailId] = useState(null);
  const [collapsedMsgIds, setCollapsedMsgIds] = useState(new Set());
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [expandedBodies, setExpandedBodies] = useState({});

  // Keep refs in sync
  useEffect(() => { emailBodiesRef.current = emailBodies; }, [emailBodies]);
  useEffect(() => { emailHeadersRef.current = emailHeaders; }, [emailHeaders]);

  // Persist snoozed emails to localStorage (write-through cache for offline support)
  useEffect(() => { localStorage.setItem('atm_snoozed', JSON.stringify(snoozedEmails)); }, [snoozedEmails]);

  // Check snoozed emails every 60 seconds; delete expired entries from Supabase
  useEffect(() => {
    const checkSnoozed = () => {
      const now = Date.now();
      setSnoozedEmails(prev => {
        const updated = { ...prev };
        let changed = false;
        for (const key of Object.keys(updated)) {
          if (new Date(updated[key].until).getTime() <= now) {
            // Fire-and-forget cleanup in Supabase
            const { accountId, emailId } = updated[key];
            if (accountId && emailId) {
              fetch(`${API_BASE}/snoozed/${accountId}/${emailId}`, {
                method: 'DELETE', credentials: 'include',
              }).catch(() => {});
            }
            delete updated[key];
            changed = true;
          }
        }
        return changed ? updated : prev;
      });
    };
    checkSnoozed();
    const interval = setInterval(checkSnoozed, 60000);
    return () => clearInterval(interval);
  }, []);

  // syncSnoozed: called once on boot from App.js after accounts load.
  // Fetches Supabase state, merges with localStorage (Supabase wins on conflict),
  // and backfills any localStorage-only entries up to Supabase.
  // Fails silently — localStorage continues to work if the request fails.
  const syncSnoozed = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/snoozed`, { credentials: 'include' });
      if (!r.ok) return;
      const { snoozes } = await r.json();

      const localMap = JSON.parse(localStorage.getItem('atm_snoozed') || '{}');
      const dbKeys = new Set(snoozes.map(s => snoozeKey(s.accountId, s.messageId)));

      // Backfill: local entries not in Supabase (fire-and-forget)
      Object.entries(localMap).forEach(([key, val]) => {
        if (!dbKeys.has(key)) {
          fetch(`${API_BASE}/snoozed`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: val.accountId, messageId: val.emailId, snoozeUntil: val.until }),
          }).catch(() => {});
        }
      });

      // Merge: Supabase wins on conflict
      const merged = { ...localMap };
      snoozes.forEach(s => {
        merged[snoozeKey(s.accountId, s.messageId)] = {
          emailId: s.messageId,
          accountId: s.accountId,
          until: s.snoozeUntil,
        };
      });

      setSnoozedEmails(merged);
    } catch (err) {
      console.error('syncSnoozed error:', err);
    }
  }, []);

  // SWR list loader. The fast path on cold reload is:
  //   1. Hydrate the cached list from IDB and paint immediately
  //   2. Fan out the network refresh in parallel across categories
  //
  // Default category set is just ['primary']. The full sidebar set
  // (primary/social/promotions/sent/drafts/trash) only loads when the
  // user explicitly clicks into that category — App.js's activeCategory
  // effect already triggers a refresh on click, so we don't need to
  // pre-fetch all six up front (~9s on 4 accounts vs ~1.5s for primary).
  const loadEmailsForAccount = useCallback(async (accountId, category = null) => {
    const cats = category ? [category] : ['primary'];

    // In-flight dedup (invariant: one canonical in-flight load per account+
    // category). The key is account-scoped so two accounts never collapse
    // together. A duplicate caller (poll racing a manual refresh) no-ops.
    const listKey = `${accountId}:${cats.join(',')}`;
    if (inFlightListsRef.current.has(listKey)) return;
    inFlightListsRef.current.add(listKey);

    // Stage 1 — paint cached lists synchronously-ish from IDB. Doesn't
    // block the network refresh below.
    hydrateLists(cats.map(c => ({ accountId, category: c }))).then((hydrated) => {
      const accCats = hydrated[accountId];
      if (!accCats) return;
      setEmails(p => {
        const cur = p[accountId] || {};
        const next = { ...cur };
        for (const c of cats) {
          // Only paint cache if state for this (account, category) is empty —
          // network response (if it already arrived) wins.
          if (!next[c] && accCats[c]) next[c] = accCats[c];
        }
        return { ...p, [accountId]: next };
      });
    }).catch(() => {});

    // Stage 2 — network refresh. All categories in parallel via Promise.all
    // so a 6-category load takes ~1.5s instead of ~9s.
    setIsLoadingEmails(true);
    const fetches = cats.map(async (cat) => {
      try {
        const r = await fetch(`${API_BASE}/emails/${accountId}?category=${cat}&maxResults=50`, { credentials: 'include' });
        // Dispatch typed-error CustomEvents (token_revoked / scope_upgrade)
        // so the global App.js listeners can surface the right UX. Returns
        // ok=false so this category is treated as a soft failure rather
        // than triggering the full unauthed flow that nukes all emails.
        const account = connectedAccountsRef.current.find(a => a.id === accountId);
        if (await maybeHandleApiError(r, account)) {
          return { ok: false, accountId, category: cat };
        }
        if (r.ok) {
          const d = await r.json();
          const list = d.emails || [];
          setEmails(p => ({ ...p, [accountId]: { ...(p[accountId] || {}), [cat]: list } }));
          // Persist to IDB so the next cold reload paints instantly.
          setCachedList(accountId, cat, list).catch(() => {});
          return { ok: true };
        }
        if (r.status === 401) {
          return { unauthed: true };
        }
        return { ok: false, accountId, category: cat };
      } catch (err) {
        console.error('Error loading emails:', err);
        return { ok: false, accountId, category: cat };
      }
    });

    const results = await Promise.all(fetches);
    const anyUnauthed = results.some(r => r.unauthed);
    const anyOk = results.some(r => r.ok);
    const firstError = results.find(r => r.ok === false);

    inFlightListsRef.current.delete(listKey);

    if (anyUnauthed) {
      setIsAuthed(false);
      setEmails({});
      setSelectedEmail(null);
      setSelectedThread(null);
      setSelectedThreadActiveMessageId(null);
      setEmailBodies({});
      setEmailHeaders({});
      setEditMode(false);
      setSelectedIds(new Set());
      setIsLoadingEmails(false);
      return;
    }

    // Last-known-good: a soft failure (e.g. 429) records the error but never
    // clears the already-loaded list — only a genuine success overwrites it.
    if (anyOk) setIsAuthed(true);
    if (firstError) setEmailLoadError(firstError);
    else if (anyOk) setEmailLoadError(null);
    setIsLoadingEmails(false);
  }, [setIsAuthed]);

  const loadEmailDetails = useCallback(async (email) => {
    if (!email?.id) return;
    const eid = email.id;
    const aid = email.accountId || connectedAccounts[0]?.id;
    if (!aid) return;
    // Composite (account + message) identity — bodies/headers/attachments are a
    // single cross-account map, so keying by the bare message id would let one
    // account's body satisfy another account's colliding id (and short-circuit
    // the account-aware IDB read below).
    const key = mailKey(aid, eid);
    if (emailBodiesRef.current[key] && emailHeadersRef.current[key]) {
      return { body: emailBodiesRef.current[key], headers: emailHeadersRef.current[key] };
    }

    // Concurrency dedup: if a load for this exact (account, message) is already
    // in flight, don't start a second one. Rapid J/K navigation or a hover that
    // races the reader therefore collapses to a single provider call per
    // message instead of a burst of identical concurrent fetches.
    if (inFlightDetailsRef.current.has(key)) return;
    inFlightDetailsRef.current.add(key);

    // Stale-while-revalidate: if we have a persisted copy, render it
    // instantly so the reader pane never blanks. The network refresh
    // below will overwrite if Gmail returns something newer.
    let cacheHit = false;
    try {
      const cached = await getCached(aid, eid);
      if (cached?.body) {
        cacheHit = true;
        setEmailBodies(p => p[key] === cached.body ? p : { ...p, [key]: cached.body });
        if (cached.headers) setEmailHeaders(p => p[key] ? p : { ...p, [key]: cached.headers });
        if (cached.attachments?.length) setEmailAttachments(p => p[key] ? p : { ...p, [key]: cached.attachments });
      }
    } catch { /* ignore */ }

    if (!cacheHit) setIsLoadingBody(true);
    try {
      const r = await fetch(`${API_BASE}/emails/${aid}/${eid}`, { credentials: 'include' });
      const account = connectedAccounts.find(a => a.id === aid);
      if (await maybeHandleApiError(r, account)) return;
      if (r.ok) {
        setIsAuthed(true);
        const d = await r.json();
        setEmailBodies(p => { const u = { ...p, [key]: d.body }; const k = Object.keys(u); if (k.length > 500) k.slice(0, k.length - 500).forEach(x => delete u[x]); return u; });
        if (d.headers) setEmailHeaders(p => { const u = { ...p, [key]: d.headers }; const k = Object.keys(u); if (k.length > 500) k.slice(0, k.length - 500).forEach(x => delete u[x]); return u; });
        if (d.attachments) setEmailAttachments(p => { const u = { ...p, [key]: d.attachments }; const k = Object.keys(u); if (k.length > 500) k.slice(0, k.length - 500).forEach(x => delete u[x]); return u; });
        // Persist to IDB so the next session is instant.
        setCached(aid, eid, d.body, d.headers, d.attachments).catch(() => {});
        if (!email.isRead) {
          // Scope the optimistic read-mark to the acted-on account only — a
          // colliding message id in another account must not be flipped.
          setEmails(p => {
            const acc = p[aid]; if (!acc) return p;
            const u = {};
            for (const c of Object.keys(acc)) u[c] = (acc[c] || []).map(e => e.id === eid ? { ...e, isRead: true } : e);
            return { ...p, [aid]: u };
          });
          fetch(`${API_BASE}/emails/${aid}/${eid}/read`, { method: 'POST', credentials: 'include' }).catch(() => {});
        }
        return { body: d.body, headers: d.headers, attachments: d.attachments };
      } else if (r.status === 401) {
        setIsAuthed(false);
        setEmails({});
        setSelectedEmail(null);
        setSelectedThread(null);
        setSelectedThreadActiveMessageId(null);
        setEmailBodies({});
        setEmailHeaders({});
        setEditMode(false);
        setSelectedIds(new Set());
        return;
      }
    } catch (err) { console.error('Error loading email body:', err); }
    finally { inFlightDetailsRef.current.delete(key); if (!cacheHit) setIsLoadingBody(false); }
  }, [connectedAccounts, setIsAuthed]);

  const downloadAttachment = useCallback(async (accountId, messageId, attachmentId, filename, mimeType) => {
    try {
      const r = await fetch(`${API_BASE}/emails/${accountId}/${messageId}/attachments/${attachmentId}?filename=${encodeURIComponent(filename)}&mimeType=${encodeURIComponent(mimeType)}`, { credentials: 'include' });
      if (r.ok) {
        const b = await r.blob();
        const u = window.URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = u; a.download = filename;
        document.body.appendChild(a); a.click();
        window.URL.revokeObjectURL(u); document.body.removeChild(a);
      } else {
        setError('Failed to download attachment');
      }
    } catch (err) { console.error('Download error:', err); setError('Failed to download attachment'); }
  }, [setError]);

  const loadThread = useCallback(async (email) => {
    if (!email?.threadId || !email?.accountId) { setSelectedThread(null); setSelectedThreadActiveMessageId(null); return; }
    setIsLoadingThread(true);
    setCollapsedMsgIds(new Set());
    setThreadExpanded(false);
    try {
      const r = await fetch(`${API_BASE}/emails/${email.accountId}/${email.threadId}/thread`, { credentials: 'include' });
      const account = connectedAccounts.find(a => a.id === email.accountId);
      if (await maybeHandleApiError(r, account)) {
        setSelectedThread(null);
        setSelectedThreadActiveMessageId(null);
        return;
      }
      if (r.ok) {
        const d = await r.json();
        const msgs = d.messages || [];
        setSelectedThread({ threadId: email.threadId, messages: msgs });
        if (msgs.length > 1) {
          const last = msgs[msgs.length - 1];
          setSelectedThreadActiveMessageId(last.id);
          const obj = { id: last.id, threadId: last.threadId, subject: last.subject || email.subject, from: last.from || email.from, date: last.date || email.date, snippet: last.snippet || '', accountId: email.accountId, accountName: email.accountName, source: email.source };
          setSelectedEmail(obj);
          loadEmailDetails(obj);
        } else {
          setSelectedThreadActiveMessageId(email.id);
        }
      } else if (r.status === 401) {
        handleLogout();
      } else {
        setSelectedThread(null);
        setSelectedThreadActiveMessageId(null);
      }
    } catch (err) { console.error('Thread error:', err); setSelectedThread(null); setSelectedThreadActiveMessageId(null); }
    finally { setIsLoadingThread(false); }
  }, [handleLogout, loadEmailDetails, connectedAccounts]);

  const getCurrentEmails = useCallback(() => {
    let list;
    if (activeView === 'everything') {
      const all = [];
      connectedAccounts.forEach(a => { const ae = emails[a.id]?.[activeCategory] || []; all.push(...ae.map(e => ({ ...e, accountId: a.id }))); });
      list = all.sort((a, b) => new Date(b.date) - new Date(a.date));
    } else {
      // Normalization boundary: raw backend list objects carry no accountId.
      // In per-account view activeView IS the owning account id — stamp it
      // here (mirroring the everything branch above) so every email entering
      // shared mail state satisfies the account-aware identity invariant.
      // Reader keys, source chips, thread loading, prefetch, and batch
      // grouping all rely on email.accountId being present.
      list = (emails[activeView]?.[activeCategory] || []).map(e => ({ ...e, accountId: activeView }));
    }

    if (!conversationView) return list;

    const threadMap = new Map();
    for (const email of list) {
      // Group by (account, threadId) — two accounts sharing a provider-local
      // threadId are distinct conversations and must not be merged.
      const tid = threadKey(email.accountId, email.threadId || email.id);
      if (!threadMap.has(tid)) {
        threadMap.set(tid, { emails: [], newest: email });
      }
      const entry = threadMap.get(tid);
      entry.emails.push(email);
      if (new Date(email.date) > new Date(entry.newest.date)) {
        entry.newest = email;
      }
    }

    const grouped = [];
    for (const [, entry] of threadMap) {
      const { newest, emails: threadEmails } = entry;
      const participants = [...new Set(threadEmails.map(e => stripName(e.from || '')))];
      const hasUnread = threadEmails.some(e => !e.isRead);
      grouped.push({
        ...newest,
        threadCount: threadEmails.length,
        threadParticipants: participants,
        threadMessageIds: threadEmails.map(e => e.id),
        isRead: !hasUnread,
      });
    }

    return grouped.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [activeView, activeCategory, connectedAccounts, emails, conversationView]);

  const filteredEmails = useMemo(() => {
    const isSnoozed = e => snoozedEmails[snoozeKey(e.accountId, e.id)];
    if (!searchQuery) {
      return getCurrentEmails().filter(e => !isSnoozed(e));
    }
    const q = searchQuery.toLowerCase();
    const matchFn = e => (e.subject || '').toLowerCase().includes(q) || (e.from || '').toLowerCase().includes(q) || (e.snippet || '').toLowerCase().includes(q);
    const all = [];
    connectedAccounts.forEach(a => {
      Object.values(emails[a.id] || {}).forEach(catEmails => {
        (catEmails || []).forEach(e => {
          if (matchFn(e)) all.push({ ...e, accountId: a.id });
        });
      });
    });
    const seen = new Set();
    // Dedup by composite (account, id): the same provider-local id in two
    // accounts is two different messages and both must survive search.
    return all.filter(e => { const k = emailKey(e); if (seen.has(k) || isSnoozed(e)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [getCurrentEmails, searchQuery, snoozedEmails, connectedAccounts, emails]);

  const allEmails = useMemo(() => {
    const all = [];
    connectedAccounts.forEach(a => {
      const ae = emails[a.id]?.primary || [];
      all.push(...ae.map(e => ({ ...e, accountId: a.id })));
    });
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [connectedAccounts, emails]);

  const categoryCounts = useMemo(() => {
    const c = { primary: 0, social: 0, promotions: 0, sent: 0, drafts: 0, trash: 0 };
    connectedAccounts.forEach(a => { const ac = emails[a.id] || {}; c.primary += ac.primary?.length || 0; c.social += ac.social?.length || 0; c.promotions += ac.promotions?.length || 0; c.sent += ac.sent?.length || 0; c.drafts += ac.drafts?.length || 0; c.trash += ac.trash?.length || 0; });
    return c;
  }, [emails, connectedAccounts]);

  const lastSelectedKeyRef = useRef(null);
  const clearSelection = useCallback(() => { lastSelectedKeyRef.current = null; setSelectedIds(new Set()); }, []);
  // selectedIds holds composite (account, id) keys so selecting a message in
  // one account never selects a colliding-id message in another. Callers pass
  // the full email object; the mutation target is later rebuilt from each
  // item's own fields (never by parsing the key).
  const toggleSelectId = useCallback((email) => { const k = emailKey(email); lastSelectedKeyRef.current = k; setSelectedIds(p => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }); }, []);
  // Shift/range selection: select every visible row between the last-toggled
  // anchor and the clicked row (inclusive). Falls back to a plain toggle when
  // there is no anchor yet. Operates purely on filteredEmails (the visible set)
  // so a range can never reach hidden or other-account messages implicitly.
  const selectRange = useCallback((email) => {
    const k = emailKey(email);
    const anchor = lastSelectedKeyRef.current;
    if (!anchor) { lastSelectedKeyRef.current = k; setSelectedIds(p => { const n = new Set(p); n.add(k); return n; }); return; }
    const keys = filteredEmails.map(e => emailKey(e));
    const i = keys.indexOf(anchor), j = keys.indexOf(k);
    if (i === -1 || j === -1) { lastSelectedKeyRef.current = k; setSelectedIds(p => { const n = new Set(p); n.add(k); return n; }); return; }
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    setSelectedIds(p => { const n = new Set(p); for (let x = lo; x <= hi; x++) n.add(keys[x]); return n; });
    lastSelectedKeyRef.current = k;
  }, [filteredEmails]);
  const selectAllVisible = useCallback(() => { setSelectedIds(() => new Set(filteredEmails.map(e => emailKey(e)))); }, [filteredEmails]);

  const groupSelectedByAccount = useCallback(() => {
    const m = new Map();
    for (const e of filteredEmails) {
      if (!selectedIds.has(emailKey(e))) continue;
      const a = e.accountId; if (!a) continue;
      if (!m.has(a)) m.set(a, []);
      m.get(a).push(e.id);
    }
    return m;
  }, [filteredEmails, selectedIds]);

  const removeEmailIds = useCallback((aid, ids) => {
    setEmails(p => { const c = { ...p }; const cats = c[aid] || {}; const u = {}; for (const k of Object.keys(cats)) { u[k] = (cats[k] || []).filter(e => !ids.includes(e.id)); } c[aid] = u; return c; });
  }, []);

  const trashEmail = useCallback((email) => {
    if (!email?.id || !email?.accountId) return;
    const snapshot = { ...emails };
    removeEmailIds(email.accountId, [email.id]);
    if (sameMailItem(selectedEmail, email)) {
      setSelectedEmail(null); setSelectedThread(null); setSelectedThreadActiveMessageId(null);
      if (setShowMetadata) setShowMetadata(false);
      if (setFullPageReaderOpen) setFullPageReaderOpen(false);
    }
    const executeFn = async () => {
      try {
        const r = await fetch(`${API_BASE}/emails/${email.accountId}/${email.id}/trash`, { method: 'POST', credentials: 'include' });
        const account = connectedAccounts.find(a => a.id === email.accountId);
        if (await maybeHandleApiError(r, account)) { setEmails(snapshot); return; }
        if (!r.ok) { setEmails(snapshot); setError('Failed to delete'); }
      } catch (err) { setEmails(snapshot); setError('Failed to delete'); }
    };
    const undoFn = () => { setEmails(snapshot); setSuccessToast(null); };
    setSuccessToast({ message: 'Email deleted', undoFn, executeFn });
  }, [selectedEmail, removeEmailIds, emails, setError, setSuccessToast, setShowMetadata, setFullPageReaderOpen, connectedAccounts]);

  const archiveEmail = useCallback((email) => {
    if (!email?.id || !email?.accountId) return;
    const snapshot = { ...emails };
    removeEmailIds(email.accountId, [email.id]);
    if (sameMailItem(selectedEmail, email)) {
      setSelectedEmail(null); setSelectedThread(null); setSelectedThreadActiveMessageId(null);
      if (setShowMetadata) setShowMetadata(false);
      if (setFullPageReaderOpen) setFullPageReaderOpen(false);
    }
    const executeFn = async () => {
      try {
        const r = await fetch(`${API_BASE}/emails/${email.accountId}/${email.id}/archive`, { method: 'POST', credentials: 'include' });
        const account = connectedAccounts.find(a => a.id === email.accountId);
        if (await maybeHandleApiError(r, account)) { setEmails(snapshot); return; }
        if (!r.ok) { setEmails(snapshot); setError('Failed to archive'); }
      } catch (err) { setEmails(snapshot); setError('Failed to archive'); }
    };
    const undoFn = () => { setEmails(snapshot); setSuccessToast(null); };
    setSuccessToast({ message: 'Email archived', undoFn, executeFn });
  }, [selectedEmail, removeEmailIds, emails, setError, setSuccessToast, setShowMetadata, setFullPageReaderOpen, connectedAccounts]);

  // Report spam — same optimistic-remove + deferred-undo shape as archive, but
  // the provider call moves the message to SPAM (removing INBOX). Account-scoped.
  const spamEmail = useCallback((email) => {
    if (!email?.id || !email?.accountId) return;
    const snapshot = { ...emails };
    removeEmailIds(email.accountId, [email.id]);
    if (sameMailItem(selectedEmail, email)) {
      setSelectedEmail(null); setSelectedThread(null); setSelectedThreadActiveMessageId(null);
      if (setShowMetadata) setShowMetadata(false);
      if (setFullPageReaderOpen) setFullPageReaderOpen(false);
    }
    const executeFn = async () => {
      try {
        const r = await fetch(`${API_BASE}/emails/${email.accountId}/${email.id}/labels`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }),
        });
        const account = connectedAccounts.find(a => a.id === email.accountId);
        if (await maybeHandleApiError(r, account)) { setEmails(snapshot); return; }
        if (!r.ok) { setEmails(snapshot); setError('Failed to report spam'); }
      } catch (err) { setEmails(snapshot); setError('Failed to report spam'); }
    };
    const undoFn = () => { setEmails(snapshot); setSuccessToast(null); };
    setSuccessToast({ message: 'Reported spam', undoFn, executeFn });
  }, [selectedEmail, removeEmailIds, emails, setError, setSuccessToast, setShowMetadata, setFullPageReaderOpen, connectedAccounts]);

  // Mark read / unread. Instant (no undo). Optimistically scoped to the
  // acted-on account so a colliding id elsewhere is never flipped.
  const setReadState = useCallback(async (email, read) => {
    if (!email?.id || !email?.accountId) return;
    const aid = email.accountId, eid = email.id;
    setEmails(p => { const acc = p[aid]; if (!acc) return p; const u = {}; for (const c of Object.keys(acc)) u[c] = (acc[c] || []).map(e => e.id === eid ? { ...e, isRead: read } : e); return { ...p, [aid]: u }; });
    try {
      const r = await fetch(`${API_BASE}/emails/${aid}/${eid}/${read ? 'read' : 'unread'}`, { method: 'POST', credentials: 'include' });
      const account = connectedAccounts.find(a => a.id === aid);
      if (await maybeHandleApiError(r, account)) return;
      if (!r.ok) { setEmails(p => { const acc = p[aid]; if (!acc) return p; const u = {}; for (const c of Object.keys(acc)) u[c] = (acc[c] || []).map(e => e.id === eid ? { ...e, isRead: !read } : e); return { ...p, [aid]: u }; }); }
    } catch (err) { /* revert on failure */ setEmails(p => { const acc = p[aid]; if (!acc) return p; const u = {}; for (const c of Object.keys(acc)) u[c] = (acc[c] || []).map(e => e.id === eid ? { ...e, isRead: !read } : e); return { ...p, [aid]: u }; }); }
  }, [connectedAccounts]);
  const markRead = useCallback((email) => setReadState(email, true), [setReadState]);
  const markUnread = useCallback((email) => setReadState(email, false), [setReadState]);

  const starEmail = useCallback(async (email) => {
    if (!email?.id || !email?.accountId) return;
    // Composite key so a star toggle stays on the acted-on account's message.
    const key = emailKey(email);
    const currentlyStarred = starredOverrides[key] !== undefined ? starredOverrides[key] : email.isStarred;
    const newStarred = !currentlyStarred;
    setStarredOverrides(prev => ({ ...prev, [key]: newStarred }));
    try {
      await fetch(`${API_BASE}/emails/${email.accountId}/${email.id}/star`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred: newStarred }),
      });
    } catch (err) {
      setStarredOverrides(prev => ({ ...prev, [key]: currentlyStarred }));
    }
  }, [starredOverrides]);

  const searchAllAccounts = useCallback(async (q) => {
    if (!q.trim() || connectedAccounts.length === 0) return;
    setIsLoadingEmails(true);
    try {
      const results = await Promise.all(
        connectedAccounts.map(async (a) => {
          try {
            const r = await fetch(`${API_BASE}/emails/${a.id}?q=${encodeURIComponent(q)}&maxResults=25`, { credentials: 'include' });
            if (!r.ok) return [];
            const d = await r.json();
            return (d.emails || []).map(e => ({ ...e, accountId: a.id }));
          } catch { return []; }
        })
      );
      const all = results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));
      const seen = new Set();
      // Dedup by composite (account, id) so identical provider-local ids across
      // accounts both survive the merged result set.
      const deduped = all.filter(e => { const k = emailKey(e); if (seen.has(k)) return false; seen.add(k); return true; });
      setEmails(prev => {
        const n = { ...prev };
        connectedAccounts.forEach(a => {
          n[a.id] = { ...(n[a.id] || {}), _search: deduped.filter(e => e.accountId === a.id) };
        });
        return n;
      });
    } catch (err) { console.error('Search error:', err); }
    finally { setIsLoadingEmails(false); }
  }, [connectedAccounts]);

  const batchAction = useCallback((action) => {
    if (selectedIds.size === 0) return;
    const snapshot = { ...emails };
    const byAccount = groupSelectedByAccount();
    // Count only messages that are actually present in the visible set. A stale
    // selection (e.g. left over from another folder) must never report success
    // for an operation that touched nothing.
    const affectedCount = [...byAccount.values()].reduce((n, ids) => n + ids.length, 0);
    if (affectedCount === 0) { clearSelection(); setEditMode(false); return; }
    // Rebuild the affected key set from what's actually being removed.
    const affectedIds = new Set();
    for (const e of filteredEmails) { if (selectedIds.has(emailKey(e)) && e.accountId && byAccount.has(e.accountId)) affectedIds.add(emailKey(e)); }
    byAccount.forEach((ids, aid) => removeEmailIds(aid, ids));
    if (selectedEmail && affectedIds.has(emailKey(selectedEmail))) {
      setSelectedEmail(null); setSelectedThread(null); setSelectedThreadActiveMessageId(null);
      if (setShowMetadata) setShowMetadata(false);
      if (setFullPageReaderOpen) setFullPageReaderOpen(false);
    }
    clearSelection(); setEditMode(false);
    const label = action === 'archive' ? `Archived ${affectedCount} message${affectedCount !== 1 ? 's' : ''}` : `Deleted ${affectedCount} message${affectedCount !== 1 ? 's' : ''}`;
    const executeFn = async () => {
      setBatchWorking(true);
      try {
        for (const [aid, ids] of byAccount.entries()) {
          const r = await fetch(`${API_BASE}/emails/${aid}/batch`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, emailIds: ids }) });
          if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error || `Batch ${action} failed`); }
        }
      } catch (err) { setEmails(snapshot); setError(String(err?.message || err)); }
      finally { setBatchWorking(false); }
    };
    const undoFn = () => { setEmails(snapshot); setSuccessToast(null); };
    setSuccessToast({ message: label, undoFn, executeFn });
  }, [selectedIds, emails, groupSelectedByAccount, removeEmailIds, selectedEmail, clearSelection, setError, setSuccessToast, setShowMetadata, setFullPageReaderOpen, filteredEmails]);

  const snoozeEmail = useCallback((email, until) => {
    if (!email?.id) return;
    const key = snoozeKey(email.accountId, email.id);
    setSnoozedEmails(prev => ({ ...prev, [key]: { emailId: email.id, accountId: email.accountId, until: until.toISOString() } }));
    setSnoozeDropdownEmailId(null);
    setSuccessToast({ message: `Snoozed until ${new Date(until).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}` });
    if (sameMailItem(selectedEmail, email)) {
      setSelectedEmail(null); setSelectedThread(null); setSelectedThreadActiveMessageId(null);
      if (setShowMetadata) setShowMetadata(false);
      if (setFullPageReaderOpen) setFullPageReaderOpen(false);
    }
    // Persist to Supabase (fire-and-forget; localStorage is already updated above)
    fetch(`${API_BASE}/snoozed`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: email.accountId, messageId: email.id, snoozeUntil: until.toISOString() }),
    }).catch(() => {});
  }, [selectedEmail, setSuccessToast, setShowMetadata, setFullPageReaderOpen]);

  const getSnoozeOptions = useCallback(() => {
    const now = new Date();
    const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    const nextMonday = new Date(now);
    nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
    nextMonday.setHours(8, 0, 0, 0);
    return [
      { label: 'Later today', time: laterToday },
      { label: 'Tomorrow morning', time: tomorrowMorning },
      { label: 'Next week', time: nextMonday },
    ];
  }, []);

  // One reader-navigation step loads ONLY the destination message (plus its
  // thread for conversation view). It deliberately does NOT fan out speculative
  // body loads for surrounding messages: with multiple connected accounts that
  // amplified a single J/K press into ~16 provider requests and exhausted the
  // Google API quota, whose 429s then degraded the reader ("of 0", lost source
  // chip) and the list. See utils/readerNav.js for the invariant. Destination
  // loads are deduped/cache-checked inside loadEmailDetails, so rapid repeated
  // navigation cannot pile up overlapping request bursts.
  const navigateReader = useCallback((direction) => {
    const move = computeReaderNavigation(filteredEmails, selectedEmail, direction);
    if (!move) return;
    setSelectedEmail(move.destination);
    if (setShowMetadata) setShowMetadata(false);
    loadEmailDetails(move.destination);
    loadThread(move.destination);
  }, [selectedEmail, filteredEmails, loadEmailDetails, loadThread, setShowMetadata]);

  const navigatePrev = useCallback(() => navigateReader('prev'), [navigateReader]);
  const navigateNext = useCallback(() => navigateReader('next'), [navigateReader]);

  // Opening a message in the reader loads ONLY that message (plus its thread for
  // conversation view). It deliberately does NOT fan out speculative body loads
  // for the next 25 rows: with multiple connected accounts that amplified a
  // single open into a burst of provider requests that exhausted the Google API
  // quota, whose 429s then degraded the reader and the list. Visible-inbox
  // prefetch is owned exclusively by the /batch-bodies effect below, which is
  // account-scoped, chunked, cache-aware, and bounded — the single canonical
  // prefetch path. See navigateReader / utils/readerNav.js for the same
  // one-destination-per-action invariant on J/K navigation.
  const onSelectEmail = useCallback((email) => {
    setSelectedEmail(email);
    if (setShowMetadata) setShowMetadata(false);
    if (setReaderCompact) setReaderCompact(false);
    loadEmailDetails(email); loadThread(email); setSelectedThreadActiveMessageId(email.id);
    if (splitMode === 'none' && setFullPageReaderOpen) setFullPageReaderOpen(true);
  }, [loadEmailDetails, loadThread, splitMode, setShowMetadata, setReaderCompact, setFullPageReaderOpen]);

  // Batch-prefetch visible inbox.
  //
  // Two-stage:
  //   1. Hydrate from IndexedDB (instant, no network) — anything we've
  //      seen in a past session is in state before the network even fires.
  //   2. Network batch-fetch the rest from /batch-bodies, in 25-id chunks.
  //
  // Window is 200 (was 50) — at ~30 KB body avg that's ~6 MB on initial load,
  // worth it because every click into the first 200 lands instant.
  useEffect(() => {
    if (filteredEmails.length === 0) return;

    const PREFETCH_WINDOW = 200;
    const window = filteredEmails.slice(0, PREFETCH_WINDOW);

    // Stage 1 — IDB hydration. Done immediately, doesn't block the network stage.
    // hydrateForIds returns composite-keyed maps, matching the body/header state.
    const hydrationTargets = window
      .filter(e => !emailBodiesRef.current[mailKey(e.accountId, e.id)])
      .map(e => ({ accountId: e.accountId, messageId: e.id }));
    if (hydrationTargets.length) {
      hydrateForIds(hydrationTargets).then(({ bodies, headers, attachments }) => {
        if (Object.keys(bodies).length) {
          setEmailBodies(p => ({ ...bodies, ...p })); // existing state wins (newest)
          setEmailHeaders(p => ({ ...headers, ...p }));
          setEmailAttachments(p => ({ ...attachments, ...p }));
        }
      }).catch(() => {});
    }

    // Stage 2 — network for the gaps. Use a slightly delayed timer so
    // hydration races to fill the cache before we ask the network.
    const byAccount = {};
    window.forEach(email => {
      if (emailBodiesRef.current[mailKey(email.accountId, email.id)] && emailHeadersRef.current[mailKey(email.accountId, email.id)]) return;
      const aid = email.accountId; if (!aid) return;
      if (!byAccount[aid]) byAccount[aid] = [];
      byAccount[aid].push(email.id);
    });
    if (Object.keys(byAccount).length === 0) return;

    const timer = setTimeout(() => {
      Object.entries(byAccount).forEach(([accountId, ids]) => {
        const chunks = [];
        for (let i = 0; i < ids.length; i += 25) chunks.push(ids.slice(i, i + 25));
        const account = connectedAccounts.find(a => a.id === accountId);
        chunks.forEach(chunk => fetch(`${API_BASE}/emails/${accountId}/batch-bodies`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: chunk }),
        })
          .then(async r => {
            if (await maybeHandleApiError(r, account)) return null;
            return r.ok ? r.json() : null;
          })
          .then(d => {
            if (!d?.bodies) return;
            // Response is keyed by bare provider id (per-account endpoint); map
            // it into the composite (account, id) key space of our state.
            const bodyMap = {}, headerMap = {}, attachMap = {};
            const idbItems = [];
            Object.entries(d.bodies).forEach(([id, data]) => {
              const k = mailKey(accountId, id);
              bodyMap[k] = data.body;
              headerMap[k] = data.headers;
              attachMap[k] = data.attachments || [];
              idbItems.push({ accountId, messageId: id, body: data.body, headers: data.headers, attachments: data.attachments || [] });
            });
            setEmailBodies(p => ({ ...p, ...bodyMap }));
            setEmailHeaders(p => ({ ...p, ...headerMap }));
            setEmailAttachments(p => ({ ...p, ...attachMap }));
            // Persist the freshly fetched batch so next session is instant.
            if (idbItems.length) setManyCached(idbItems).catch(() => {});
          })
          .catch(() => {}));
      });
    }, 200);

    // Periodic eviction so the IDB store doesn't grow without bound.
    maybeEvict().catch(() => {});

    return () => clearTimeout(timer);
  }, [filteredEmails]);

  return {
    emails, selectedEmail, setSelectedEmail, selectedThread,
    emailBodies, emailHeaders, emailAttachments,
    isLoadingEmails, isLoadingBody, isLoadingThread,
    emailLoadError, editMode, setEditMode,
    selectedIds, batchWorking, starredOverrides,
    snoozedEmails, snoozeDropdownEmailId, setSnoozeDropdownEmailId,
    collapsedMsgIds, setCollapsedMsgIds, threadExpanded, setThreadExpanded, expandedBodies, setExpandedBodies,
    filteredEmails, allEmails, categoryCounts,
    loadEmailsForAccount, loadEmailDetails, downloadAttachment, loadThread,
    getCurrentEmails, trashEmail, archiveEmail, starEmail,
    spamEmail, markRead, markUnread,
    searchAllAccounts, batchAction,
    clearSelection, toggleSelectId, selectRange, selectAllVisible,
    snoozeEmail, getSnoozeOptions, syncSnoozed,
    navigatePrev, navigateNext, onSelectEmail,
    setEmails, setEmailBodies, setEmailHeaders, setEmailAttachments,
  };
}
