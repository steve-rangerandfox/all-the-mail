import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Mail, RefreshCw, Users, Plus, X,
  FileText, Calendar, LayoutGrid, Sun, Moon, MessagesSquare,
  Send, ArrowLeft, Reply, Archive, ExternalLink,
} from 'lucide-react';
import { Group as PanelGroup } from 'react-resizable-panels';
import { API_BASE, FILE_TYPES } from './utils/constants';
import {
  getAccountGradient, buildEmailSrcDoc, emailHtmlHasRemoteImages, stripName,
  migrateLayoutStorage,
  formatRelativeEdit, getShortLabel,
  getDocEditUrl, getDocIcon, getDocEditorLabel, getRelativeTime, formatTime,
  parseEventStart,
} from './utils/helpers';
import { attributionPayload } from './utils/attribution';
import { maybeHandleApiError } from './utils/apiErrors';
import { emailKey, sameMailItem } from './utils/mailIdentity';
import { buildComposerSession, blankComposerSession, composerHasContent, recomputeForFrom } from './utils/composerSession';
import { createUndoQueue } from './utils/undoQueue';
import { validateFiles } from './utils/attachments';
import * as analytics from './utils/analytics';
import { useSignatures } from './hooks/useSignatures';

import EventEditModal from './components/common/EventEditModal';
import OnboardingModal from './components/common/OnboardingModal';
import ScheduledSendsModal from './components/common/ScheduledSendsModal';
import ScopeUpgradePrompt from './components/common/ScopeUpgradePrompt';
import { useContacts } from './hooks/useContacts';
import ErrorBoundary from './components/common/ErrorBoundary';
import Avatar from './components/Avatar';
import AccountMenu from './components/common/AccountMenu';
import DocsModule from './components/docs/DocsModule';
import CalsModule from './components/cals/CalsModule';
import MailModule from './components/mail/MailModule';
import EverythingModule from './components/everything/EverythingModule';
import { useEmail } from './hooks/useEmail';

import './design-system.css';
import './brand.css';

const ComposeModal = React.lazy(() => import('./components/common/ComposeModal'));

// ==================== MAIN COMPONENT ====================

const AllTheMail = () => {
  const [isAuthed, setIsAuthed] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [introActive, setIntroActive] = useState(true);
  const [appReady, setAppReady] = useState(false);
  const [gateVisible, setGateVisible] = useState(true);
  const gateTimerRef = React.useRef(null);
  const GATE_WORDS = ['MAIL', 'DOCS', 'CALS'];
  const [gateWordIdx, setGateWordIdx] = useState(0);
  const [cascadeKey, setCascadeKey] = useState(0);
  const [theme, setTheme] = useState(() => localStorage.getItem('atm-theme') || 'light');
  const [introBannerOpen, setIntroBannerOpen] = useState(() => localStorage.getItem('atm_intro_banner') !== 'dismissed');

  const [activeModule, setActiveModule] = useState('everything');

  const dismissIntroBanner = () => {
    setIntroBannerOpen(false);
    try { localStorage.setItem('atm_intro_banner', 'dismissed'); } catch (e) {}
  };

  // Docs state
  const [docsCategory, setDocsCategory] = useState('recent');
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [docsSearchQuery, setDocsSearchQuery] = useState('');
  const [docsSortBy, setDocsSortBy] = useState('lastEdited');
  const [docsSortDir, setDocsSortDir] = useState('desc');

  // Cals state
  const [calsViewMode, setCalsViewMode] = useState(() => localStorage.getItem('atm_calview') || 'week');
  const [calDate, setCalDate] = useState(() => new Date());
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [eventEditOpen, setEventEditOpen] = useState(false);
  const [eventEditFields, setEventEditFields] = useState({});
  const [eventEditSaving, setEventEditSaving] = useState(false);
  const [eventEditError, setEventEditError] = useState(null);

  // Slide-over preview state
  const [slideOverEmail, setSlideOverEmail] = useState(null);
  const [slideOverDoc, setSlideOverDoc] = useState(null);
  const [slideOverIndex, setSlideOverIndex] = useState(null);
  const [docPreview, setDocPreview] = useState(null);
  const [docPreviewLoading, setDocPreviewLoading] = useState(false);

  // Everything column filters
  const [evMailFilter, setEvMailFilter] = useState('all');
  const [evDocsFilter, setEvDocsFilter] = useState('recent');
  const [evCalsFilter, setEvCalsFilter] = useState('upcoming');
  const [evMobileTab, setEvMobileTab] = useState('all');
  const swipeRef = useRef({ startX: 0, startY: 0, currentX: 0, emailId: null });

  const [connectedAccounts, setConnectedAccounts] = useState([]);
  const [activeView, setActiveView] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const acct = p.get('acct');
    return acct && acct !== 'all' ? acct : 'everything';
  });
  const [activeCategory, setActiveCategory] = useState('primary');

  const [docs, setDocs] = useState({});
  const [events, setEvents] = useState({});
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [docsErrors, setDocsErrors] = useState({});
  const [eventsErrors, setEventsErrors] = useState({});
  const [lastSyncTime] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [showMetadata, setShowMetadata] = useState(false);
  const [readerCompact, setReaderCompact] = useState(false);
  // Keyboard cursor/focus — a distinct state from the opened message
  // (selectedEmail) and the checkbox selection (selectedIds). j/k and arrows
  // move this cursor; it does NOT open a message or mark it read on its own.
  const [focusedKey, setFocusedKey] = useState(null);

  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState('compose');
  const [composeOriginalEmail, setComposeOriginalEmail] = useState(null);
  const [composeShowCcBcc, setComposeShowCcBcc] = useState(false);
  const [composeFromAccountId, setComposeFromAccountId] = useState('');
  const [composeTo, setComposeTo] = useState('');
  const [composeCc, setComposeCc] = useState('');
  const [composeBcc, setComposeBcc] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [composeSending, setComposeSending] = useState(false);
  const [composeError, setComposeError] = useState(null);
  const [composeAttachments, setComposeAttachments] = useState([]);
  const [composeDraftId, setComposeDraftId] = useState(null);
  // Auto-save indicator state for the compose footer.
  //   draftSavingState — 'idle' | 'saving' | 'saved'
  //   draftLastSavedAt — Date.now() of last successful save, used to
  //                      render "Saved 12s ago"-style relative timestamps
  const [draftSavingState, setDraftSavingState] = useState('idle');
  const [draftLastSavedAt, setDraftLastSavedAt] = useState(null);
  // Scheduled-sends list view — opens from the "X scheduled" pill in
  // the top bar so users can see what's queued and cancel any of them.
  const [scheduledListOpen, setScheduledListOpen] = useState(false);
  const [includeAtmSignature, setIncludeAtmSignature] = useState(() => localStorage.getItem('atm_signature') !== 'false');
  // Remote email images are blocked by default (privacy: tracking pixels leak
  // opens + IP to senders). This mirrors the global localStorage pref that
  // buildEmailSrcDoc reads, so flipping it here re-renders every reader.
  const [loadRemoteImages, setLoadRemoteImages] = useState(() => {
    try { return localStorage.getItem('atm_load_remote_images') === 'true'; } catch { return false; }
  });
  const enableRemoteImages = useCallback(() => {
    try { localStorage.setItem('atm_load_remote_images', 'true'); } catch (e) {}
    setLoadRemoteImages(true);
  }, []);

  // Scheduled sends state
  const [scheduledSends, setScheduledSends] = useState(() => JSON.parse(localStorage.getItem('atm_scheduled_sends') || '[]'));

  // Send delay (unsend) state
  const [sendDelaySeconds, setSendDelaySeconds] = useState(() => parseInt(localStorage.getItem('atm_send_delay') || '5', 10));
  const [pendingSend, setPendingSend] = useState(null); // { secondsLeft, previewSubject, interval }

  // Saved searches state
  const [savedSearches, setSavedSearches] = useState(() => {
    try { return JSON.parse(localStorage.getItem('atm_saved_searches') || '[]'); }
    catch { return []; }
  });

  const [error, setError] = useState(null);
  const [successToast, setSuccessToast] = useState(null); // { message, undoFn?, executeFn? }

  // Undo queue for optimistic mail actions. Guarantees every deferred provider
  // call runs unless explicitly undone: scheduling a new action flushes the
  // previous one to the provider first (see utils/undoQueue.js).
  const undoQueueRef = useRef(null);
  if (!undoQueueRef.current) undoQueueRef.current = createUndoQueue({ delay: 5000 });
  // Canonical toast emitter. Non-undo toasts just show; undo toasts also
  // schedule their deferred provider call on the queue and clear when it fires.
  const emitToast = useCallback((payload) => {
    if (!payload) { undoQueueRef.current.cancel(); setSuccessToast(null); return; }
    setSuccessToast(payload);
    if (payload.executeFn) {
      undoQueueRef.current.schedule(payload.executeFn, () => setSuccessToast(cur => (cur === payload ? null : cur)));
    }
  }, []);
  // Forced onboarding: shown when user is authed, has at least one
  // connected account, and has not yet completed (or abandoned) the
  // onboarding flow. The atm_onboarding_completed key is set by
  // OnboardingModal.js when the flow ends — either to 'true' (full
  // completion) or 'abandoned' (escape link clicked at step 1). Either
  // value blocks re-show.
  const [onboardingDoneFlag, setOnboardingDoneFlag] = useState(
    () => (typeof window !== 'undefined' ? localStorage.getItem('atm_onboarding_completed') : 'true')
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  // accessGate: when truthy, the paywall is in BLOCKING mode (user has no
  // active subscription/trial — must subscribe to use the app). The detail
  // shape comes from the backend 403: { state, trialAvailable }.
  const [accessGate, setAccessGate] = useState(null);
  // P1.12 — incremental scope upgrade prompt. Set by either an explicit user
  // action (clicking "Connect Gmail" on an account that hasn't granted
  // gmail.* scopes) or a 403 { error: 'scope_upgrade_required' } from any
  // backend route. Shape: { group: 'mail'|'docs'|'cals', accountId, accountEmail }.
  const [scopeUpgrade, setScopeUpgrade] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isCheckingMail, setIsCheckingMail] = useState(false);

  // Active mail category tab (Phase 4) — maps to 'primary','promotions','social','updates'
  const [activeMailTab, setActiveMailTab] = useState(() => localStorage.getItem('atm_mail_tab') || 'primary');

  // Search operators dropdown (Phase 6)
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);

  // Two-key shortcut sequence state (Phase 3)
  const lastKeyRef = useRef(null);
  const lastKeyTimerRef = useRef(null);

  const [splitMode, setSplitMode] = useState(() => {
    const m = migrateLayoutStorage(); if (m) return m;
    return localStorage.getItem('atm_split_mode') || 'none';
  });
  const [densityMode, setDensityMode] = useState(() => localStorage.getItem('atm_density') || 'default');
  const [conversationView, setConversationView] = useState(() => localStorage.getItem('atm_conversation') !== 'false');
  const [fullPageReaderOpen, setFullPageReaderOpen] = useState(false);
  const [listWidth, setListWidth] = useState(600);

  const listContainerRef = useRef(null);
  const searchInputRef = useRef(null);
  const draftSaveTimeoutRef = useRef(null);
  const saveDraftRef = useRef(null);
  // Holds the current composer session's baseline (initial body) + reply context
  // for content-change detection and From-switch recompute. See composerSession.
  const composerSessionRef = useRef(blankComposerSession());
  const pollingIntervalRef = useRef(null);
  const cascadeTimestampRef = useRef(Date.now());
  const hasAnimatedRef = useRef(false);
  const readerScrollRef = useRef(null);
  const railScrollRef = useRef(null);
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);
  const iframeRef = useRef(null);
  const iframeResizeCleanupRef = useRef(null);

  const [userProfile, setUserProfile] = useState(null);
  const [avatarDropdownOpen, setAvatarDropdownOpen] = useState(false);
  const [removingAccountId, setRemovingAccountId] = useState(null);
  const [billingPlan, setBillingPlan] = useState('free');
  const [billingLoading, setBillingLoading] = useState(false);
  const avatarDropdownRef = useRef(null);
  const avatarButtonRef = useRef(null);

  // ==================== EFFECTS ====================

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('auth')==='error'||window.location.pathname==='/auth/error') { setAuthError('Authentication failed. Please try again.'); window.history.replaceState({},document.title,window.location.pathname); }
    if (p.get('connect')==='error') { setAuthError('Account connection failed. Please try again.'); window.history.replaceState({},document.title,window.location.pathname); }
    if (p.get('upgrade')==='required') { setPaywallOpen(true); window.history.replaceState({},document.title,window.location.pathname); }

    // GA4: trial_started — fires exactly once, the first time a user
    // completes Google OAuth and lands in the app. The localStorage flag
    // prevents re-fire on reload / new tab. Detection is ?auth=success
    // because that's the redirect target on a successful OAuth callback.
    if (p.get('auth') === 'success' && localStorage.getItem('atm_first_session_logged') !== 'true') {
      localStorage.setItem('atm_first_session_logged', 'true');
      localStorage.setItem('atm_first_session_at', new Date().toISOString());
      analytics.event('trial_started', { accounts_connected: 1 });
    }
  }, []);

  // Trial-gating bridge: index.js dispatches atm-access-required whenever
  // any fetch returns 403 { error: 'access_required' }. We surface a
  // BLOCKING paywall — no "maybe later" button, no dismiss-on-overlay-click —
  // because the user genuinely cannot use the app without subscribing.
  useEffect(() => {
    const handler = (e) => {
      setAccessGate(e.detail || { state: 'no_subscription', trialAvailable: true });
      setPaywallOpen(true);
    };
    window.addEventListener('atm-access-required', handler);
    return () => window.removeEventListener('atm-access-required', handler);
  }, []);

  useEffect(() => { const t = setTimeout(()=>setIntroActive(false),900); return ()=>clearTimeout(t); }, []);
  useEffect(() => { localStorage.setItem('atm_split_mode',splitMode); }, [splitMode]);
  useEffect(() => { localStorage.setItem('atm_density',densityMode); }, [densityMode]);
  useEffect(() => { localStorage.setItem('atm_conversation', conversationView); }, [conversationView]);
  useEffect(() => { localStorage.setItem('atm_calview', calsViewMode); }, [calsViewMode]);
  useEffect(() => { localStorage.setItem('atm_signature', includeAtmSignature); }, [includeAtmSignature]);
  useEffect(() => { localStorage.setItem('atm_send_delay', String(sendDelaySeconds)); }, [sendDelaySeconds]);
  useEffect(() => { localStorage.setItem('atm_saved_searches', JSON.stringify(savedSearches)); }, [savedSearches]);
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('atm-theme', theme); }, [theme]);
  const toggleTheme = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), []);

  // Plain (non-undo) toasts auto-dismiss. Undo toasts (executeFn present) are
  // owned by the undo queue, which clears them when the deferred action fires.
  useEffect(() => {
    if (!successToast || successToast.executeFn || successToast.persist) return;
    const delay = successToast.undoFn ? 5000 : 3000;
    const t = setTimeout(() => setSuccessToast(cur => (cur === successToast ? null : cur)), delay);
    return () => clearTimeout(t);
  }, [successToast]);

  useEffect(() => {
    const url = new URL(window.location);
    url.searchParams.set('acct', activeView === 'everything' ? 'all' : activeView);
    window.history.replaceState({}, '', url);
  }, [activeView]);

  useEffect(() => {
    if (connectedAccounts.length > 0 && activeView !== 'everything') {
      if (!connectedAccounts.some(a => a.id === activeView)) setActiveView('everything');
    }
  }, [connectedAccounts, activeView]);

  // Gate fade-out: once data is ready, animate out then unmount
  useEffect(() => {
    if (appReady && gateVisible) {
      gateTimerRef.current = setTimeout(() => setGateVisible(false), 480);
    }
    return () => { if (gateTimerRef.current) clearTimeout(gateTimerRef.current); };
  }, [appReady, gateVisible]);

  // Gate word cycling: MAIL → DOCS → CALS → MAIL → … while loading
  useEffect(() => {
    if (!gateVisible || appReady) return;
    const id = setInterval(() => setGateWordIdx(i => (i + 1) % GATE_WORDS.length), 1400);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateVisible, appReady]); // GATE_WORDS.length is stable (constant array)

  useEffect(() => {
    const el = listContainerRef.current; if (!el) return;
    const obs = new ResizeObserver(e => { for (const en of e) setListWidth(en.contentRect.width); });
    obs.observe(el); return () => obs.disconnect();
  }, []);

  useEffect(() => {
    return () => { if (iframeResizeCleanupRef.current) iframeResizeCleanupRef.current(); };
  }, []);

  useEffect(() => {
    if (!avatarDropdownOpen) return;
    const handler = (e) => {
      if (avatarDropdownRef.current && !avatarDropdownRef.current.contains(e.target) &&
          avatarButtonRef.current && !avatarButtonRef.current.contains(e.target)) {
        setAvatarDropdownOpen(false);
        setRemovingAccountId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [avatarDropdownOpen]);

  useEffect(() => {
    if (!avatarDropdownOpen) return;
    const handler = (e) => {
      if (e.key === 'Escape') { setAvatarDropdownOpen(false); setRemovingAccountId(null); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [avatarDropdownOpen]);

  const handleReaderScroll = useCallback((e) => {
    setReaderCompact(e.target.scrollTop > 60);
  }, []);

  const toggleDocsSort = useCallback((field) => {
    if (docsSortBy === field) setDocsSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setDocsSortBy(field); setDocsSortDir('desc'); }
  }, [docsSortBy]);

  const cycleDensity = useCallback(() => {
    setDensityMode(p => p==='default'?'comfortable':p==='comfortable'?'compact':'default');
  }, []);

  const updateRailFades = useCallback(() => {
    const el = railScrollRef.current;
    if (!el) return;
    setFadeLeft(el.scrollLeft > 4);
    setFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateRailFades();
    const el = railScrollRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => updateRailFades());
    obs.observe(el);
    return () => obs.disconnect();
  }, [connectedAccounts, updateRailFades]);

  // ==================== AUTH & DATA ====================

  // handleLogout is defined as a ref first so useEmail can reference it without
  // creating a circular dependency. The actual implementation is assigned below.
  const handleLogoutRef = useRef(null);
  const handleLogout = useCallback(async (...args) => {
    if (handleLogoutRef.current) return handleLogoutRef.current(...args);
  }, []);

  const {
    emails, setEmails,
    selectedEmail, setSelectedEmail,
    selectedThread, setSelectedThread,
    emailBodies, setEmailBodies,
    emailHeaders, setEmailHeaders,
    emailAttachments,
    isLoadingEmails,
    isLoadingBody,
    isLoadingThread,
    emailLoadError,
    editMode, setEditMode,
    selectedIds,
    batchWorking,
    starredOverrides,
    snoozedEmails,
    snoozeDropdownEmailId, setSnoozeDropdownEmailId,
    collapsedMsgIds, setCollapsedMsgIds,
    threadExpanded, setThreadExpanded,
    expandedBodies, setExpandedBodies,
    filteredEmails,
    allEmails,
    categoryCounts,
    loadEmailsForAccount,
    loadEmailDetails,
    downloadAttachment,
    loadThread,
    trashEmail, archiveEmail, starEmail,
    spamEmail, markRead, markUnread,
    searchAllAccounts, batchAction,
    clearSelection, toggleSelectId, selectRange, selectAllVisible,
    snoozeEmail, getSnoozeOptions, syncSnoozed,
    navigatePrev, navigateNext, onSelectEmail,
  } = useEmail({
    connectedAccounts,
    activeView,
    activeCategory,
    searchQuery,
    conversationView,
    sendDelaySeconds,
    setSuccessToast: emitToast,
    setError,
    setIsAuthed,
    handleLogout,
    splitMode,
    setFullPageReaderOpen,
    setShowMetadata,
    setReaderCompact,
  });

  // Aggregate contacts across every connected account for the compose
  // recipient autocomplete. Backend caches 30 min per account; this hook
  // refetches when the connected accounts list changes (add / disconnect).
  const { contacts } = useContacts(connectedAccounts);

  // Per-account Gmail signatures, fetched on mount (backend cached 24h).
  // Used by openCompose to seed the body with the right signature based
  // on which connected account is sending. signatures[accountId] → HTML.
  const signatures = useSignatures(connectedAccounts);

  // Now assign the real handleLogout implementation
  useEffect(() => {
    handleLogoutRef.current = async () => {
      try { await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch(e) {}
      setIsAuthed(false); setConnectedAccounts([]); setEmails({}); setDocs({}); setEvents({}); setSelectedEmail(null);
      setSelectedThread(null); setEmailBodies({}); setEmailHeaders({});
      setEditMode(false); setAvatarDropdownOpen(false); setUserProfile(null); setBillingPlan('free');
    };
  });

  // Close snooze dropdown on outside click or Escape
  // Must be declared AFTER useEmail() destructures snoozeDropdownEmailId (TDZ-safe).
  useEffect(() => {
    if (!snoozeDropdownEmailId) return;
    const handler = () => setSnoozeDropdownEmailId(null);
    const keyHandler = (e) => { if (e.key === 'Escape') setSnoozeDropdownEmailId(null); };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    document.addEventListener('keydown', keyHandler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler); };
  }, [snoozeDropdownEmailId, setSnoozeDropdownEmailId]);

  const loadUserProfile = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
      if (r.ok) { const d = await r.json(); setUserProfile(d.user); }
    } catch (e) { console.error('Failed to load user profile:', e); }
  }, []);

  const loadBillingStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/billing/status`, { credentials: 'include' });
      if (r.ok) { const d = await r.json(); setBillingPlan(d.plan || 'free'); }
    } catch (e) { console.error('Failed to load billing status:', e); }
  }, []);

  const handleRemoveAccount = useCallback(async (accountId) => {
    if (removingAccountId !== accountId) { setRemovingAccountId(accountId); return; }
    try {
      const r = await fetch(`${API_BASE}/accounts/${accountId}`, { method: 'DELETE', credentials: 'include' });
      if (r.ok) {
        const updated = connectedAccounts.filter(a => a.id !== accountId);
        setConnectedAccounts(updated);
        if (activeView === accountId) setActiveView('everything');
        setRemovingAccountId(null);
      } else {
        const d = await r.json();
        setError(d.error || 'Failed to remove account');
        setRemovingAccountId(null);
      }
    } catch (e) { console.error('Remove account error:', e); setError('Failed to remove account'); setRemovingAccountId(null); }
  }, [removingAccountId, connectedAccounts, activeView]);

  // P1.17 — only redirect to a Stripe-controlled host. Server-controlled
  // value should always be one of these, but if the response is ever tampered
  // with (compromised backend, MITM on a custom domain, dev who accidentally
  // hardcodes a different URL) we refuse instead of opening an arbitrary URL.
  const STRIPE_REDIRECT_RE = /^https:\/\/(checkout|billing)\.stripe\.com\//i;
  const safeStripeRedirect = (url) => {
    if (!url || typeof url !== 'string') return false;
    if (!STRIPE_REDIRECT_RE.test(url)) {
      console.error('Refusing non-Stripe billing redirect:', url);
      setError('Billing redirect blocked.');
      return false;
    }
    window.location.href = url;
    return true;
  };

  const handleUpgrade = useCallback(async (interval = 'monthly', location = 'unknown') => {
    // GA4: upgrade_clicked — fired BEFORE the network call so we capture
    // intent regardless of whether checkout succeeds (e.g., 409 already
    // subscribed, or a server outage that prevents redirect).
    analytics.event('upgrade_clicked', { location, plan: interval });

    setBillingLoading(true);
    try {
      // Forward first-touch UTM/referrer data captured by the marketing
      // site cookie so the resulting Stripe subscription carries it in
      // metadata. attributionPayload() returns {} when no cookie is set,
      // so this is safe even for users who came in via direct/organic.
      // ga_client_id stitches the server-side trial_converted MP event
      // to the same GA session the client was tracking.
      const ga_client_id = analytics.readGaClientId();
      const r = await fetch(`${API_BASE}/billing/checkout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interval, ga_client_id, ...attributionPayload() }) });
      if (r.ok) { const d = await r.json(); if (d.url) safeStripeRedirect(d.url); }
      else if (r.status === 409) {
        // Backend refused because the user is already subscribed — open the
        // portal instead so they can manage/upgrade rather than double-charge.
        const portal = await fetch(`${API_BASE}/billing/portal`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
        if (portal.ok) { const d = await portal.json(); if (d.url) safeStripeRedirect(d.url); }
        else { setError('You already have an active subscription.'); }
      }
      else { const d = await r.json(); setError(d.error || 'Failed to start checkout'); }
    } catch (e) { console.error('Checkout error:', e); setError('Failed to start checkout'); }
    finally { setBillingLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManageBilling = useCallback(async () => {
    setBillingLoading(true);
    try {
      const r = await fetch(`${API_BASE}/billing/portal`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      if (r.ok) { const d = await r.json(); if (d.url) safeStripeRedirect(d.url); }
      else { const d = await r.json(); setError(d.error || 'Failed to open billing portal'); }
    } catch (e) { console.error('Portal error:', e); setError('Failed to open billing portal'); }
    finally { setBillingLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const evFilteredEmails = useMemo(() => {
    let pool = allEmails;
    if (activeView !== 'everything') pool = pool.filter(e => e.accountId === activeView);
    if (evMailFilter === 'unread') return pool.filter(e => !e.isRead);
    return pool;
  }, [allEmails, evMailFilter, activeView]);

  const allDocs = useMemo(() => {
    const all = [];
    connectedAccounts.forEach(a => {
      const ad = docs[a.id] || [];
      all.push(...ad.map(d => ({ ...d, accountId: a.id })));
    });
    return all.sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [connectedAccounts, docs]);

  const allEvents = useMemo(() => {
    const all = [];
    connectedAccounts.forEach(a => {
      const ae = events[a.id] || [];
      all.push(...ae.map(e => ({ ...e, accountId: a.id })));
    });
    return all.sort((a, b) => new Date(a.startISO || 0) - new Date(b.startISO || 0));
  }, [connectedAccounts, events]);

  const filteredAllEvents = useMemo(() => {
    if (activeView === 'everything') return allEvents;
    return allEvents.filter(e => e.accountId === activeView);
  }, [allEvents, activeView]);

  // Generate day columns for calendar grid views
  const calGridDays = useMemo(() => {
    const today = new Date();
    const anchor = new Date(calDate);
    let startDate, numDays;

    if (calsViewMode === 'day') {
      startDate = new Date(anchor); startDate.setHours(0, 0, 0, 0);
      numDays = 1;
    } else if (calsViewMode === '4day') {
      startDate = new Date(anchor); startDate.setHours(0, 0, 0, 0);
      numDays = 4;
    } else if (calsViewMode === 'week') {
      const dow = anchor.getDay();
      startDate = new Date(anchor);
      startDate.setDate(anchor.getDate() - ((dow + 6) % 7));
      startDate.setHours(0, 0, 0, 0);
      numDays = 7;
    } else {
      // month/year/schedule use list, not grid
      const dow = anchor.getDay();
      startDate = new Date(anchor);
      startDate.setDate(anchor.getDate() - ((dow + 6) % 7));
      startDate.setHours(0, 0, 0, 0);
      numDays = 7;
    }

    const days = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const dayEnd = new Date(d);
      dayEnd.setHours(23, 59, 59, 999);

      const dayEvents = filteredAllEvents.filter(ev => {
        const evDate = parseEventStart(ev);
        return evDate >= d && evDate <= dayEnd;
      });

      days.push({
        date: d,
        label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
        shortLabel: d.toLocaleDateString(undefined, { weekday: 'short' }),
        dayNum: d.getDate(),
        isToday: d.toDateString() === today.toDateString(),
        events: dayEvents,
      });
    }
    return days;
  }, [filteredAllEvents, calDate, calsViewMode]);

  // Generate month grid for month view (6 weeks)
  const calMonthDays = useMemo(() => {
    const today = new Date();
    const anchor = new Date(calDate);
    const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const startDow = firstOfMonth.getDay();
    const startDate = new Date(firstOfMonth);
    startDate.setDate(1 - ((startDow + 6) % 7));
    startDate.setHours(0, 0, 0, 0);

    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + w * 7 + d);
        const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
        const dayEvents = filteredAllEvents.filter(ev => {
          const evDate = parseEventStart(ev);
          return evDate >= date && evDate <= dayEnd;
        });
        week.push({
          date,
          dayNum: date.getDate(),
          isToday: date.toDateString() === today.toDateString(),
          isCurrentMonth: date.getMonth() === anchor.getMonth(),
          events: dayEvents,
        });
      }
      weeks.push(week);
    }
    return weeks;
  }, [filteredAllEvents, calDate]);

  // Calendar navigation
  const calNavigate = useCallback((dir) => {
    setCalDate(prev => {
      const d = new Date(prev);
      if (calsViewMode === 'day') d.setDate(d.getDate() + dir);
      else if (calsViewMode === '4day') d.setDate(d.getDate() + dir * 4);
      else if (calsViewMode === 'week') d.setDate(d.getDate() + dir * 7);
      else if (calsViewMode === 'month') d.setMonth(d.getMonth() + dir);
      else if (calsViewMode === 'year') d.setFullYear(d.getFullYear() + dir);
      else d.setDate(d.getDate() + dir * 7);
      return d;
    });
  }, [calsViewMode]);

  const calTitle = useMemo(() => {
    const d = new Date(calDate);
    if (calsViewMode === 'day') return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (calsViewMode === 'month' || calsViewMode === 'year') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    // week, 4day, schedule
    const end = new Date(d);
    end.setDate(d.getDate() + (calsViewMode === '4day' ? 3 : 6));
    if (d.getMonth() === end.getMonth()) return `${d.toLocaleDateString(undefined, { month: 'long' })} ${d.getDate()} – ${end.getDate()}, ${d.getFullYear()}`;
    return `${d.toLocaleDateString(undefined, { month: 'short' })} ${d.getDate()} – ${end.toLocaleDateString(undefined, { month: 'short' })} ${end.getDate()}, ${d.getFullYear()}`;
  }, [calDate, calsViewMode]);

  const filteredDocs = useMemo(() => {
    let pool = allDocs;
    if (activeView !== 'everything') pool = pool.filter(d => d.accountId === activeView);
    if (docsCategory === 'shared') pool = pool.filter(d => d.shared);
    else if (docsCategory === 'starred') pool = pool.filter(d => d.starred);
    else if (docsCategory === 'trash') pool = [];

    // Search filter
    if (docsSearchQuery.trim()) {
      const q = docsSearchQuery.toLowerCase();
      pool = pool.filter(d =>
        (d.title || '').toLowerCase().includes(q) ||
        (d.owner || '').toLowerCase().includes(q) ||
        (d.mimeType || '').toLowerCase().includes(q)
      );
    }

    // Sort
    pool = [...pool].sort((a, b) => {
      let cmp = 0;
      if (docsSortBy === 'name') cmp = (a.title || '').localeCompare(b.title || '');
      else if (docsSortBy === 'type') cmp = (a.mimeType || '').localeCompare(b.mimeType || '');
      else if (docsSortBy === 'lastEdited') cmp = new Date(b.lastEdited || 0) - new Date(a.lastEdited || 0);
      else cmp = new Date(b.date || 0) - new Date(a.date || 0);
      return docsSortDir === 'asc' ? -cmp : cmp;
    });

    return pool;
  }, [docsCategory, allDocs, activeView, docsSearchQuery, docsSortBy, docsSortDir]);

  const evFilteredDocs = useMemo(() => {
    let pool = allDocs;
    if (activeView !== 'everything') pool = pool.filter(d => d.accountId === activeView);
    if (evDocsFilter === 'shared') return pool.filter(d => d.shared);
    return pool;
  }, [evDocsFilter, allDocs, activeView]);

  const evFilteredEvents = useMemo(() => {
    let pool = allEvents;
    if (activeView !== 'everything') pool = pool.filter(e => e.accountId === activeView);
    if (evCalsFilter === 'week') return pool;
    return pool.filter(e => e.day === 'Today' || e.day === 'Tomorrow');
  }, [evCalsFilter, allEvents, activeView]);

  const mobileUnifiedFeed = useMemo(() => {
    const items = [];
    evFilteredEmails.slice(0, 50).forEach(e => items.push({ type: 'email', data: e, time: new Date(e.date).getTime() }));
    evFilteredDocs.slice(0, 30).forEach(d => items.push({ type: 'doc', data: d, time: new Date(d.lastEdited || d.date).getTime() }));
    filteredAllEvents.slice(0, 30).forEach(ev => items.push({ type: 'event', data: ev, time: new Date(ev.startISO || 0).getTime() }));
    return items.sort((a, b) => b.time - a.time);
  }, [evFilteredEmails, evFilteredDocs, filteredAllEvents]);

  const hasDocsError = Object.values(docsErrors).some(Boolean);
  const hasEventsError = Object.values(eventsErrors).some(Boolean);
  const anyHasDocs = connectedAccounts.some(a => a.granted_scopes?.includes('docs'));
  const anyHasCals = connectedAccounts.some(a => a.granted_scopes?.includes('cals'));


  const loadDocsForAccount = useCallback(async (accountId, filter = null) => {
    try {
      const qs = filter ? `?filter=${filter}` : '';
      const r = await fetch(`${API_BASE}/docs/${accountId}${qs}`, { credentials: 'include' });
      // Dispatch typed-error CustomEvents (token_revoked / scope_upgrade)
      // for the global App.js listeners. Falls through to inline error
      // state for legacy `missing_scope` / `invalid_token` shapes — both
      // contracts are still emitted by some routes during the migration.
      const accountForEvent = { id: accountId };
      if (await maybeHandleApiError(r, accountForEvent)) {
        setDocsErrors(p => ({ ...p, [accountId]: 'scope' }));
        return;
      }
      if (r.ok) {
        const d = await r.json();
        setDocs(p => ({ ...p, [accountId]: d.docs || [] }));
        setDocsErrors(p => ({ ...p, [accountId]: null }));
      } else if (r.status === 403 || r.status === 401) {
        const body = await r.json().catch(() => ({}));
        const errType = body.error === 'invalid_token' ? 'token' : 'scope';
        setDocsErrors(p => ({ ...p, [accountId]: errType }));
      } else { console.error('Docs load failed:', r.status); }
    } catch (err) { console.error('Error loading docs:', err); setDocsErrors(p => ({ ...p, [accountId]: 'network' })); }
  }, []);

  const loadEventsForAccount = useCallback(async (accountId, range = null) => {
    try {
      const qs = range ? `?range=${range}` : '';
      const r = await fetch(`${API_BASE}/cals/${accountId}/events${qs}`, { credentials: 'include' });
      const accountForEvent = { id: accountId };
      if (await maybeHandleApiError(r, accountForEvent)) {
        setEventsErrors(p => ({ ...p, [accountId]: 'scope' }));
        return;
      }
      if (r.ok) {
        const d = await r.json();
        setEvents(p => ({ ...p, [accountId]: d.events || [] }));
        setEventsErrors(p => ({ ...p, [accountId]: null }));
      } else if (r.status === 403 || r.status === 401) {
        const body = await r.json().catch(() => ({}));
        const errType = body.error === 'invalid_token' ? 'token' : 'scope';
        setEventsErrors(p => ({ ...p, [accountId]: errType }));
      } else { console.error('Events load failed:', r.status); }
    } catch (err) { console.error('Error loading events:', err); setEventsErrors(p => ({ ...p, [accountId]: 'network' })); }
  }, []);

  // syncScheduledSends: called once on boot after accounts load.
  // Fetches pending sends from Supabase, merges with localStorage
  // (Supabase wins), and backfills any localStorage-only entries.
  // Fails silently — localStorage continues to work if the request fails.
  const syncScheduledSends = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/scheduled-sends?status=pending`, { credentials: 'include' });
      if (!r.ok) return;
      const { sends: dbSends } = await r.json();

      const local = JSON.parse(localStorage.getItem('atm_scheduled_sends') || '[]');
      const localOnly = local.filter(s => !s.id);

      // Backfill: local entries with no DB id → fire-and-forget POSTs
      localOnly.forEach(s => {
        fetch(`${API_BASE}/scheduled-sends`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: { to: s.to, cc: s.cc, bcc: s.bcc, subject: s.subject, body: s.body, accountId: s.accountId },
            sendAt: s.scheduledFor,
          }),
        }).then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.id) {
              // Tag the local entry with its new DB id
              setScheduledSends(prev => prev.map(x =>
                (!x.id && x.scheduledFor === s.scheduledFor && x.to === s.to)
                  ? { ...x, id: data.id }
                  : x
              ));
            }
          })
          .catch(() => {});
      });

      // Merge: DB is authoritative; keep any local-only entries too
      setScheduledSends([...dbSends, ...localOnly]);
    } catch (err) {
      console.error('syncScheduledSends error:', err);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/accounts`,{credentials:'include'});
      if (r.ok) {
        setIsAuthed(true); const d=await r.json(); const accs=d.accounts||[];
        setConnectedAccounts(accs);
        if (!hasAnimatedRef.current) {
          setCascadeKey(k => k + 1);
          cascadeTimestampRef.current = Date.now();
          hasAnimatedRef.current = true;
        }
        setIsLoadingDocs(true); setIsLoadingEvents(true);
        setDocsErrors({}); setEventsErrors({});
        const docsAccs = accs.filter(a => a.granted_scopes?.includes('docs'));
        const calsAccs = accs.filter(a => a.granted_scopes?.includes('cals'));
        const docPromises = docsAccs.map(a => loadDocsForAccount(a.id));
        const eventPromises = calsAccs.map(a => loadEventsForAccount(a.id));
        // Initial cold load: only fetch 'primary' per account. Other
        // categories (social/promotions/sent/drafts/trash) are loaded
        // lazily when the user clicks them — the activeCategory effect
        // below triggers a refresh. Drops cold-load fan-out from 6×N
        // categories to 1×N (~9s → ~1.5s on 4 accounts).
        const emailPromises = accs.map(a => loadEmailsForAccount(a.id, 'primary'));
        Promise.all(docPromises).then(() => setIsLoadingDocs(false));
        Promise.all(eventPromises).then(() => setIsLoadingEvents(false));
        if (docsAccs.length === 0) setIsLoadingDocs(false);
        if (calsAccs.length === 0) setIsLoadingEvents(false);

        // Instant-paint: if we have a cached primary list for ANY account,
        // reveal the UI now. The network refresh (above) will replace
        // the cached list as it lands. This is the killer "Gmail-instant"
        // moment — cold reload paints the inbox in <100ms instead of
        // waiting on the network round-trip.
        if (accs.length > 0) {
          import('./utils/emailCache').then(({ hydrateLists }) => {
            hydrateLists(accs.map(a => ({ accountId: a.id, category: 'primary' }))).then((hydrated) => {
              if (Object.keys(hydrated).length > 0) {
                setAppReady(true);
              }
            }).catch(() => {});
          });
          // Also reveal once the first network batch lands as a fallback
          // (no cache, brand-new install).
          Promise.all(emailPromises).then(() => setAppReady(true)).catch(() => setAppReady(true));
        } else {
          setAppReady(true);
        }
        loadUserProfile();
        loadBillingStatus();
        syncSnoozed();
        syncScheduledSends();
      } else if (r.status===401) {
        handleLogout();
      } else { setConnectedAccounts([]); }
    } catch(err) { console.error('Error loading accounts:', err); setError('Failed to load accounts'); }
  }, [loadEmailsForAccount, loadDocsForAccount, loadEventsForAccount, loadUserProfile, loadBillingStatus, syncSnoozed, syncScheduledSends]);

  const refreshEmails = useCallback(async () => {
    if (!isAuthed||connectedAccounts.length===0) return;
    setIsCheckingMail(true);
    try {
      // Fan out across accounts in parallel. Sequential awaits multiplied
      // a 1.5s/account fetch into 6s+ for 4 accounts.
      if (activeView==='everything') {
        await Promise.all(connectedAccounts.map(a => loadEmailsForAccount(a.id, activeCategory)));
      } else {
        const aa = connectedAccounts.find(a => a.id === activeView);
        if (aa) await loadEmailsForAccount(aa.id, activeCategory);
      }
    } catch(err) { console.error('Error refreshing:', err); }
    finally { setIsCheckingMail(false); }
  }, [isAuthed, connectedAccounts, activeView, activeCategory, loadEmailsForAccount]);

  useEffect(() => {
    if (!isAuthed||connectedAccounts.length===0) return;
    refreshEmails();
    pollingIntervalRef.current = setInterval(()=>refreshEmails(), 30000);
    const h=()=>{ if(document.hidden){if(pollingIntervalRef.current){clearInterval(pollingIntervalRef.current);pollingIntervalRef.current=null;}}else{if(!pollingIntervalRef.current){refreshEmails();pollingIntervalRef.current=setInterval(()=>refreshEmails(),30000);}} };
    document.addEventListener('visibilitychange',h);
    return ()=>{if(pollingIntervalRef.current)clearInterval(pollingIntervalRef.current);document.removeEventListener('visibilitychange',h);};
  }, [isAuthed, connectedAccounts.length, refreshEmails]);

  // GA4: account_connected — fires when the user adds an additional Google
  // account (count grows from N≥1 to N+1). The first-account case (0→1)
  // is covered by trial_started, so we explicitly skip it here. Tracks the
  // previous count in a ref so we can detect transitions across renders.
  const prevAccountCountRef = useRef(0);
  useEffect(() => {
    const curr = connectedAccounts.length;
    const prev = prevAccountCountRef.current;
    if (prev >= 1 && curr > prev) {
      analytics.event('account_connected', { total_accounts: curr });
    }
    prevAccountCountRef.current = curr;
  }, [connectedAccounts.length]);

  const handleFileSelect = useCallback((e)=>{
    const picked = Array.from(e.target.files || []);
    setComposeAttachments(prev => {
      const { accepted, rejected } = validateFiles(picked, prev);
      if (rejected.length) setComposeError(rejected.map(r => r.error).join(' · '));
      else setComposeError(null);
      return accepted.length ? [...prev, ...accepted] : prev;
    });
    // allow re-picking the same file
    if (e.target) e.target.value = '';
  }, []);
  const removeAttachment = useCallback((i)=>{setComposeAttachments(p=>p.filter((_,j)=>j!==i));}, []);

  useEffect(()=>{loadAccounts();}, [loadAccounts]);

  // Keep loadAccountsRef in sync so the popup-message listener (defined
  // earlier — before loadAccounts existed in scope) can fire it without
  // pulling it into deps and re-registering the message listener every
  // time loadAccounts changes identity.
  useEffect(() => { loadAccountsRef.current = loadAccounts; }, [loadAccounts]);

  // P1.12 — post-upgrade detection. The backend's /auth/google/callback
  // redirects to <redirectAfter>?upgraded=<group> after a successful scope
  // upgrade. We detect that here, dismiss any open prompt, refresh the
  // accounts list (so granted_scopes reflects the new grant), and clean
  // the URL so a refresh doesn't re-trigger.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const upgraded = params.get('upgraded');
    const upgradeError = params.get('upgrade_error');
    if (upgraded || upgradeError) {
      if (upgraded) {
        loadAccounts();
        setScopeUpgrade(null);
      }
      if (upgradeError) {
        // Surface incomplete-grant or db-write errors. The user unticked a
        // box on the consent screen, or the backend failed to persist.
        // Re-prompt them so they can retry without unticking.
        const group = params.get('group');
        if (upgradeError === 'incomplete' && group) {
          // Reopen the prompt for the same group so they can try again.
          // The accountId is preserved in localStorage by whoever opened
          // the prompt initially; if missing, fall back to first account.
          // (In practice the redirect_after URL preserves this.)
        }
        console.warn('[scope upgrade] error:', upgradeError);
      }
      // Clean the URL so refresh doesn't re-trigger.
      params.delete('upgraded');
      params.delete('upgrade_error');
      params.delete('group');
      const newSearch = params.toString();
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + (newSearch ? '?' + newSearch : '')
      );
    }
    // Run once on mount (loadAccounts identity is stable enough — we
    // re-fetch defensively).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global event listener: any component (or fetch wrapper) can dispatch
  // an 'atm-scope-upgrade-required' CustomEvent with detail { group,
  // accountId, accountEmail } to surface the prompt.
  useEffect(() => {
    function handle(e) {
      if (e?.detail?.group && e?.detail?.accountId) {
        setScopeUpgrade({
          group: e.detail.group,
          accountId: e.detail.accountId,
          accountEmail: e.detail.accountEmail,
        });
      }
    }
    window.addEventListener('atm-scope-upgrade-required', handle);
    return () => window.removeEventListener('atm-scope-upgrade-required', handle);
  }, []);

  // Token-revoked listener — paired with the 401 contract from the
  // backend. The user revoked our app from myaccount.google.com (or a
  // password reset invalidated tokens). The only recovery is a re-link;
  // surface a one-shot toast instead of a blocking modal so it doesn't
  // dogpile if multiple accounts are dead at once.
  const [reconnectToastSeen, setReconnectToastSeen] = useState(() => new Set());
  useEffect(() => {
    function handle(e) {
      const accountId = e?.detail?.accountId;
      const accountEmail = e?.detail?.accountEmail;
      if (!accountId) return;
      // Don't toast the same account twice in a session — a single revoked
      // token can fan out across every endpoint that touches Gmail.
      // Passive informational toast (no executeFn so it auto-dismisses
      // without surprising the user with a popup). User re-connects
      // manually from the avatar dropdown when they're ready.
      setReconnectToastSeen(prev => {
        if (prev.has(accountId)) return prev;
        const next = new Set(prev);
        next.add(accountId);
        setSuccessToast({
          message: `${accountEmail || 'An account'} needs to be re-connected. Use Add account in the avatar menu.`,
        });
        return next;
      });
    }
    window.addEventListener('atm-account-reconnect-required', handle);
    return () => window.removeEventListener('atm-account-reconnect-required', handle);
  }, []);

  const handleGoogleLogin = useCallback(()=>{window.location.href=`${API_BASE}/auth/google`;}, []);

  // Open Google's OAuth in a popup window so the main app never navigates
  // away. The backend renders a self-closing HTML page on success that
  // postMessages our origin; the listener below picks it up and reloads
  // the account list. Falls back to full-page redirect if the popup is
  // blocked (Safari can block window.open from inside async callbacks).
  const handleAddAccount = useCallback(() => {
    const url = `${API_BASE}/accounts/connect?popup=1`;
    const w = 520, h = 700;
    const left = (window.screen.availWidth - w) / 2;
    const top = (window.screen.availHeight - h) / 2;
    const popup = window.open(url, 'atm-add-account', `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`);
    if (!popup) {
      // Popup blocked — fall back to full-page redirect (no popup flag)
      window.location.href = `${API_BASE}/accounts/connect`;
    }
  }, []);

  // Listen for the popup's "I linked successfully" message and reload
  // the account list. Origin-checked: only accept from the same origin
  // we're served from (or the API origin in case of cross-origin setup).
  useEffect(() => {
    const apiOrigin = (() => {
      try { return new URL(API_BASE).origin; } catch { return null; }
    })();
    const onMessage = (e) => {
      if (e.origin !== window.location.origin && e.origin !== apiOrigin) return;
      if (e.data?.type === 'atm-account-linked') {
        // Refresh the account list — loadAccounts is defined below; access
        // through a ref to avoid pulling it into deps and re-binding.
        loadAccountsRef.current?.();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const loadAccountsRef = useRef(null);

  const openEventEdit = useCallback((ev) => {
    setEventEditFields({
      summary: ev.title || '',
      description: ev.description || '',
      location: ev.meta || '',
      date: ev.startISO ? ev.startISO.split('T')[0] : '',
      startTime: ev.startISO && ev.startISO.includes('T') ? ev.startISO.split('T')[1]?.substring(0, 5) : '',
      endTime: ev.endISO && ev.endISO.includes('T') ? ev.endISO.split('T')[1]?.substring(0, 5) : '',
    });
    setEventEditError(null);
    setEventEditSaving(false);
    setEventEditOpen(true);
  }, []);

  const closeEventEdit = useCallback(() => {
    setEventEditOpen(false);
    setEventEditError(null);
  }, []);

  const saveEventEdit = useCallback(async () => {
    if (!selectedEvent?.accountId || !selectedEvent?.id) return;
    setEventEditSaving(true);
    setEventEditError(null);

    const buildDatetime = (date, time) => {
      if (!date || !time) return undefined;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return { dateTime: `${date}T${time}:00`, timeZone: tz };
    };

    const patch = {};
    if (eventEditFields.summary !== undefined) patch.summary = eventEditFields.summary;
    if (eventEditFields.description !== undefined) patch.description = eventEditFields.description;
    if (eventEditFields.location !== undefined) patch.location = eventEditFields.location;
    const startDT = buildDatetime(eventEditFields.date, eventEditFields.startTime);
    const endDT = buildDatetime(eventEditFields.date, eventEditFields.endTime);
    if (startDT) patch.start = startDT;
    if (endDT) patch.end = endDT;

    const isNew = selectedEvent.id === 'new';

    if (!isNew) {
      const prevEvents = { ...events };
      setEvents(prev => {
        const accountEvents = prev[selectedEvent.accountId] || [];
        return { ...prev, [selectedEvent.accountId]: accountEvents.map(e => e.id === selectedEvent.id ? { ...e, title: eventEditFields.summary || e.title, meta: eventEditFields.location || e.meta } : e) };
      });
      setSelectedEvent(prev => prev ? { ...prev, title: eventEditFields.summary || prev.title, meta: eventEditFields.location || prev.meta } : prev);

      try {
        if (selectedEvent.calendarId) patch.calendarId = selectedEvent.calendarId;
        const r = await fetch(`${API_BASE}/cals/${selectedEvent.accountId}/events/${selectedEvent.id}`, {
          method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        });
        if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error(body.message || body.error || 'Update failed'); }
        setEventEditOpen(false);
        loadEventsForAccount(selectedEvent.accountId);
      } catch (err) {
        setEvents(prevEvents);
        setEventEditError(err.message || 'Failed to save changes');
      } finally { setEventEditSaving(false); }
    } else {
      try {
        const r = await fetch(`${API_BASE}/cals/${selectedEvent.accountId}/events`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        });
        if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error(body.message || body.error || 'Create failed'); }
        setEventEditOpen(false);
        setSelectedEvent(null);
        loadEventsForAccount(selectedEvent.accountId);
      } catch (err) {
        setEventEditError(err.message || 'Failed to create event');
      } finally { setEventEditSaving(false); }
    }
  }, [selectedEvent, eventEditFields, events, loadEventsForAccount]);

  const loadDocPreview = useCallback(async (doc, opts = {}) => {
    if (!doc?.id || !doc?.accountId) return;
    const silent = opts.silent === true;
    if (!silent) { setDocPreviewLoading(true); setDocPreview(null); }
    try {
      const r = await fetch(`${API_BASE}/docs/${doc.accountId}/${doc.id}/preview`, { credentials: 'include' });
      if (!silent) {
        if (r.ok) { setDocPreview(await r.json()); } else { setDocPreview({ type: 'none' }); }
      }
    } catch { if (!silent) setDocPreview({ type: 'none' }); }
    finally { if (!silent) setDocPreviewLoading(false); }
  }, []);

  const openSlideOverEmail = useCallback((email, index) => {
    setSlideOverDoc(null); setDocPreview(null); setSlideOverEmail(email);
    setSlideOverIndex(typeof index === 'number' ? index : null);
    document.body.style.overflow = 'hidden'; loadEmailDetails(email);
  }, [loadEmailDetails]);

  const openSlideOverDoc = useCallback((doc, index) => {
    setSlideOverEmail(null); setSlideOverDoc(doc);
    setSlideOverIndex(typeof index === 'number' ? index : null);
    document.body.style.overflow = 'hidden'; loadDocPreview(doc);
  }, [loadDocPreview]);

  const closeSlideOver = useCallback(() => {
    setSlideOverEmail(null); setSlideOverDoc(null); setSlideOverIndex(null); setDocPreview(null);
    document.body.style.overflow = '';
  }, []);

  useEffect(() => {
    if (!slideOverEmail && !slideOverDoc) return;
    const items = slideOverEmail ? evFilteredEmails.slice(0, 50) : evFilteredDocs;
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === 'Escape') { closeSlideOver(); return; }
      if (slideOverIndex === null || !items.length) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(slideOverIndex + 1, items.length - 1);
        if (next !== slideOverIndex) {
          setSlideOverIndex(next);
          if (slideOverEmail) { setSlideOverEmail(items[next]); loadEmailDetails(items[next]); }
          else { setSlideOverDoc(items[next]); loadDocPreview(items[next]); }
        }
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(slideOverIndex - 1, 0);
        if (prev !== slideOverIndex) {
          setSlideOverIndex(prev);
          if (slideOverEmail) { setSlideOverEmail(items[prev]); loadEmailDetails(items[prev]); }
          else { setSlideOverDoc(items[prev]); loadDocPreview(items[prev]); }
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [slideOverEmail, slideOverDoc, slideOverIndex, evFilteredEmails, evFilteredDocs, closeSlideOver, loadEmailDetails, loadDocPreview]);

  // Auto-save the draft on changes. Two cadences:
  //   - First save is fast (1.2 s after compose opens or after the first
  //     keystroke) so the user sees "Saved" within ~1 turn-around — the
  //     "creating a new message should immediately save to drafts" ask.
  //   - Subsequent saves debounce to 1.5 s of typing-stop so we don't
  //     thrash the backend on every keystroke during a long compose.
  // composeDraftId is the indicator that we've saved at least once;
  // when null → use fast first-save delay; when set → use steady debounce.
  useEffect(() => {
    if (!composeOpen) return;
    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    const delay = composeDraftId ? 1500 : 1200;
    draftSaveTimeoutRef.current = setTimeout(() => {
      if (saveDraftRef.current) {
        setDraftSavingState('saving');
        Promise.resolve(saveDraftRef.current())
          .then((res) => {
            const status = res?.status || 'failed';
            // Truthful indicator (invariant 4): only report Saved on a real
            // success; a non-OK / network / malformed result shows Couldn't save.
            if (status === 'saved') { setDraftSavingState('saved'); setDraftLastSavedAt(Date.now()); }
            else if (status === 'failed') { setDraftSavingState('failed'); }
            else { setDraftSavingState('idle'); }
          })
          .catch(() => setDraftSavingState('failed'));
      }
    }, delay);
    return () => { if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeOpen, composeTo, composeCc, composeBcc, composeSubject, composeBody]);

  // Reset save-state indicators when compose closes/opens. Without this,
  // a previous compose's "Saved 3 min ago" string could briefly flash on
  // the next compose modal before the first auto-save fires.
  useEffect(() => {
    if (!composeOpen) {
      setDraftSavingState('idle');
      setDraftLastSavedAt(null);
    }
  }, [composeOpen]);

  // ==================== ACTIONS ====================

  const switchAccount = useCallback((viewId) => {
    setActiveView(viewId);
    setSelectedEmail(null); setSelectedThread(null);
    setEditMode(false); clearSelection(); setFullPageReaderOpen(false);
  }, [clearSelection]);

  // Ref holder for callbacks that are defined later in the component
  // (avoids temporal dead zone issues in the keyboard handler useEffect)
  const shortcutsRef = useRef({});

  useEffect(() => {
    const onKey = (e) => {
      // Cmd+K / Ctrl+K — open command palette (works from anywhere, including inputs)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(p => !p);
        setPaletteQuery('');
        setPaletteIndex(0);
        return;
      }
      // j/k navigation — Gmail style
      if (!composeOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        const inInput = tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.getAttribute?.('contenteditable') === 'true';
        if (!inInput && activeModule === 'mail') {
          const s = shortcutsRef.current;
          const readerOpen = selectedEmail && (splitMode !== 'none' || fullPageReaderOpen);
          const focusedEmail = focusedKey ? filteredEmails.find(x => emailKey(x) === focusedKey) : null;
          const scrollRowIntoView = (idx) => requestAnimationFrame(() => { const row = document.querySelector(`.email-item:nth-child(${idx + 1})`); if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });

          // j/k — move the cursor (or navigate the reader). When no reader is
          // open this moves focus ONLY: it never opens a message or marks it
          // read (invariant: cursor movement is not a read).
          if (e.key === 'j' || e.key === 'k') {
            e.preventDefault();
            const dir = e.key === 'j' ? 1 : -1;
            if (readerOpen) { if (dir === 1) navigateNext(); else navigatePrev(); return; }
            const anchor = focusedKey
              ? filteredEmails.findIndex(x => emailKey(x) === focusedKey)
              : (selectedEmail ? filteredEmails.findIndex(x => sameMailItem(x, selectedEmail)) : (dir === 1 ? -1 : filteredEmails.length));
            const ni = Math.min(Math.max(anchor + dir, 0), filteredEmails.length - 1);
            if (filteredEmails[ni]) { setFocusedKey(emailKey(filteredEmails[ni])); scrollRowIntoView(ni); }
            return;
          }
          // Enter — open the focused message (intentional view; marks read).
          if (e.key === 'Enter' && !readerOpen && focusedEmail) { e.preventDefault(); s.onSelectEmail?.(focusedEmail); return; }
          if (e.key === 'u' && selectedEmail) { e.preventDefault(); setSelectedEmail(null); setFullPageReaderOpen(false); return; }

          // Two-key sequences (g i / g s / g d / g t) must be checked BEFORE the
          // single-letter action keys, or a pending 'g' + 's' would star instead.
          if (e.key === 'g') {
            lastKeyRef.current = 'g';
            if (lastKeyTimerRef.current) clearTimeout(lastKeyTimerRef.current);
            lastKeyTimerRef.current = setTimeout(() => { lastKeyRef.current = null; }, 500);
            return;
          }
          if (lastKeyRef.current === 'g') {
            lastKeyRef.current = null;
            if (lastKeyTimerRef.current) clearTimeout(lastKeyTimerRef.current);
            if (e.key === 'i') { e.preventDefault(); setActiveCategory('primary'); setActiveMailTab('primary'); return; }
            if (e.key === 's') { e.preventDefault(); setActiveCategory('primary'); setActiveMailTab('primary'); return; }
            if (e.key === 'd') { e.preventDefault(); setActiveCategory('drafts'); return; }
            if (e.key === 't') { e.preventDefault(); setActiveCategory('sent'); return; }
          }

          // Single-key actions operate on the opened message, or the cursor row.
          const target = selectedEmail || focusedEmail;
          if (e.key === 'x' && target) { e.preventDefault(); s.toggleSelectId?.(target); return; }
          if (e.key === 's' && target) { e.preventDefault(); s.starEmail?.(target); return; }
          if (e.key === '!' && target) { e.preventDefault(); s.spamEmail?.(target); return; }
          if (e.key === 'I' && target) { e.preventDefault(); s.markRead?.(target); return; }
          if (e.key === 'U' && target) { e.preventDefault(); s.markUnread?.(target); return; }
          if (e.key === 'a' && target) { e.preventDefault(); s.openCompose?.('replyAll', target); return; }
          if (e.key === 'f' && target) { e.preventDefault(); s.openCompose?.('forward', target); return; }
        }
      }
      if(composeOpen) return;
      const tag=(document.activeElement?.tagName||'').toLowerCase();
      if(tag==='input'||tag==='textarea'||tag==='select'||document.activeElement?.getAttribute?.('contenteditable')==='true') return;
      // Cmd+A / Ctrl+A — select all visible emails when in mail view
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && activeModule === 'mail') {
        const sa = shortcutsRef.current.selectAllVisible;
        if (sa) {
          e.preventDefault();
          setEditMode(true);
          sa();
          return;
        }
      }
      if(e.key==='Escape'&&shortcutsOpen){e.preventDefault();setShortcutsOpen(false);return;}
      if(e.key==='Escape'&&splitMode==='none'&&fullPageReaderOpen){e.preventDefault();setFullPageReaderOpen(false);return;}
      if(e.key==='Enter'&&splitMode==='none'&&selectedEmail&&!fullPageReaderOpen){e.preventDefault();setFullPageReaderOpen(true);return;}
      if(e.metaKey||e.ctrlKey||e.altKey) return;
      if(e.key==='?'){e.preventDefault();setShortcutsOpen(true);return;}
      // View switchers (spec: 1/2/3/4)
      if(e.key==='1'){e.preventDefault();setActiveModule('everything');return;}
      if(e.key==='2'){e.preventDefault();setActiveModule('mail');return;}
      if(e.key==='3'){e.preventDefault();setActiveModule('docs');return;}
      if(e.key==='4'){e.preventDefault();setActiveModule('cals');return;}
      // Cal event nav — arrow left/right cycles through filteredAllEvents when an event is selected
      if((e.key==='ArrowLeft'||e.key==='ArrowRight') && activeModule==='cals' && selectedEvent && filteredAllEvents.length){
        const idx=filteredAllEvents.findIndex(x=>x.id===selectedEvent.id);
        if(idx>=0){
          const ni=e.key==='ArrowRight'?Math.min(idx+1,filteredAllEvents.length-1):Math.max(idx-1,0);
          if(ni!==idx){e.preventDefault();const ne=filteredAllEvents[ni];setSelectedEvent(ne);if(eventEditOpen)openEventEdit(ne);return;}
        }
      }
      // Compose shortcut (spec: N)
      if(e.key==='n'||e.key==='N'){const oc=shortcutsRef.current.openCompose;if(oc){e.preventDefault();oc('compose');return;}}
      const readerOpen = selectedEmail && (splitMode!=='none' || fullPageReaderOpen);
      if(readerOpen){
        if(e.key==='ArrowLeft'){e.preventDefault();navigatePrev();return;}
        if(e.key==='ArrowRight'){e.preventDefault();navigateNext();return;}
        if(e.key==='ArrowUp'||e.key==='ArrowDown'){
          e.preventDefault();
          const el=readerScrollRef.current; if(!el) return;
          el.scrollBy({top:e.key==='ArrowDown'?120:-120,behavior:'smooth'});
          return;
        }
      } else if (activeModule === 'mail') {
        // No reader open: arrows move the cursor only — no open, no mark-read.
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){
          e.preventDefault();
          if (filteredEmails.length === 0) return;
          const anchor = focusedKey
            ? filteredEmails.findIndex(x => emailKey(x) === focusedKey)
            : (selectedEmail ? filteredEmails.findIndex(x => sameMailItem(x, selectedEmail)) : (e.key==='ArrowDown' ? -1 : filteredEmails.length));
          const ni = Math.min(Math.max(anchor + (e.key==='ArrowDown'?1:-1), 0), filteredEmails.length - 1);
          if (filteredEmails[ni]) { setFocusedKey(emailKey(filteredEmails[ni])); requestAnimationFrame(()=>{const row=document.querySelector(`.email-item:nth-child(${ni+1})`);if(row)row.scrollIntoView({behavior:'smooth',block:'nearest'});}); }
          return;
        }
      }
      const s = shortcutsRef.current;
      // Action keys target the opened message, or the cursor row when none open.
      const kbTarget = selectedEmail || (activeModule === 'mail' && focusedKey ? filteredEmails.find(x => emailKey(x) === focusedKey) : null);
      if (e.key === 'e' && kbTarget && s.archiveEmail) { e.preventDefault(); s.archiveEmail(kbTarget); }
      if (e.key === '#' && kbTarget && s.trashEmail) { e.preventDefault(); s.trashEmail(kbTarget); }
      if (e.key === 'r' && kbTarget && s.openCompose) { e.preventDefault(); s.openCompose('reply', kbTarget); }
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && s.openCompose) { e.preventDefault(); s.openCompose('compose'); }
      if (e.key === '/' && !e.metaKey) { e.preventDefault(); searchInputRef.current?.focus(); }
    };
    window.addEventListener('keydown',onKey); return ()=>window.removeEventListener('keydown',onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail, filteredEmails, focusedKey, loadEmailDetails, loadThread, composeOpen, splitMode, fullPageReaderOpen, navigatePrev, navigateNext, activeModule, shortcutsOpen, selectedEvent, filteredAllEvents, eventEditOpen, openEventEdit]); // action callbacks accessed via shortcutsRef

  // Clear stale selection + cursor when the visible set changes (folder/category
  // or search). Familiar Gmail rule: a selection belongs to the list you made
  // it in. (Account switch already clears via switchAccount.)
  useEffect(() => { clearSelection(); setEditMode(false); setFocusedKey(null); }, [activeCategory, searchQuery, clearSelection, setEditMode]);

  // Keep the keyboard cursor aligned with the opened message so next/prev and
  // list focus stay coherent.
  useEffect(() => { if (selectedEmail) setFocusedKey(emailKey(selectedEmail)); }, [selectedEmail]);

  // Canonical composer-session applier. Every entry point (compose / reply /
  // reply-all / forward / reopen-draft / restore-after-failure) routes through
  // this so the FULL field set — including composeDraftId, attachments, saving
  // and sending state, and errors — is deliberately (re)initialized. This is
  // what fixes the stale composeDraftId leak: the id is always set explicitly.
  const applyComposerSession = useCallback((s) => {
    composerSessionRef.current = { baselineBody: s.baselineBody || '', replyContext: s.replyContext || null, mode: s.mode };
    setComposeMode(s.mode);
    setComposeOriginalEmail(s.originalEmail || null);
    setComposeFromAccountId(s.fromAccountId || '');
    setComposeDraftId(s.draftId || null);
    setComposeTo(s.to || '');
    setComposeCc(s.cc || '');
    setComposeBcc(s.bcc || '');
    setComposeSubject(s.subject || '');
    setComposeBody(s.body || '');
    setComposeShowCcBcc(!!s.showCcBcc);
    setComposeAttachments(s.attachments || []);
    setComposeError(null);
    setComposeSending(false);
    setDraftSavingState('idle');
    setDraftLastSavedAt(null);
    setComposeOpen(true);
  }, []);

  // Draft save — returns a truthful status so callers and the indicator never
  // report "Saved" for a request that failed. 'skipped' when there is nothing
  // meaningful to persist. Attachments are session-only and intentionally NOT
  // part of what a save persists (see attachment truthfulness below).
  const saveDraft = useCallback(async () => {
    const fid = composeFromAccountId; if (!fid) return { status: 'skipped' };
    const meaningful = composerHasContent({ to: composeTo, cc: composeCc, bcc: composeBcc, subject: composeSubject, body: composeBody, baselineBody: composerSessionRef.current?.baselineBody, attachments: [] });
    if (!meaningful) return { status: 'skipped' };
    try {
      const r = await fetch(`${API_BASE}/emails/${fid}/drafts`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: composeTo.trim(), cc: composeCc.trim(), bcc: composeBcc.trim(), subject: composeSubject.trim(), body: composeBody, threadId: composeOriginalEmail?.threadId || null, draftId: composeDraftId || null }),
      });
      if (!r.ok) return { status: 'failed' };
      const d = await r.json().catch(() => null);
      if (!d || d.success === false) return { status: 'failed' };
      if (d.draftId && d.draftId !== composeDraftId) setComposeDraftId(d.draftId);
      return { status: 'saved', draftId: d.draftId };
    } catch (err) {
      return { status: 'failed' };
    }
  }, [composeFromAccountId, composeTo, composeCc, composeBcc, composeSubject, composeBody, composeOriginalEmail, composeDraftId]);

  useEffect(() => { saveDraftRef.current = saveDraft; }, [saveDraft]);

  // Guard invariant 3: opening another composition must preserve meaningful
  // in-progress work first. If preservation fails, keep the current composer
  // open, mark the failure, and abort the replacement (return false).
  const preserveBeforeReplace = useCallback(async () => {
    if (!composeOpen || composeSending) return true;
    const cur = composerSessionRef.current || {};
    const hasWork = composerHasContent({ to: composeTo, cc: composeCc, bcc: composeBcc, subject: composeSubject, body: composeBody, baselineBody: cur.baselineBody, attachments: composeAttachments });
    if (!hasWork) return true;
    const res = await saveDraftRef.current?.();
    if (res && res.status === 'failed') {
      setDraftSavingState('failed');
      setComposeError('Couldn’t save your current message. Resolve this before starting another.');
      return false;
    }
    return true;
  }, [composeOpen, composeSending, composeTo, composeCc, composeBcc, composeSubject, composeBody, composeAttachments]);

  const openCompose = useCallback(async (mode, email = null) => {
    if (!(await preserveBeforeReplace())) return;
    const fromAccountId = mode === 'compose'
      ? (activeView !== 'everything' ? activeView : connectedAccounts[0]?.id || '')
      : (email?.accountId || connectedAccounts[0]?.id || '');
    let headers = {}, fullBody = '';
    if (mode !== 'compose' && email) {
      // Reply/forward need the FULL original body from the reader path. If it
      // can't be loaded, do not open a falsely-ready composer with an empty quote.
      const detail = await loadEmailDetails(email);
      if (!detail || !detail.body) { setError('Couldn’t load the original message. Please try again.'); return; }
      headers = detail.headers || {};
      fullBody = detail.body || '';
    }
    const selfEmail = connectedAccounts.find(a => a.id === fromAccountId)?.gmail_email || '';
    const signatureHtml = signatures[fromAccountId] || '';
    const session = buildComposerSession({ mode, email, fromAccountId, headers, fullBodyHtml: fullBody, selfEmail, signatureHtml, includeSignature: includeAtmSignature });
    applyComposerSession(session);
  }, [preserveBeforeReplace, activeView, connectedAccounts, loadEmailDetails, signatures, includeAtmSignature, applyComposerSession]);

  // Reopen a saved draft into an editable composer (not the read-only reader).
  // Restores sending account, recipients, subject, body, and the Gmail draft id.
  const reopenDraft = useCallback(async (email) => {
    if (!(await preserveBeforeReplace())) return;
    const detail = await loadEmailDetails(email);
    if (!detail) { setError('Couldn’t load that draft. Please try again.'); return; }
    const h = detail.headers || {};
    const s = blankComposerSession();
    s.mode = 'compose';
    s.originalEmail = email.threadId ? { threadId: email.threadId, accountId: email.accountId } : null;
    s.fromAccountId = email.accountId || connectedAccounts[0]?.id || '';
    s.draftId = email.draftId || null;
    s.to = h.to || '';
    s.cc = h.cc || '';
    s.bcc = h.bcc || '';
    s.subject = h.subject || email.subject || '';
    s.body = detail.body || '';
    s.baselineBody = s.body;
    s.showCcBcc = !!(s.cc || s.bcc);
    applyComposerSession(s);
  }, [preserveBeforeReplace, loadEmailDetails, connectedAccounts, applyComposerSession]);

  // Sync the keyboard shortcut callbacks ref now that they're defined. Keyboard
  // paths call these canonical operations so mouse and keyboard never diverge.
  useEffect(() => {
    shortcutsRef.current = { archiveEmail, trashEmail, openCompose, selectAllVisible, spamEmail, markRead, markUnread, starEmail, toggleSelectId, onSelectEmail };
  }, [archiveEmail, trashEmail, openCompose, selectAllVisible, spamEmail, markRead, markUnread, starEmail, toggleSelectId, onSelectEmail]);

  // Persist scheduled sends to localStorage — P2: strip the full email body
  // (and cc/bcc/subject) before writing. Supabase is the system of record
  // for the payload; we only need minimal metadata to reconcile and to show
  // "X scheduled" in the UI. If a post-XSS attacker dumps localStorage they
  // now only get the scheduled timestamp + account + DB id, not the text of
  // unsent mail.
  useEffect(() => {
    const slim = scheduledSends.map(s => ({
      id: s.id,
      scheduledFor: s.scheduledFor,
      accountId: s.accountId,
      status: s.status,
    }));
    localStorage.setItem('atm_scheduled_sends', JSON.stringify(slim));
  }, [scheduledSends]);

  // Persist active mail tab
  useEffect(() => { localStorage.setItem('atm_mail_tab', activeMailTab); }, [activeMailTab]);

  // Check scheduled sends every 30 seconds — send when time is up.
  // For DB-backed items (have an id), uses a CAS lock (pending → sending)
  // to prevent double-send across multiple open tabs.
  // For localStorage-only items (no id), fires directly with no lock.
  useEffect(() => {
    const checkScheduled = async () => {
      const now = Date.now();
      // P2 — require full payload to fire. localStorage entries are slim
      // (metadata-only), so on fresh page load we wait until sync hydrates
      // the full body/subject from Supabase before attempting a send.
      const due = scheduledSends.filter(s =>
        new Date(s.scheduledFor).getTime() <= now &&
        typeof s.body === 'string' && typeof s.to === 'string' && s.to.length > 0
      );
      if (due.length === 0) return;

      for (const item of due) {
        try {
          if (item.id) {
            // CAS: claim the send — 409 means another tab already got it
            const claimRes = await fetch(`${API_BASE}/scheduled-sends/${item.id}`, {
              method: 'PATCH', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'sending' }),
            });
            if (!claimRes.ok) continue; // already claimed — skip
          }

          const sendRes = await fetch(`${API_BASE}/emails/${item.accountId}/send`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'compose', to: item.to, cc: item.cc || '', bcc: item.bcc || '', subject: item.subject, body: item.body, includeSignature: true }),
          });

          // Update final status in DB (non-blocking)
          if (item.id) {
            fetch(`${API_BASE}/scheduled-sends/${item.id}`, {
              method: 'PATCH', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: sendRes.ok ? 'sent' : 'failed' }),
            }).catch(() => {});
          }
        } catch (err) {
          console.error('Scheduled send failed:', err);
          if (item.id) {
            fetch(`${API_BASE}/scheduled-sends/${item.id}`, {
              method: 'PATCH', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'failed' }),
            }).catch(() => {});
          }
        }
      }

      setScheduledSends(prev => prev.filter(s => new Date(s.scheduledFor).getTime() > now));
    };
    checkScheduled();
    const interval = setInterval(checkScheduled, 30000);
    return () => clearInterval(interval);
  }, [scheduledSends]);

  const scheduleSend = useCallback((scheduledFor) => {
    const fid = composeFromAccountId;
    if (!fid) { setComposeError('Select a sending account'); return; }
    if (!composeTo.trim()) { setComposeError('Recipient is required'); return; }

    const newSend = {
      to: composeTo.trim(), cc: composeCc.trim(), bcc: composeBcc.trim(),
      subject: composeSubject.trim(), body: composeBody,
      accountId: fid, scheduledFor: scheduledFor.toISOString(),
    };

    // Optimistic local update first so UI reflects immediately
    setScheduledSends(prev => [...prev, newSend]);

    // Persist to Supabase; on success tag the entry with its DB id
    fetch(`${API_BASE}/scheduled-sends`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { to: newSend.to, cc: newSend.cc, bcc: newSend.bcc, subject: newSend.subject, body: newSend.body, accountId: newSend.accountId },
        sendAt: newSend.scheduledFor,
      }),
    }).then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.id) {
          setScheduledSends(prev => prev.map(x =>
            (!x.id && x.scheduledFor === newSend.scheduledFor && x.to === newSend.to)
              ? { ...x, id: data.id }
              : x
          ));
        }
      })
      .catch(() => {}); // graceful degradation — send still fires client-side

    setComposeOpen(false); setComposeOriginalEmail(null); setComposeAttachments([]); setComposeDraftId(null);
  }, [composeFromAccountId, composeTo, composeCc, composeBcc, composeSubject, composeBody]);


  // Deliberate From-account switch. Recomputes reply-all self-exclusion against
  // the newly-chosen sending address so the user is never left cc'ing themselves
  // (or dropping the wrong address) after switching accounts mid-reply.
  const changeComposeFrom = useCallback((accountId) => {
    setComposeFromAccountId(accountId);
    const cur = composerSessionRef.current;
    if (cur && cur.mode === 'replyAll' && cur.replyContext) {
      const selfEmail = connectedAccounts.find(a => a.id === accountId)?.gmail_email || '';
      const { to, cc } = recomputeForFrom(cur, selfEmail);
      setComposeTo(to); setComposeCc(cc); setComposeShowCcBcc(!!cc);
    }
  }, [connectedAccounts]);

  // Snapshot the complete editable composer session so a failed send can
  // restore it exactly, and a delayed send fires the content captured at click
  // time (never state that a later composition may have overwritten).
  const buildSendSnapshot = useCallback(() => ({
    mode: composeMode, fromAccountId: composeFromAccountId,
    to: composeTo, cc: composeCc, bcc: composeBcc, subject: composeSubject,
    body: composeBody, attachments: composeAttachments, draftId: composeDraftId,
    originalEmail: composeOriginalEmail,
    baselineBody: composerSessionRef.current?.baselineBody || '',
    replyContext: composerSessionRef.current?.replyContext || null,
  }), [composeMode, composeFromAccountId, composeTo, composeCc, composeBcc, composeSubject, composeBody, composeAttachments, composeDraftId, composeOriginalEmail]);

  const restoreComposerFromSnapshot = useCallback((snap, errorMsg) => {
    composerSessionRef.current = { baselineBody: snap.baselineBody, replyContext: snap.replyContext, mode: snap.mode };
    setComposeMode(snap.mode); setComposeOriginalEmail(snap.originalEmail || null);
    setComposeFromAccountId(snap.fromAccountId); setComposeDraftId(snap.draftId || null);
    setComposeTo(snap.to); setComposeCc(snap.cc); setComposeBcc(snap.bcc);
    setComposeSubject(snap.subject); setComposeBody(snap.body);
    setComposeShowCcBcc(!!(snap.cc || snap.bcc));
    setComposeAttachments(snap.attachments || []);
    setComposeSending(false); setComposeOpen(true);
    if (errorMsg) setComposeError(errorMsg);
  }, []);

  const closeCompose = useCallback(async () => {
    if (composeSending) return;
    // Preserve meaningful work before hiding (invariant 3). If the save fails,
    // keep the composer open and surface the failure rather than losing content.
    const cur = composerSessionRef.current || {};
    const hasWork = composerHasContent({ to: composeTo, cc: composeCc, bcc: composeBcc, subject: composeSubject, body: composeBody, baselineBody: cur.baselineBody, attachments: composeAttachments });
    if (hasWork) {
      const res = await saveDraft();
      if (res && res.status === 'failed') { setDraftSavingState('failed'); setComposeError('Couldn’t save your draft — your message is still here.'); return; }
    }
    const fid = composeFromAccountId;
    setComposeOpen(false); setComposeError(null); setComposeOriginalEmail(null); setComposeAttachments([]); setComposeDraftId(null);
    composerSessionRef.current = blankComposerSession();
    if (fid) loadEmailsForAccount(fid, 'drafts').catch(() => {});
  }, [composeSending, composeTo, composeCc, composeBcc, composeSubject, composeBody, composeAttachments, saveDraft, composeFromAccountId, loadEmailsForAccount]);

  // Deliberate discard — deletes the persisted draft (if any) and clears the
  // active composer WITHOUT saving. Distinct from close/minimize; the confirm
  // gate lives in ComposeModal.
  const discardCompose = useCallback(async () => {
    const fid = composeFromAccountId, did = composeDraftId;
    setComposeOpen(false); setComposeError(null); setComposeOriginalEmail(null); setComposeAttachments([]); setComposeDraftId(null);
    composerSessionRef.current = blankComposerSession();
    if (fid && did) {
      try {
        await fetch(`${API_BASE}/emails/${fid}/drafts/${did}`, { method: 'DELETE', credentials: 'include' });
        loadEmailsForAccount(fid, 'drafts').catch(() => {});
      } catch (_) { /* best-effort */ }
    }
    emitToast({ message: 'Draft discarded' });
  }, [composeFromAccountId, composeDraftId, loadEmailsForAccount, emitToast]);

  const sendCompose = useCallback(async (snapshotArg) => {
    const snap = snapshotArg || buildSendSnapshot();
    const fid = snap.fromAccountId;
    if (!fid) { restoreComposerFromSnapshot(snap, 'Select a sending account'); return; }
    if (!snap.to.trim()) { restoreComposerFromSnapshot(snap, 'Recipient is required'); return; }
    const account = connectedAccounts.find(a => a.id === fid);
    const acctLabel = account?.account_name || account?.gmail_email || '';
    // Immediate acknowledgement: composer is already hidden; show a Sending
    // toast. Submission ack, provider result, and inbox refresh are separate.
    setComposeSending(false);
    emitToast({ message: `Sending${acctLabel ? ` from ${acctLabel}` : ''}…`, persist: true });
    const sigLine = includeAtmSignature ? '<br><div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;font-size:12px;color:#999;">Sent via <a href="https://allthemail.io" style="color:#FF3A1D;text-decoration:none;">All The Mail</a></div>' : '';
    const bodyWithSig = snap.body + sigLine;
    try {
      let r;
      if (snap.attachments.length > 0) {
        const fd = new FormData();
        fd.append('to', snap.to.trim()); fd.append('subject', snap.subject.trim()); fd.append('body', bodyWithSig);
        if (snap.cc.trim()) fd.append('cc', snap.cc.trim());
        if (snap.bcc.trim()) fd.append('bcc', snap.bcc.trim());
        if (snap.originalEmail?.threadId) fd.append('threadId', snap.originalEmail.threadId);
        if (snap.originalEmail?.id) fd.append('originalEmailId', snap.originalEmail.id);
        if (snap.draftId) fd.append('draftId', snap.draftId);
        snap.attachments.forEach(f => fd.append('attachments', f));
        r = await fetch(`${API_BASE}/emails/${fid}/send`, { method: 'POST', credentials: 'include', body: fd });
      } else {
        r = await fetch(`${API_BASE}/emails/${fid}/send`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: snap.mode, to: snap.to.trim(), cc: snap.cc.trim(), bcc: snap.bcc.trim(), subject: snap.subject.trim(), body: bodyWithSig, originalEmailId: snap.originalEmail?.id || null, threadId: snap.originalEmail?.threadId || null, draftId: snap.draftId || null, includeSignature: true }),
        });
      }
      if (r.ok) {
        emitToast({ message: `Sent${acctLabel ? ` from ${acctLabel}` : ''}` });
        // Background refresh — must not turn a successful send into a failure.
        loadEmailsForAccount(fid, activeCategory).catch(() => {});
        loadEmailsForAccount(fid, 'drafts').catch(() => {});
        if (activeView === 'everything') connectedAccounts.forEach(a => { if (a.id !== fid) loadEmailsForAccount(a.id, activeCategory).catch(() => {}); });
      } else {
        const d = await r.json().catch(() => ({}));
        emitToast(null);
        restoreComposerFromSnapshot(snap, `${d?.error || 'Send failed. If permissions changed, reconnect the account.'}${acctLabel ? ` (account: ${acctLabel})` : ''}`);
      }
    } catch (err) {
      emitToast(null);
      restoreComposerFromSnapshot(snap, `Send failed${acctLabel ? ` for ${acctLabel}` : ''}: ${String(err?.message || err)}`);
    }
  }, [buildSendSnapshot, restoreComposerFromSnapshot, connectedAccounts, emitToast, includeAtmSignature, loadEmailsForAccount, activeCategory, activeView]);

  const sendComposeWithDelay = useCallback(() => {
    const fid = composeFromAccountId;
    if (!fid) { setComposeError('Select a sending account'); return; }
    if (!composeTo.trim()) { setComposeError('Recipient is required'); return; }
    const snap = buildSendSnapshot();
    // Immediate acknowledgement: hide the composer right away regardless of delay.
    setComposeOpen(false);
    if (sendDelaySeconds === 0) { sendCompose(snap); return; }
    const previewSubject = composeSubject.trim() || '(no subject)';
    let secondsLeft = sendDelaySeconds;
    const interval = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(interval);
        setPendingSend(null);
        sendCompose(snap);
      } else {
        setPendingSend(prev => prev ? { ...prev, secondsLeft } : { secondsLeft, previewSubject, interval, snap });
      }
    }, 1000);
    setPendingSend({ secondsLeft, previewSubject, interval, snap });
  }, [composeFromAccountId, composeTo, buildSendSnapshot, sendDelaySeconds, sendCompose, composeSubject]);

  const cancelPendingSend = useCallback(() => {
    if (pendingSend?.interval) clearInterval(pendingSend.interval);
    // Restore the exact captured content so no work is lost on undo-send.
    if (pendingSend?.snap) restoreComposerFromSnapshot(pendingSend.snap);
    else setComposeOpen(true);
    setPendingSend(null);
  }, [pendingSend, restoreComposerFromSnapshot]);

  const useStackedRows = listWidth < 520;

  // ==================== SPLIT ICONS ====================
  const SplitNoneIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>);
  const SplitVerticalIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="3" width="8" height="18" rx="1"/></svg>);
  const SplitHorizontalIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="8" rx="1"/><rect x="3" y="13" width="18" height="8" rx="1"/></svg>);

  // ==================== MAIN RENDER ====================

  if (isAuthed === null) return (
    <div className="app-gate">
      <div className="app-gate-wordmark">
        <span className="wordmark-static">ALL THE</span>
        <span className="wordmark-module" key={GATE_WORDS[gateWordIdx]}>{GATE_WORDS[gateWordIdx]}</span>
      </div>
      <div className="app-loading-bar" />
    </div>
  );

  if (isAuthed === false) return (
    <div className={`app-container login-screen${introActive ? ' intro' : ''}`}>
      <button className="toolbar-btn login-theme-toggle theme-toggle-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
        <span className={`theme-icon${theme === 'dark' ? ' theme-icon-active' : ''}`}><Sun size={16} strokeWidth={1.5} /></span>
        <span className={`theme-icon${theme === 'light' ? ' theme-icon-active' : ''}`}><Moon size={16} strokeWidth={1.5} /></span>
      </button>
      <div className="login-card">
        {authError && <div className="login-error">{authError}</div>}
        <div style={{ fontSize: 'clamp(36px,5vw,52px)', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 0.95, marginBottom: '24px' }}>
          Email.<br /><span style={{ color: 'var(--accent)' }}>Unified.</span>
        </div>
        <div className="login-heading">Mail, docs, and calendars from one deliberate interface.</div>
        <div className="login-subheading">Encrypted tokens. No passwords stored. Disconnect anytime.</div>
        <button className="btn btn-primary" onClick={handleGoogleLogin} style={{ width: '100%' }}>
          <Mail size={18} /> Sign in with Google
        </button>
        <div className="login-subheading" style={{ marginTop: '16px', marginBottom: 0 }}>You will be asked to grant Gmail, Drive, and Calendar permissions</div>
      </div>
    </div>
  );

  return (
    <div className={`app-container${introActive ? ' intro' : ''}`}>
      {/* Top bar */}
      <header className="top-bar" onDoubleClick={() => {
        const target = document.querySelector('.email-list, .ev-col-body, .gcal-body, .ev-mobile-unified-wrap.active');
        if (target) target.scrollTo({ top: 0, behavior: 'smooth' });
      }}>
        <div className="top-bar-wordmark" aria-live="polite" aria-atomic="true">
          <span className="wordmark-static">ALL THE</span><span className="wordmark-module" key={activeModule}>{{ everything: 'EVERYTHING', mail: 'MAIL', docs: 'DOCS', cals: 'CALS' }[activeModule]}</span>
        </div>
        <nav className="module-tabs" role="navigation" aria-label="Main navigation">
          <button className={`module-tab${activeModule==='everything'?' active':''}`} onClick={()=>setActiveModule('everything')} aria-current={activeModule==='everything' ? 'page' : undefined} aria-label="Everything"><LayoutGrid size={15} strokeWidth={1.5} /></button>
          <button className={`module-tab${activeModule==='mail'?' active':''}`} onClick={()=>setActiveModule('mail')} aria-current={activeModule==='mail' ? 'page' : undefined} aria-label="Mail"><Mail size={15} strokeWidth={1.5} /></button>
          <button className={`module-tab${activeModule==='docs'?' active':''}`} onClick={()=>setActiveModule('docs')} aria-current={activeModule==='docs' ? 'page' : undefined} aria-label="Docs"><FileText size={15} strokeWidth={1.5} /></button>
          <button className={`module-tab${activeModule==='cals'?' active':''}`} onClick={()=>setActiveModule('cals')} aria-current={activeModule==='cals' ? 'page' : undefined} aria-label="Calendar"><Calendar size={15} strokeWidth={1.5} /></button>
        </nav>
        <div className="module-divider" />
        <div className={`account-rail${fadeLeft ? ' fade-left' : ''}${fadeRight ? ' fade-right' : ''}`}>
          <div className="account-rail-scroll" ref={railScrollRef} onScroll={updateRailFades}>
            <button className={`account-pill${activeView === 'everything' ? ' active' : ''}`} onClick={() => switchAccount('everything')}>
              <Users size={14} strokeWidth={1.5} style={{ opacity: 0.7 }} /><span className="account-pill-label">All</span>
            </button>
            {connectedAccounts.map((a, i) => {
              const g = getAccountGradient(i);
              return (
                <button key={a.id} className={`account-pill${activeView === a.id ? ' active' : ''}`} onClick={() => switchAccount(a.id)} title={a.gmail_email}>
                  <Avatar src={a.picture} email={a.gmail_email} name={a.account_name} size={22} ring={activeView === a.id ? g.g0 : undefined} />
                  <span className="account-pill-label">{getShortLabel(a, connectedAccounts)}</span>
                </button>
              );
            })}
            <button className="account-pill add-pill" onClick={handleAddAccount} title="Add account"><Plus size={13} strokeWidth={1.5} /><span className="add-pill-label">Add</span></button>
          </div>
        </div>
        <div className="top-bar-controls">
          {scheduledSends.length > 0 && (
            <button
              onClick={() => setScheduledListOpen(true)}
              title="View scheduled emails"
              style={{ display: 'flex', alignItems: 'center', gap: '5px', marginRight: '8px', padding: '3px 10px', background: 'var(--bg-1)', border: '1px solid var(--line-0)', borderRadius: '6px', fontSize: '11px', color: 'var(--text-2)', whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <Send size={12} strokeWidth={1.5} />
              {scheduledSends.length} scheduled
            </button>
          )}
          {activeModule === 'mail' && lastSyncTime && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: '6px' }}>
              <span className="sync-dot" /><span style={{ fontSize: '11px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{getRelativeTime(lastSyncTime)}</span>
            </div>
          )}
          {activeModule === 'mail' && (
            <>
              <button className="toolbar-btn" onClick={() => { if (activeView === 'everything') connectedAccounts.forEach(a => loadEmailsForAccount(a.id, activeCategory)); else loadEmailsForAccount(activeView, activeCategory); refreshEmails(); }} title="Refresh" aria-label="Refresh email">
                <RefreshCw size={15} strokeWidth={1.5} className={(isLoadingEmails || isCheckingMail) ? 'animate-spin' : ''} />
              </button>
              <div className="module-divider" />
              <button className={`toolbar-btn${splitMode==='none'?' toolbar-active':''}`} onClick={()=>{setSplitMode('none');setFullPageReaderOpen(false);}} title="No split" aria-label="No split" aria-pressed={splitMode==='none'}><SplitNoneIcon /></button>
              <button className={`toolbar-btn${splitMode==='vertical'?' toolbar-active':''}`} onClick={()=>{setSplitMode('vertical');setFullPageReaderOpen(false);}} title="Vertical split" aria-label="Vertical split" aria-pressed={splitMode==='vertical'}><SplitVerticalIcon /></button>
              <button className={`toolbar-btn${splitMode==='horizontal'?' toolbar-active':''}`} onClick={()=>{setSplitMode('horizontal');setFullPageReaderOpen(false);}} title="Horizontal split" aria-label="Horizontal split" aria-pressed={splitMode==='horizontal'}><SplitHorizontalIcon /></button>
              <div className="module-divider" />
              <button className="toolbar-btn" onClick={cycleDensity} title={`Density: ${densityMode}`} aria-label={`Email density: ${densityMode}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
              </button>
              <div className="module-divider" />
              <button className={`toolbar-btn${conversationView?' toolbar-active':''}`} onClick={()=>setConversationView(v=>!v)} title={conversationView ? 'Conversation view on' : 'Conversation view off'} aria-label={conversationView ? 'Conversation view on' : 'Conversation view off'} aria-pressed={conversationView}>
                <MessagesSquare size={15} strokeWidth={1.5} />
              </button>
            </>
          )}
          <button className="toolbar-btn theme-toggle-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} style={{ marginLeft: '4px' }}>
            <span className={`theme-icon${theme === 'dark' ? ' theme-icon-active' : ''}`} aria-hidden="true"><Sun size={15} strokeWidth={1.5} /></span>
            <span className={`theme-icon${theme === 'light' ? ' theme-icon-active' : ''}`} aria-hidden="true"><Moon size={15} strokeWidth={1.5} /></span>
          </button>
          <AccountMenu
            userProfile={userProfile}
            connectedAccounts={connectedAccounts}
            billingPlan={billingPlan} billingLoading={billingLoading}
            handleUpgrade={handleUpgrade} handleManageBilling={handleManageBilling}
            handleRemoveAccount={handleRemoveAccount} removingAccountId={removingAccountId}
            handleAddAccount={handleAddAccount}
            handleLogout={handleLogout}
            sendDelaySeconds={sendDelaySeconds} setSendDelaySeconds={setSendDelaySeconds}
            avatarDropdownRef={avatarDropdownRef} avatarButtonRef={avatarButtonRef}
            avatarDropdownOpen={avatarDropdownOpen} setAvatarDropdownOpen={setAvatarDropdownOpen}
            setRemovingAccountId={setRemovingAccountId}
          />
        </div>
      </header>

      {/* Intro banner — first-load cheatsheet */}
      {introBannerOpen && (
        <div className="atm-intro-banner" role="region" aria-label="Welcome">
          <span className="atm-intro-banner-head">ALL THE MAIL.</span>
          <span className="atm-intro-banner-body">Unify Gmail, Drive &amp; Calendar across accounts.</span>
          <span className="atm-intro-banner-kbd"><kbd>⌘K</kbd> command</span>
          <span className="atm-intro-banner-kbd"><kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd> views</span>
          <span className="atm-intro-banner-kbd"><kbd>N</kbd> new</span>
          <span className="atm-intro-banner-kbd"><kbd>J</kbd>/<kbd>K</kbd> navigate</span>
          <button className="atm-intro-banner-x" onClick={dismissIntroBanner} aria-label="Dismiss">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="main-content" role="main">
        <ErrorBoundary>
          {activeModule === 'everything' && (
            <EverythingModule
              evFilteredEmails={evFilteredEmails} evFilteredDocs={evFilteredDocs} evFilteredEvents={evFilteredEvents}
              filteredAllEvents={filteredAllEvents}
              evMailFilter={evMailFilter} setEvMailFilter={setEvMailFilter}
              evDocsFilter={evDocsFilter} setEvDocsFilter={setEvDocsFilter}
              evCalsFilter={evCalsFilter} setEvCalsFilter={setEvCalsFilter}
              evMobileTab={evMobileTab} setEvMobileTab={setEvMobileTab}
              mobileUnifiedFeed={mobileUnifiedFeed}
              connectedAccounts={connectedAccounts}
              activeView={activeView}
              loadRemoteImages={loadRemoteImages} onShowImages={enableRemoteImages}
              slideOverEmail={slideOverEmail} openSlideOverEmail={openSlideOverEmail} closeSlideOver={closeSlideOver}
              slideOverDoc={slideOverDoc} openSlideOverDoc={openSlideOverDoc}
              isLoadingDocs={isLoadingDocs} isLoadingEvents={isLoadingEvents}
              hasDocsError={hasDocsError} hasEventsError={hasEventsError}
              anyHasDocs={anyHasDocs} anyHasCals={anyHasCals}
              openEventEdit={openEventEdit}
              setSelectedEvent={setSelectedEvent}
              handleAddAccount={handleAddAccount}
              cascadeTimestampRef={cascadeTimestampRef}
              cascadeKey={cascadeKey}
              emailBodies={emailBodies}
              emailHeaders={emailHeaders}
              openCompose={openCompose}
              onSelectEmail={onSelectEmail}
              archiveEmail={archiveEmail}
              setActiveModule={setActiveModule}
              setActiveView={setActiveView}
              setEmails={setEmails}
              setError={setError}
              apiBase={API_BASE}
            />
          )}
          {activeModule === 'cals' && (
            <CalsModule
              connectedAccounts={connectedAccounts}
              filteredAllEvents={filteredAllEvents}
              calGridDays={calGridDays}
              calMonthDays={calMonthDays}
              calDate={calDate} setCalDate={setCalDate}
              calsViewMode={calsViewMode} setCalsViewMode={setCalsViewMode}
              calTitle={calTitle}
              calNavigate={calNavigate}
              selectedEvent={selectedEvent} setSelectedEvent={setSelectedEvent}
              openEventEdit={openEventEdit}
              isLoadingEvents={isLoadingEvents}
              hasEventsError={hasEventsError}
              anyHasCals={anyHasCals}
              handleAddAccount={handleAddAccount}
            />
          )}
          {activeModule !== 'everything' && activeModule !== 'cals' && (
            <PanelGroup orientation="horizontal" id={`atm-${activeModule}-${activeModule==='mail'?splitMode:'default'}-layout`}>
              {activeModule === 'mail' && (
                <MailModule
                  splitMode={splitMode}
                  loadRemoteImages={loadRemoteImages} onShowImages={enableRemoteImages}
                  fullPageReaderOpen={fullPageReaderOpen} setFullPageReaderOpen={setFullPageReaderOpen}
                  emails={emails} setEmails={setEmails}
                  selectedEmail={selectedEmail} setSelectedEmail={setSelectedEmail}
                  selectedThread={selectedThread} setSelectedThread={setSelectedThread}
                  emailBodies={emailBodies} emailHeaders={emailHeaders} emailAttachments={emailAttachments}
                  isLoadingEmails={isLoadingEmails} isLoadingBody={isLoadingBody} isLoadingThread={isLoadingThread}
                  emailLoadError={emailLoadError}
                  editMode={editMode} setEditMode={setEditMode}
                  selectedIds={selectedIds}
                  batchWorking={batchWorking}
                  starredOverrides={starredOverrides}
                  snoozedEmails={snoozedEmails}
                  snoozeDropdownEmailId={snoozeDropdownEmailId} setSnoozeDropdownEmailId={setSnoozeDropdownEmailId}
                  collapsedMsgIds={collapsedMsgIds} setCollapsedMsgIds={setCollapsedMsgIds}
                  threadExpanded={threadExpanded} setThreadExpanded={setThreadExpanded}
                  expandedBodies={expandedBodies} setExpandedBodies={setExpandedBodies}
                  filteredEmails={filteredEmails}
                  categoryCounts={categoryCounts}
                  loadEmailsForAccount={loadEmailsForAccount}
                  loadEmailDetails={loadEmailDetails}
                  downloadAttachment={downloadAttachment}
                  loadThread={loadThread}
                  trashEmail={trashEmail} archiveEmail={archiveEmail} starEmail={starEmail}
                  spamEmail={spamEmail} markRead={markRead} markUnread={markUnread}
                  searchAllAccounts={searchAllAccounts} batchAction={batchAction}
                  clearSelection={clearSelection} toggleSelectId={toggleSelectId} selectRange={selectRange} selectAllVisible={selectAllVisible}
                  focusedKey={focusedKey}
                  reopenDraft={reopenDraft}
                  snoozeEmail={snoozeEmail} getSnoozeOptions={getSnoozeOptions}
                  navigatePrev={navigatePrev} navigateNext={navigateNext} onSelectEmail={onSelectEmail}
                  activeView={activeView}
                  activeCategory={activeCategory} setActiveCategory={setActiveCategory}
                  activeMailTab={activeMailTab} setActiveMailTab={setActiveMailTab}
                  connectedAccounts={connectedAccounts}
                  listContainerRef={listContainerRef}
                  readerScrollRef={readerScrollRef}
                  iframeRef={iframeRef}
                  iframeResizeCleanupRef={iframeResizeCleanupRef}
                  handleReaderScroll={handleReaderScroll}
                  openCompose={openCompose}
                  setError={setError}
                  SplitNoneIcon={SplitNoneIcon} SplitVerticalIcon={SplitVerticalIcon} SplitHorizontalIcon={SplitHorizontalIcon}
                  searchQuery={searchQuery} setSearchQuery={setSearchQuery}
                  showSearchSuggestions={showSearchSuggestions} setShowSearchSuggestions={setShowSearchSuggestions}
                  savedSearches={savedSearches} setSavedSearches={setSavedSearches}
                  searchInputRef={searchInputRef}
                  showMetadata={showMetadata} setShowMetadata={setShowMetadata}
                  readerCompact={readerCompact}
                  densityMode={densityMode}
                  useStackedRows={useStackedRows}
                  swipeRef={swipeRef}
                  cascadeTimestampRef={cascadeTimestampRef}
                  cascadeKey={cascadeKey}
                  sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed}
                  setSelectedThreadActiveMessageId={() => {}}
                />
              )}
              {activeModule === 'docs' && (
                <DocsModule
                  filteredDocs={filteredDocs}
                  selectedDoc={selectedDoc} setSelectedDoc={setSelectedDoc}
                  docsCategory={docsCategory} setDocsCategory={setDocsCategory}
                  docsSearchQuery={docsSearchQuery} setDocsSearchQuery={setDocsSearchQuery}
                  docsSortBy={docsSortBy} docsSortDir={docsSortDir}
                  toggleDocsSort={toggleDocsSort}
                  isLoadingDocs={isLoadingDocs}
                  hasDocsError={hasDocsError}
                  connectedAccounts={connectedAccounts}
                  handleAddAccount={handleAddAccount}
                />
              )}
            </PanelGroup>
          )}
        </ErrorBoundary>
      </main>

      {/* Compose modal */}
      <React.Suspense fallback={null}>
        <ComposeModal
          composeOpen={composeOpen} composeMode={composeMode} composeSending={composeSending} composeError={composeError}
          composeFromAccountId={composeFromAccountId} setComposeFromAccountId={changeComposeFrom}
          composeTo={composeTo} setComposeTo={setComposeTo}
          composeCc={composeCc} setComposeCc={setComposeCc}
          composeBcc={composeBcc} setComposeBcc={setComposeBcc}
          composeSubject={composeSubject} setComposeSubject={setComposeSubject}
          composeBody={composeBody} setComposeBody={setComposeBody}
          composeShowCcBcc={composeShowCcBcc} setComposeShowCcBcc={setComposeShowCcBcc}
          composeAttachments={composeAttachments} handleFileSelect={handleFileSelect} removeAttachment={removeAttachment}
          connectedAccounts={connectedAccounts}
          contacts={contacts}
          closeCompose={closeCompose} sendCompose={sendComposeWithDelay}
          discardCompose={discardCompose}
          scheduleSend={scheduleSend}
          saveDraft={saveDraft}
          draftSavingState={draftSavingState}
          draftLastSavedAt={draftLastSavedAt}
          includeSignature={includeAtmSignature} setIncludeSignature={setIncludeAtmSignature}
        />
      </React.Suspense>

      {/* Slide-over preview panel — suppressed for email in Everything view (rendered inline there) */}
      {((slideOverEmail && activeModule !== 'everything') || slideOverDoc) && (
        <div className="slide-over-backdrop" onClick={closeSlideOver}>
          <div className="slide-over-panel" onClick={e => e.stopPropagation()}>
            {slideOverIndex !== null && (<span className="slide-over-position">{slideOverIndex + 1} / {slideOverEmail ? evFilteredEmails.slice(0, 50).length : evFilteredDocs.length}</span>)}
            <button className="slide-over-close" onClick={closeSlideOver} title="Close"><X size={16} strokeWidth={1.5} /></button>
            {slideOverEmail && (() => {
              const ekey = emailKey(slideOverEmail);
              const body = emailBodies[ekey];
              const headers = emailHeaders[ekey];
              const accountIndex = connectedAccounts.findIndex(a => a.id === slideOverEmail.accountId);
              const grad = accountIndex !== -1 ? getAccountGradient(accountIndex) : null;
              const accountName = connectedAccounts[accountIndex]?.account_name || connectedAccounts[accountIndex]?.gmail_email || '';
              return (
                <div style={{ padding: '32px 32px 24px' }}>
                  {grad && (<div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '16px', padding: '3px 10px 3px 6px', borderRadius: 'var(--r-pill)', background: grad.midRgba(0.08), fontSize: '11px', fontWeight: 500, color: 'var(--text-1)' }}><span className="account-dot" style={{ background: grad.gradient, width: 8, height: 8 }} />{accountName}</div>)}
                  <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-0)', margin: '0 0 16px', lineHeight: 1.3 }}>{slideOverEmail.subject || '(no subject)'}</h1>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <div className="reader-avatar">{stripName(headers?.from || slideOverEmail.from || '').charAt(0).toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-0)' }}>{stripName(headers?.from || slideOverEmail.from || '')}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>{headers?.to ? `To: ${stripName(headers.to)}` : ''} · {formatTime(slideOverEmail.date)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
                    <button className="btn-ghost" style={{ fontSize: '12px', padding: '6px 12px' }} onClick={() => { closeSlideOver(); setActiveModule('mail'); setActiveView('everything'); onSelectEmail(slideOverEmail); }}><ArrowLeft size={14} strokeWidth={1.5} /> Open full view</button>
                    <button className="btn-ghost" style={{ fontSize: '12px', padding: '6px 12px' }} onClick={() => { closeSlideOver(); openCompose('reply', slideOverEmail); }}><Reply size={14} strokeWidth={1.5} /> Reply</button>
                    <button className="btn-ghost" style={{ fontSize: '12px', padding: '6px 12px' }} onClick={async () => {
                      const aid = slideOverEmail.accountId || connectedAccounts[0]?.id; if (!aid) return;
                      try { await fetch(`${API_BASE}/emails/${aid}/${slideOverEmail.id}/archive`, { method: 'POST', credentials: 'include' }); setEmails(p => { const acc = p[aid]; if (!acc) return p; const u = {}; for (const c of Object.keys(acc)) u[c] = (acc[c] || []).filter(e => e.id !== slideOverEmail.id); return { ...p, [aid]: u }; }); closeSlideOver(); } catch (err) { setError('Failed to archive'); }
                    }}><Archive size={14} strokeWidth={1.5} /> Archive</button>
                  </div>
                  <div style={{ height: '1px', background: 'var(--line-0)', marginBottom: '20px' }} />
                  {!body ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '20px 0' }}>
                      {Array.from({ length: 4 }).map((_, i) => (<div key={i} className="skeleton-block" style={{ height: i === 0 ? 16 : 12, width: i === 3 ? '60%' : '100%' }} />))}
                    </div>
                  ) : (
                    <div className="email-body-wrapper" style={{ borderRadius: '8px', overflow: 'hidden' }}>
                      {emailHtmlHasRemoteImages(body) && !loadRemoteImages && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 12px', background: 'var(--bg-3)', borderBottom: '1px solid var(--line-0)', fontSize: '12px', color: 'var(--text-2)' }}>
                          <span>Remote images are hidden to protect your privacy.</span>
                          <button className="btn-ghost" style={{ fontSize: '12px', padding: '4px 10px', flexShrink: 0 }} onClick={enableRemoteImages}>Show images</button>
                        </div>
                      )}
                      <iframe title="Email preview" srcDoc={buildEmailSrcDoc(body, { loadRemoteImages })}
                        scrolling="no"
                        sandbox="allow-same-origin allow-popups"
                        style={{ width: '100%', border: 'none', display: 'block', background: 'var(--email-bg)', minHeight: '120px' }}
                        onLoad={e => {
                          const iframe = e.target;
                          if (!iframe?.contentDocument?.body) return;
                          const resize = () => { try { const h = iframe.contentDocument.body.scrollHeight; if (h > 0) iframe.style.height = h + 'px'; } catch(_) {} };
                          resize();
                          [100, 400, 1000, 2000].forEach(ms => setTimeout(resize, ms));
                          try { Array.from(iframe.contentDocument.images || []).forEach(img => { if (!img.complete) img.addEventListener('load', resize); }); } catch(_) {}
                          try { const ro = new ResizeObserver(resize); ro.observe(iframe.contentDocument.body); } catch(_) {}
                        }} />
                    </div>
                  )}
                </div>
              );
            })()}
            {slideOverDoc && (() => {
              const DocPreviewIcon = getDocIcon(slideOverDoc.mimeType);
              // Pass the doc's owning-account email to getDocEditUrl so
              // ?authuser= switches Google's session to the right account
              // — without it, multi-account users land on "no access."
              const ownerAccount = connectedAccounts.find(a => a.id === slideOverDoc.accountId);
              const editUrl = getDocEditUrl(slideOverDoc, ownerAccount?.gmail_email);
              const editorLabel = getDocEditorLabel(slideOverDoc.mimeType);
              const fileType = FILE_TYPES[slideOverDoc.mimeType];
              const accountIndex = connectedAccounts.findIndex(a => a.id === slideOverDoc.accountId);
              const grad = accountIndex !== -1 ? getAccountGradient(accountIndex) : null;
              const accountName = connectedAccounts[accountIndex]?.account_name || connectedAccounts[accountIndex]?.gmail_email || '';
              return (
                <div style={{ padding: '32px 32px 24px' }}>
                  {grad && (<div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '16px', padding: '3px 10px 3px 6px', borderRadius: 'var(--r-pill)', background: grad.midRgba(0.08), fontSize: '11px', fontWeight: 500, color: 'var(--text-1)' }}><span className="account-dot" style={{ background: grad.gradient, width: 8, height: 8 }} />{accountName}</div>)}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <div style={{ width: '44px', height: '44px', borderRadius: 'var(--r-sm)', background: 'rgba(255, 58, 29, 0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><DocPreviewIcon size={22} strokeWidth={1.5} style={{ color: 'var(--accent)' }} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h1 style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-0)', margin: 0, lineHeight: 1.3 }}>{slideOverDoc.title}</h1>
                      <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: '4px' }}>{fileType?.label || 'Document'}</div>
                    </div>
                  </div>
                  {editUrl && (<button className="btn-ghost btn-edit-doc" onClick={() => window.open(editUrl, '_blank', 'noopener,noreferrer')} style={{ marginBottom: '24px', fontSize: '13px', gap: '6px' }}><ExternalLink size={14} strokeWidth={1.5} /> Edit in {editorLabel}</button>)}
                  {docPreviewLoading && (<div className="doc-preview-skeleton">{Array.from({ length: 5 }).map((_, i) => (<div key={i} className="skeleton-block" style={{ height: i === 0 ? 16 : 12, width: i === 4 ? '60%' : '100%' }} />))}</div>)}
                  {!docPreviewLoading && docPreview?.type === 'embed' && (() => {
                    // P1.16 — assert the embed URL is from a Google host before rendering.
                    // The backend should always return a docs/drive URL, but a future bug
                    // (or a compromised backend) must not be able to load arbitrary script
                    // origins under our `allow-scripts allow-same-origin` sandbox combo.
                    // Also dropped `allow-forms` (preview, no form interaction needed).
                    const url = docPreview.embedUrl || '';
                    const ok = /^https:\/\/(docs|drive)\.google\.com\//i.test(url);
                    if (!ok) {
                      console.error('Refusing non-Google doc preview URL:', url);
                      return <p style={{ color: 'var(--text-3)', fontSize: '13px', margin: '0 0 20px' }}>Preview unavailable</p>;
                    }
                    return (
                      <div className="doc-preview-embed">
                        <iframe
                          src={url}
                          title={docPreview.name || 'Document preview'}
                          sandbox="allow-scripts allow-same-origin allow-popups"
                          referrerPolicy="strict-origin-when-cross-origin"
                          loading="lazy"
                        />
                      </div>
                    );
                  })()}
                  {/* P1.15 — backend never returns docPreview.type === 'html'.
                      The branch existed as live attack surface; if anyone added a
                      backend html response, untrusted content would land in the app
                      origin via dangerouslySetInnerHTML. Removed entirely. */}
                  {!docPreviewLoading && docPreview?.type === 'thumbnail' && (<div className="doc-preview-content"><img src={docPreview.url} alt={docPreview.name || slideOverDoc.title} style={{ maxWidth: '100%', borderRadius: '6px' }} /></div>)}
                  {!docPreviewLoading && docPreview?.type === 'none' && (<p style={{ color: 'var(--text-3)', fontSize: '13px', margin: '0 0 20px' }}>Preview not available for this file type</p>)}
                  {/* Defensive fallback: if the backend returned a shape we
                      don't recognize (network error, future schema change,
                      or docPreview is null after fetch), show a brief
                      explanation and let the user click through to Drive
                      directly. Without this, the panel renders empty and
                      looks broken. */}
                  {!docPreviewLoading && docPreview && !['embed', 'thumbnail', 'none'].includes(docPreview.type) && (
                    <p style={{ color: 'var(--text-3)', fontSize: '13px', margin: '0 0 20px' }}>
                      Preview unavailable. Use the &quot;Edit in {editorLabel}&quot; button above to view this file.
                    </p>
                  )}
                  {!docPreviewLoading && !docPreview && (
                    <p style={{ color: 'var(--text-3)', fontSize: '13px', margin: '0 0 20px' }}>
                      Couldn&apos;t load preview. Use the &quot;Edit in {editorLabel}&quot; button above to view this file.
                    </p>
                  )}
                  <div style={{ height: '1px', background: 'var(--line-0)', margin: '24px 0' }} />
                  <div style={{ background: 'var(--bg-3)', borderRadius: '8px', padding: '20px', border: '1px solid var(--line-0)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-2)' }}>Owner</span><span style={{ color: 'var(--text-1)' }}>{slideOverDoc.owner}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-2)' }}>Last edited</span><span style={{ color: 'var(--text-1)' }}>{formatRelativeEdit(slideOverDoc.lastEdited)}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-2)' }}>Modified</span><span style={{ color: 'var(--text-1)' }}>{new Date(slideOverDoc.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-2)' }}>Shared</span><span style={{ color: 'var(--text-1)' }}>{slideOverDoc.shared ? 'Yes' : 'No'}</span></div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-2)' }}>Starred</span><span style={{ color: 'var(--text-1)' }}>{slideOverDoc.starred ? 'Yes' : 'No'}</span></div>
                    </div>
                  </div>
                </div>
              );
            })()}
            {slideOverIndex !== null && (() => {
              const items = slideOverEmail ? evFilteredEmails.slice(0, 50) : evFilteredDocs;
              return (<div className="slide-over-nav-hints">{slideOverIndex > 0 && <span>← Previous</span>}<span style={{ flex: 1 }} />{slideOverIndex < items.length - 1 && <span>Next →</span>}</div>);
            })()}
          </div>
        </div>
      )}

      {/* Event edit modal */}
      <EventEditModal
        eventEditOpen={eventEditOpen} selectedEvent={selectedEvent}
        eventEditFields={eventEditFields} setEventEditFields={setEventEditFields}
        eventEditSaving={eventEditSaving} eventEditError={eventEditError}
        closeEventEdit={closeEventEdit} saveEventEdit={saveEventEdit}
      />

      {error && (
        <div className="toast"><span>{error}</span><button onClick={() => setError(null)} className="toast-x" title="Dismiss"><X size={14} /></button></div>
      )}
      {pendingSend && (
        <div className="toast-pending">
          <div className="toast-pending-content">
            <div className="toast-pending-spinner" />
            <span>Sending in <strong>{pendingSend.secondsLeft}s</strong> · {pendingSend.previewSubject}</span>
          </div>
          <button onClick={cancelPendingSend} className="toast-undo">Undo</button>
        </div>
      )}
      {successToast && (
        <div className="toast-success">
          <span>{successToast.message || successToast}</span>
          {successToast.undoFn && (
            <button onClick={() => { undoQueueRef.current.cancel(); successToast.undoFn(); }} className="toast-undo">Undo</button>
          )}
          <button onClick={() => { undoQueueRef.current.flush(); setSuccessToast(null); }} className="toast-x" title="Dismiss"><X size={14} /></button>
        </div>
      )}

      {/* Forced onboarding — see OnboardingModal.js for the full flow.
          Mounts only when user is authed, has ≥1 account, and hasn't
          completed/abandoned. Cannot be dismissed by Escape or overlay
          click; only by completing all 3 steps or the step-1 escape link. */}
      {!onboardingDoneFlag && isAuthed && connectedAccounts.length >= 1 && (
        <OnboardingModal
          connectedAccounts={connectedAccounts}
          handleAddAccount={handleAddAccount}
          onComplete={(state) => {
            setOnboardingDoneFlag(state);
            // Drop the user into the Everything view on full completion —
            // matches the "Open All The Mail →" CTA copy. Abandon path
            // leaves the current view alone (they only have 1 account).
            if (state === 'true') setActiveView('everything');
          }}
        />
      )}

      {/* Scheduled-sends list view — opened from the "X scheduled" pill in
          the top bar. Cancel removes from local state + Supabase. */}
      <ScheduledSendsModal
        open={scheduledListOpen}
        onClose={() => setScheduledListOpen(false)}
        scheduledSends={scheduledSends}
        connectedAccounts={connectedAccounts}
        onCancelSend={(item) => {
          // Remove locally for immediate feedback
          setScheduledSends(prev => prev.filter(s => s.id !== item.id));
          // Best-effort delete from Supabase. Items without an id are
          // localStorage-only (older entries) — nothing to delete server-side.
          if (item.id) {
            fetch(`${API_BASE}/scheduled-sends/${item.id}`, {
              method: 'DELETE',
              credentials: 'include',
            }).catch(() => {});
          }
        }}
      />

      {/* P1.12 — Incremental OAuth scope upgrade prompt. Mounted when
          either (a) the user clicks a "Connect Gmail/Drive/Calendar" CTA
          on an account that hasn't granted the corresponding scope group,
          or (b) any backend route returns 403 { error: 'scope_upgrade_required' }.
          Clicking the CTA navigates the browser to the backend
          /accounts/upgrade-scopes/:group endpoint, which redirects to
          Google's consent screen. */}
      {scopeUpgrade && (
        <ScopeUpgradePrompt
          group={scopeUpgrade.group}
          accountId={scopeUpgrade.accountId}
          accountEmail={scopeUpgrade.accountEmail}
          onDismiss={() => setScopeUpgrade(null)}
        />
      )}

      {/* Command Palette (Cmd+K) */}
      {paletteOpen && (() => {
        const allCommands = [
          { id: 'compose', label: 'Compose new message', hint: 'C', action: () => openCompose('compose') },
          { id: 'search', label: 'Search emails', hint: '/', action: () => { setTimeout(() => searchInputRef.current?.focus(), 0); } },
          { id: 'goto-everything', label: 'Go to Everything View', action: () => setActiveModule('everything') },
          { id: 'goto-mail', label: 'Go to Mail', action: () => setActiveModule('mail') },
          { id: 'goto-docs', label: 'Go to Docs', action: () => setActiveModule('docs') },
          { id: 'goto-cals', label: 'Go to Calendar', action: () => setActiveModule('cals') },
          { id: 'toggle-theme', label: 'Toggle theme', action: () => toggleTheme() },
          { id: 'toggle-conversation', label: 'Toggle conversation view', action: () => setConversationView(v => !v) },
          { id: 'add-account', label: 'Add account', action: () => handleAddAccount() },
          ...(selectedEmail ? [
            { id: 'archive', label: 'Archive selected email', hint: 'E', action: () => archiveEmail(selectedEmail) },
            { id: 'delete', label: 'Delete selected email', hint: '#', action: () => trashEmail(selectedEmail) },
            { id: 'reply', label: 'Reply to selected email', hint: 'R', action: () => openCompose('reply', selectedEmail) },
          ] : []),
          { id: 'shortcuts', label: 'Show keyboard shortcuts', hint: '?', action: () => setShortcutsOpen(true) },
        ];
        const q = paletteQuery.trim().toLowerCase();
        const filtered = q ? allCommands.filter(c => c.label.toLowerCase().includes(q)) : allCommands;
        const safeIndex = filtered.length === 0 ? 0 : Math.min(paletteIndex, filtered.length - 1);
        const closePalette = () => { setPaletteOpen(false); setPaletteQuery(''); setPaletteIndex(0); };
        const runCommand = (cmd) => {
          closePalette();
          if (cmd && cmd.action) cmd.action();
        };
        const onPaletteKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIndex(i => Math.min(i + 1, filtered.length - 1)); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIndex(i => Math.max(i - 1, 0)); return; }
          if (e.key === 'Enter') { e.preventDefault(); runCommand(filtered[safeIndex]); return; }
        };
        return (
          <div className="command-palette-overlay" onClick={closePalette}>
            <div className="command-palette" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                className="command-palette-input"
                placeholder="Type a command…"
                value={paletteQuery}
                onChange={e => { setPaletteQuery(e.target.value); setPaletteIndex(0); }}
                onKeyDown={onPaletteKey}
              />
              <div className="command-palette-list">
                {filtered.length === 0 ? (
                  <div className="command-palette-empty">
                    <div className="command-palette-empty-title">No commands match "{paletteQuery}"</div>
                    <div className="command-palette-empty-hint">Press <kbd>?</kbd> to see all keyboard shortcuts</div>
                  </div>
                ) : filtered.map((cmd, idx) => (
                  <div
                    key={cmd.id}
                    className={`command-palette-item${idx === safeIndex ? ' active' : ''}`}
                    onMouseEnter={() => setPaletteIndex(idx)}
                    onClick={() => runCommand(cmd)}
                  >
                    <span>{cmd.label}</span>
                    {cmd.hint && <span className="command-palette-item-hint">{cmd.hint}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Paywall — two modes:
            BLOCKING (accessGate set): backend gating us out; no dismiss path.
            DISMISSIBLE (?upgrade=required only): legacy path; keep "Maybe later".
       */}
      {paywallOpen && (() => {
        const blocking = !!accessGate;
        const trialAvailable = blocking ? !!accessGate.trialAvailable : false;
        const expired = blocking && accessGate.state === 'expired';
        const title = blocking
          ? (trialAvailable ? 'Start your free trial' : (expired ? 'Subscription expired' : 'Subscribe to continue'))
          : 'Pro plan required';
        const body = blocking && trialAvailable
          ? "14 days of full access. Card required up front — you won't be charged until the trial ends, and you can cancel anytime before then."
          : blocking && expired
            ? 'Your subscription has expired. Resubscribe to restore access to your inbox and connected accounts.'
            : blocking
              ? 'Subscribe to continue using your inbox and connected accounts.'
              : 'Free plan supports a single connected account. Upgrade to Pro to add unlimited Gmail accounts, plus everything else Pro unlocks.';
        const cta = blocking
          ? (trialAvailable ? 'Start free trial' : 'Subscribe')
          : 'Upgrade to Pro';
        return (
          <div className="modal-overlay" onClick={blocking ? undefined : () => setPaywallOpen(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
              <div className="modal-header">
                <span className="modal-header-title">{title}</span>
                {!blocking && (
                  <button className="btn-icon" onClick={() => setPaywallOpen(false)}><X size={16} /></button>
                )}
              </div>
              <div className="modal-body" style={{ padding: '20px 24px 8px' }}>
                <p style={{ margin: '0 0 12px', color: 'var(--text-1)', fontSize: '14px', lineHeight: 1.5 }}>{body}</p>
                <ul style={{ margin: '0 0 8px', padding: '0 0 0 18px', color: 'var(--text-2)', fontSize: '13px', lineHeight: 1.7 }}>
                  <li>Unlimited connected accounts</li>
                  <li>Unified inbox across every mailbox</li>
                  <li>Schedule send, snooze, drafts autosave</li>
                  <li>Priority support</li>
                </ul>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 24px 20px' }}>
                {!blocking && (
                  <button className="btn-ghost" onClick={() => setPaywallOpen(false)} style={{ padding: '8px 16px' }}>Maybe later</button>
                )}
                <button className="btn btn-primary" onClick={() => { handleUpgrade('monthly', 'gate'); }} style={{ padding: '8px 18px' }} disabled={billingLoading}>
                  {billingLoading ? '…' : cta}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Keyboard shortcuts cheatsheet */}
      {shortcutsOpen && (
        <div className="modal-overlay" onClick={() => setShortcutsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <span className="modal-header-title">Keyboard shortcuts</span>
              <button className="btn-icon" onClick={() => setShortcutsOpen(false)}><X size={16} /></button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
              {[
                { group: 'Navigation', items: [
                  { key: 'j', desc: 'Next message' },
                  { key: 'k', desc: 'Previous message' },
                  { key: 'Enter', desc: 'Open selected message' },
                  { key: 'u', desc: 'Back to inbox' },
                  { key: '↑ ↓', desc: 'Scroll / navigate list' },
                ]},
                { group: 'Actions', items: [
                  { key: 'e', desc: 'Archive' },
                  { key: '#', desc: 'Delete' },
                  { key: 's', desc: 'Toggle star' },
                  { key: 'x', desc: 'Select message' },
                  { key: '!', desc: 'Report spam' },
                ]},
                { group: 'Compose', items: [
                  { key: 'c', desc: 'Compose new' },
                  { key: 'r', desc: 'Reply' },
                  { key: 'a', desc: 'Reply all' },
                  { key: 'f', desc: 'Forward' },
                  { key: '/', desc: 'Focus search' },
                ]},
                { group: 'Jump to', items: [
                  { key: 'gi', desc: 'Go to inbox' },
                  { key: 'gd', desc: 'Go to drafts' },
                  { key: 'gt', desc: 'Go to sent' },
                  { key: '⌘K', desc: 'Command palette' },
                  { key: '?', desc: 'Show shortcuts' },
                ]},
              ].map(section => (
                <div key={section.group} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{section.group}</div>
                  {section.items.map(s => (
                    <div key={s.key} className="shortcut-row">
                      <span className="shortcut-desc">{s.desc}</span>
                      <kbd className="shortcut-key">{s.key}</kbd>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Loading gate — covers the app until first data batch is ready */}
      {gateVisible && (
        <div className={`app-gate${appReady ? ' app-gate--out' : ''}`} aria-hidden="true">
          <div className="app-gate-wordmark">
            <span className="wordmark-static">ALL THE</span>
            <span className="wordmark-module" key={GATE_WORDS[gateWordIdx]}>{GATE_WORDS[gateWordIdx]}</span>
          </div>
          <div className="app-loading-bar" />
        </div>
      )}
    </div>
  );
};

export default AllTheMail;
