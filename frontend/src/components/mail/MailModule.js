import React, { useRef, useCallback } from 'react';
import {
  Mail, Search, X, Archive, Trash2, CheckSquare, MinusSquare,
  Paperclip, Download, ArrowLeft, Star, Clock,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  Forward, Reply, Users, BellOff, MailOpen, ShieldAlert,
} from 'lucide-react';
import { Panel, Separator as PanelResizeHandle, Group as PanelGroup } from 'react-resizable-panels';
import Avatar from '../Avatar';
import Sidebar from '../common/Sidebar';
import { API_BASE } from '../../utils/constants';
import { getAccountGradient, buildEmailSrcDoc, emailHtmlHasRemoteImages, stripName, getEmailOnly, formatTime } from '../../utils/helpers';
import { mailKey, emailKey, sameMailItem } from '../../utils/mailIdentity';

const MailModule = ({
  // Split/layout
  splitMode,
  loadRemoteImages, onShowImages,
  fullPageReaderOpen, setFullPageReaderOpen,
  // Email hook outputs
  emails, setEmails,
  selectedEmail, setSelectedEmail,
  selectedThread,
  emailBodies, emailHeaders, emailAttachments,
  isLoadingEmails, isLoadingBody, isLoadingThread,
  emailLoadError,
  setEditMode,
  selectedIds,
  batchWorking,
  starredOverrides,
  snoozedEmails,
  snoozeDropdownEmailId, setSnoozeDropdownEmailId,
  collapsedMsgIds, setCollapsedMsgIds,
  threadExpanded, setThreadExpanded,
  expandedBodies, setExpandedBodies,
  filteredEmails,
  categoryCounts,
  loadEmailsForAccount,
  loadEmailDetails,
  downloadAttachment,
  loadThread,
  trashEmail, archiveEmail, starEmail,
  spamEmail, markRead, markUnread,
  searchAllAccounts, batchAction,
  clearSelection, toggleSelectId, selectRange, selectAllVisible,
  focusedKey,
  reopenDraft,
  snoozeEmail, getSnoozeOptions,
  navigatePrev, navigateNext, onSelectEmail,
  // Other
  activeView,
  activeCategory, setActiveCategory,
  activeMailTab, setActiveMailTab,
  connectedAccounts,
  listContainerRef,
  readerScrollRef,
  iframeRef,
  iframeResizeCleanupRef,
  handleReaderScroll,
  openCompose,
  setError,
  SplitNoneIcon, SplitVerticalIcon, SplitHorizontalIcon,
  searchQuery, setSearchQuery,
  showSearchSuggestions, setShowSearchSuggestions,
  savedSearches, setSavedSearches,
  searchInputRef,
  showMetadata, setShowMetadata,
  readerCompact,
  densityMode,
  useStackedRows,
  swipeRef,
  cascadeTimestampRef,
  cascadeKey,
  sidebarCollapsed, setSidebarCollapsed,
  setSelectedThread,
  setSelectedThreadActiveMessageId,
}) => {
  const rowHeight = { default: 56, comfortable: 64, compact: 46 }[densityMode] || 56;

  // Debounced hover prefetch — fires loadEmailDetails 150 ms after the
  // mouse settles on a row, so casually scrolling past doesn't trigger
  // a flood of fetches but a real "I'm about to click" hover does.
  const hoverTimerRef = useRef(null);
  const handleHoverEnter = useCallback((email) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => { loadEmailDetails(email); }, 150);
  }, [loadEmailDetails]);
  const handleHoverLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
  }, []);

  const goBackToList = () => {
    setSelectedEmail(null);
    setSelectedThread(null);
    setSelectedThreadActiveMessageId(null);
    setFullPageReaderOpen(false);
  };

  const selectedCount = selectedIds.size;

  // ==================== RENDER: EMAIL LIST ====================
  const renderEmailList = () => (
    <div className={`email-list${activeView === 'everything' ? ' messageListSurface' : ''}`} ref={listContainerRef}>
      {activeView === 'everything' && (
        <div style={{ borderBottom: '1px solid var(--line-0)', background: 'transparent' }}>
          <div className="ev-header">
            <div className="ev-dots"><span /><span /><span /></div>
            <span className="ev-title">{activeView === 'everything' ? 'All inboxes' : (connectedAccounts.find(a => a.id === activeView)?.account_name || connectedAccounts.find(a => a.id === activeView)?.gmail_email || 'Inbox')}</span>
            <span className="ev-wordmark">All the mail</span>
          </div>
        </div>
      )}
      <div style={{ borderBottom: '1px solid var(--line)' }}>
        {/* Search bar */}
        <div style={{ padding: '10px 16px 6px', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="search-pill" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <Search size={14} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => setShowSearchSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSearchSuggestions(false), 150)}
                onKeyDown={e => { if (e.key === 'Enter' && searchQuery.trim()) { searchAllAccounts(searchQuery); setShowSearchSuggestions(false); } if (e.key === 'Escape') { setSearchQuery(''); searchInputRef.current?.blur(); } }}
                placeholder="Search mail…"
              />
              {searchQuery && <button style={{ background: 'none', border: 'none', padding: '0 4px', cursor: 'pointer', color: 'var(--text-3)', display: 'flex', alignItems: 'center' }} onClick={() => setSearchQuery('')}><X size={13} /></button>}
            </div>
            {searchQuery.trim() && !savedSearches.includes(searchQuery.trim()) && (
              <button className="btn-ghost" onClick={() => setSavedSearches(prev => [searchQuery.trim(), ...prev].slice(0, 10))} style={{ padding: '4px 10px', fontSize: 11 }} title="Save search">Save</button>
            )}
          </div>
          {showSearchSuggestions && !searchQuery && (
            <div className="search-suggestions">
              {['from:', 'to:', 'subject:', 'has:attachment', 'is:unread', 'is:starred', 'before:', 'after:', 'label:', 'in:inbox'].map(op => (
                <button key={op} className="search-suggestion-item" onMouseDown={() => { setSearchQuery(op); searchInputRef.current?.focus(); }}>
                  <Search size={11} strokeWidth={1.5} style={{ opacity: 0.5 }} />{op}
                </button>
              ))}
            </div>
          )}
        </div>
        {savedSearches.length > 0 && !searchQuery && (
          <div className="saved-searches">
            <div className="saved-searches-label">Saved</div>
            <div className="saved-searches-list">
              {savedSearches.map(q => (
                <div key={q} className="saved-search-chip">
                  <button onClick={() => setSearchQuery(q)} className="saved-search-chip-btn"><Search size={11} strokeWidth={1.5} /> {q}</button>
                  <button onClick={() => setSavedSearches(prev => prev.filter(s => s !== q))} className="saved-search-chip-x" title="Remove"><X size={11} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Persistent list toolbar — always present so selecting an email
            doesn't push the list down with a new row. Replaced the old
            Primary/Social/Promotions/Updates tabs (Gmail's category split
            isn't useful when you've got 4 accounts feeding one view) and
            the conditional batch-action bar (which appeared/disappeared
            and shifted the layout). */}
        <div style={{ padding: '6px 16px 6px', display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
          <button
            onClick={() => { if (selectedCount === filteredEmails.length && selectedCount > 0) clearSelection(); else selectAllVisible(); }}
            title={selectedCount === filteredEmails.length && selectedCount > 0 ? 'Deselect all' : 'Select all'}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', color: 'var(--text-2)' }}
          >
            {selectedCount > 0 && selectedCount === filteredEmails.length ? <CheckSquare size={15} /> : <MinusSquare size={15} />}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-3)', flex: 1 }}>
            {selectedCount > 0
              ? `${selectedCount} selected`
              : (activeCategory === 'primary' ? 'Inbox' : activeCategory.charAt(0).toUpperCase() + activeCategory.slice(1))}
          </span>
          <button
            className="btn-ghost"
            disabled={batchWorking || selectedCount === 0}
            onClick={() => batchAction('archive')}
            style={{ padding: '4px 10px', fontSize: 11, opacity: selectedCount === 0 ? 0.4 : 1 }}
          >
            <Archive size={12} /> Archive
          </button>
          <button
            className="btn-ghost danger"
            disabled={batchWorking || selectedCount === 0}
            onClick={() => batchAction('trash')}
            style={{ padding: '4px 10px', fontSize: 11, opacity: selectedCount === 0 ? 0.4 : 1 }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      </div>
      {isLoadingEmails && filteredEmails.length === 0 ? (
        Array.from({ length: 8 }).map((_, i) => (
          <div className="skeleton-row" key={`sk-${i}`} style={{ minHeight: rowHeight }}>
            <div className="skeleton-block" style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0 }} />
            <div className="skeleton-block" style={{ width: 10, height: 10, borderRadius: 999, flexShrink: 0 }} />
            <div className="skeleton-block" style={{ width: 130 }} />
            <div className="skeleton-block" style={{ flex: 1 }} />
            <div className="skeleton-block" style={{ width: 48 }} />
          </div>
        ))
      ) : filteredEmails.length === 0 ? (
        emailLoadError && (activeView === 'everything' || emailLoadError.accountId === activeView) && (activeCategory ? emailLoadError.category === activeCategory : true) ? (
          <div className="empty-state load-error" style={{ padding: '64px 24px', textAlign: 'center' }}>
            <div className="empty-state-icon" style={{ fontSize: 28, opacity: 0.6, color: 'var(--danger)' }}>⚠</div>
            <div className="empty-state-title">Couldn't load messages</div>
            <div className="empty-state-subtitle" style={{ marginBottom: 16 }}>Check your connection and try again</div>
            <button className="btn-ghost" onClick={() => { if (activeView === 'everything') connectedAccounts.forEach(a => loadEmailsForAccount(a.id, activeCategory)); else loadEmailsForAccount(activeView, activeCategory); }}>Retry</button>
          </div>
        ) : (
          <div style={{ padding: '64px 24px', textAlign: 'center' }}>
            <Mail size={32} style={{ margin: '0 auto 12px', opacity: 0.05, display: 'block' }} />
            <div style={{ color: 'var(--text-2)', fontSize: '13px' }}>{searchQuery ? 'No messages match your search' : `No messages in ${activeCategory}`}</div>
          </div>
        )
      ) : (
        filteredEmails.map((email, idx) => {
          const ekey = emailKey(email);
          const isActive = sameMailItem(selectedEmail, email);
          const isFocused = focusedKey && ekey === focusedKey && !isActive;
          const isSelected = selectedIds.has(ekey);
          const accountId = email.accountId || email.source?.account_id;
          const accountIndex = connectedAccounts.findIndex(a => a.id === accountId);
          const grad = accountIndex !== -1 ? getAccountGradient(accountIndex) : null;
          const isCascading = cascadeTimestampRef ? (Date.now() - cascadeTimestampRef.current) < 1200 : false;
          const cc = isCascading && idx <= 23 ? ' row--intro' : '';
          const cs = isCascading && idx <= 23 ? { '--d': `${Math.min(idx, 23) * 36}ms` } : {};

          const senderLabel = email.threadCount > 1 && email.threadParticipants?.length > 1
            ? email.threadParticipants.slice(0, 3).map(p => p.split(' ')[0]).join(', ') + (email.threadParticipants.length > 3 ? ` +${email.threadParticipants.length - 3}` : '')
            : stripName(email.from || '');
          const threadBadge = email.threadCount > 1;

          const emailStarred = starredOverrides[ekey] !== undefined ? starredOverrides[ekey] : email.isStarred;
          const acct = connectedAccounts[accountIndex];

          return (
            <div key={`${ekey}:${cascadeKey}`} className={`email-item${isActive ? ' active' : ''}${isFocused ? ' focused' : ''}${!email.isRead ? ' unread' : ''}${cc}`}
              onMouseEnter={() => handleHoverEnter(email)}
              onMouseLeave={handleHoverLeave}
              onClick={(e) => {
                // Shift-click extends the selection range; plain click opens.
                if (e.shiftKey) { e.preventDefault(); selectRange(email); return; }
                if (activeCategory === 'drafts' && reopenDraft) { reopenDraft(email); return; }
                onSelectEmail(email);
              }}
              onTouchStart={(e) => { const t = e.touches[0]; swipeRef.current = { startX: t.clientX, startY: t.clientY, currentX: t.clientX, emailId: ekey }; e.currentTarget.dataset.swipe = ''; }}
              onTouchMove={(e) => { if (swipeRef.current.emailId === ekey) { swipeRef.current.currentX = e.touches[0].clientX; const d = e.touches[0].clientX - swipeRef.current.startX; if (d < -15) e.currentTarget.dataset.swipe = 'left'; else if (d > 15) e.currentTarget.dataset.swipe = 'right'; else e.currentTarget.dataset.swipe = ''; } }}
              onTouchEnd={(e) => {
                if (swipeRef.current.emailId !== ekey) return;
                e.currentTarget.dataset.swipe = '';
                const delta = swipeRef.current.currentX - swipeRef.current.startX;
                swipeRef.current = { startX: 0, startY: 0, currentX: 0, emailId: null };
                if (delta < -100) { try { navigator.vibrate?.(10); } catch (_) {} archiveEmail(email); }
                else if (delta > 100) { try { navigator.vibrate?.(10); } catch (_) {} trashEmail(email); }
              }}
              style={{ position: 'relative', padding: '0 12px 0 8px', minHeight: `${rowHeight}px`, ...cs }}>
              {!email.isRead && grad && <span className="unread-marker" style={{ background: grad.gradient }} />}
              {useStackedRows ? (
                <div className="email-row-stacked">
                  <Avatar email={getEmailOnly(email.from || '')} name={stripName(email.from || '')} src={acct?.picture} size={24} />
                  <div className="email-row-stacked-content">
                    <span className="row-sender" style={{ fontWeight: 500, color: !email.isRead ? 'var(--text-0)' : 'var(--text-1)' }}>
                      {senderLabel}
                      {threadBadge && <span className={`thread-count-badge${!email.isRead ? ' thread-count-badge-unread' : ''}`}>{email.threadCount}</span>}
                    </span>
                    <span className="row-subject" style={{ fontWeight: !email.isRead ? 500 : 400, color: !email.isRead ? 'var(--text-0)' : 'var(--text-2)' }}>{email.subject || '(no subject)'}</span>
                  </div>
                  <span className="row-time">{formatTime(email.date)}</span>
                </div>
              ) : (
                <div className="email-row-grid">
                  {/* Checkbox */}
                  <button className={`email-checkbox ${isSelected ? 'checked' : ''}`} onClick={e => { e.stopPropagation(); toggleSelectId(email); }} title={isSelected ? 'Deselect' : 'Select'}>
                    <span className="checkbox-box" />
                  </button>
                  {/* Star */}
                  <button className={`row-star-btn${emailStarred ? ' starred' : ''}`}
                    onClick={e => { e.stopPropagation(); starEmail(email); }}
                    title={emailStarred ? 'Unstar' : 'Star'}>
                    <Star size={14} strokeWidth={1.5} fill={emailStarred ? 'currentColor' : 'none'} />
                  </button>
                  {/* Avatar */}
                  <div className="sender-avatar-wrap">
                    <Avatar email={getEmailOnly(email.from || '')} name={stripName(email.from || '')} size={32}
                      ring={grad && activeView === 'everything' ? grad.g0 : undefined} />
                  </div>
                  {/* Sender + source chip */}
                  <div className="row-sender-group">
                    {activeView === 'everything' && grad && acct && (
                      <span className="row-source-chip" style={{ background: grad.midRgba(0.15), color: grad.g0 }} title={acct.gmail_email}>
                        {(acct.account_name || acct.gmail_email || '').charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="row-sender" style={{ fontWeight: !email.isRead ? 600 : 400, color: !email.isRead ? 'var(--text-0)' : 'var(--text-1)' }}>
                      {senderLabel}
                      {threadBadge && <span className={`thread-count-badge${!email.isRead ? ' thread-count-badge-unread' : ''}`}>{email.threadCount}</span>}
                    </span>
                  </div>
                  {/* Subject + snippet */}
                  <span className="row-subject">
                    <span className="row-subject-title" style={{ fontWeight: !email.isRead ? 500 : 400, color: !email.isRead ? 'var(--text-0)' : 'var(--text-2)' }}>{email.subject || '(no subject)'}</span>
                    {email.snippet && <span className="row-subject-preview">{' \u2014 '}{email.snippet}</span>}
                  </span>
                  {/* Icons */}
                  <div className="row-icons">
                    {email.hasAttachment && <Paperclip size={12} strokeWidth={1.5} style={{ color: 'var(--text-3)', flexShrink: 0 }} />}
                  </div>
                  {/* Time / hover actions */}
                  <HoverActions
                    email={email}
                    archiveEmail={archiveEmail}
                    trashEmail={trashEmail}
                    spamEmail={spamEmail}
                    markRead={markRead}
                    markUnread={markUnread}
                    setSnoozeDropdownEmailId={setSnoozeDropdownEmailId}
                    formatTime={formatTime}
                  />
                </div>
              )}
              {/* Snooze dropdown */}
              {snoozeDropdownEmailId === ekey && (
                <div className="dropdown-menu" style={{ right: 8, top: '100%' }} onMouseDown={e => e.stopPropagation()}>
                  {getSnoozeOptions().map(opt => (
                    <button key={opt.label} className="dropdown-item" onClick={() => snoozeEmail(email, opt.time)}>{opt.label}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  // ==================== RENDER: GMAIL READER ====================
  const renderReader = (email, opts = {}) => {
    if (!email) return (
      <div className="empty-state">
        <div style={{ textAlign: 'center' }}>
          <Mail size={72} style={{ display: 'block', margin: '0 auto 16px', opacity: 0.04 }} />
          <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-2)', marginBottom: '4px' }}>Select a message</div>
          <div style={{ fontSize: '12px', color: 'var(--text-3)' }}>Use arrow keys to navigate</div>
        </div>
      </div>
    );

    const readerKey = emailKey(email);
    const emailIdx = filteredEmails.findIndex(e => sameMailItem(e, email));
    const emailCount = filteredEmails.length;
    const isFullPage = opts.fullPage;
    // Source-account identity: the opened message must always show which
    // connected account it belongs to (invariant 1), matching the list chip.
    const readerAcctIdx = connectedAccounts.findIndex(a => a.id === email.accountId);
    const readerAcct = readerAcctIdx !== -1 ? connectedAccounts[readerAcctIdx] : null;
    const readerGrad = readerAcctIdx !== -1 ? getAccountGradient(readerAcctIdx) : null;

    return (
      <div className="reader-root" key={readerKey} onScroll={handleReaderScroll} ref={readerScrollRef}>
        <div className="reader-toolbar">
          <div className="reader-toolbar-left">
            {isFullPage && (<button className="reader-toolbar-btn" onClick={goBackToList} title="Back to inbox" aria-label="Back to inbox"><ArrowLeft size={16} strokeWidth={1.5} /></button>)}
            <button className="reader-toolbar-btn" onClick={() => archiveEmail(email)} title="Archive" aria-label="Archive email"><Archive size={16} strokeWidth={1.5} /></button>
            <button className="reader-toolbar-btn danger" onClick={() => trashEmail(email)} title="Delete" aria-label="Delete email"><Trash2 size={16} strokeWidth={1.5} /></button>
            {spamEmail && <button className="reader-toolbar-btn" onClick={() => spamEmail(email)} title="Report spam" aria-label="Report spam"><ShieldAlert size={16} strokeWidth={1.5} /></button>}
            <button className="reader-toolbar-btn" onClick={() => (email.isRead ? markUnread : markRead)?.(email)} title={email.isRead ? 'Mark as unread' : 'Mark as read'} aria-label={email.isRead ? 'Mark as unread' : 'Mark as read'}>
              {email.isRead ? <Mail size={16} strokeWidth={1.5} /> : <MailOpen size={16} strokeWidth={1.5} />}
            </button>
            <div style={{ position: 'relative' }}>
              <button className="reader-toolbar-btn" onClick={() => setSnoozeDropdownEmailId(prev => prev === readerKey ? null : readerKey)} title="Snooze" aria-label="Snooze email" aria-expanded={snoozeDropdownEmailId === readerKey} aria-haspopup="true"><Clock size={16} strokeWidth={1.5} /></button>
              {snoozeDropdownEmailId === readerKey && (
                <div onMouseDown={e => e.stopPropagation()} className="dropdown-menu" role="menu">
                  {getSnoozeOptions().map(opt => (
                    <button key={opt.label} className="dropdown-item" role="menuitem" onClick={() => snoozeEmail(email, opt.time)}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="reader-toolbar-right">
            <button className="reader-toolbar-btn" onClick={navigatePrev} disabled={emailIdx <= 0} title="Previous email" aria-label="Previous email"><ChevronLeft size={16} strokeWidth={1.5} /></button>
            <span className="reader-toolbar-count" aria-live="polite" aria-atomic="true">{emailIdx >= 0 ? emailIdx + 1 : '–'} of {emailCount}</span>
            <button className="reader-toolbar-btn" onClick={navigateNext} disabled={emailIdx >= emailCount - 1} title="Next email" aria-label="Next email"><ChevronRight size={16} strokeWidth={1.5} /></button>
          </div>
        </div>
        <div className={`reader-content${readerCompact ? ' reader--compact' : ''}`}>
          {readerAcct && (
            <div className="reader-account-chip" title={readerAcct.gmail_email}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: '3px 10px 3px 8px', borderRadius: 'var(--r-pill)', background: readerGrad ? readerGrad.midRgba(0.1) : 'var(--bg-3)', fontSize: 11, fontWeight: 500, color: 'var(--text-1)' }}>
              <span className="account-dot" style={{ background: readerGrad ? readerGrad.gradient : 'var(--text-3)', width: 8, height: 8, borderRadius: 999, display: 'inline-block' }} />
              {readerAcct.account_name || readerAcct.gmail_email}
            </div>
          )}
          <h1 className="reader-subject">{email.subject || '(no subject)'}</h1>
          <div className="reader-meta">
            <Avatar email={getEmailOnly(email.from || '')} name={stripName(email.from || '')} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '4px' }}>
                <span className="reader-sender">{stripName(email.from || '')}</span>
                <span className="reader-sender-email">{getEmailOnly(email.from || '')}</span>
              </div>
              {showMetadata && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                  <div>From: {emailHeaders[readerKey]?.from || email.from}</div>
                  <div>To: {emailHeaders[readerKey]?.to || '(loading...)'}</div>
                  {emailHeaders[readerKey]?.cc && <div>Cc: {emailHeaders[readerKey]?.cc}</div>}
                  <div>Date: {emailHeaders[readerKey]?.date || new Date(email.date).toLocaleString()}</div>
                </div>
              )}
            </div>
            <span className="reader-date">{new Date(email.date).toLocaleString()}</span>
            <button onClick={() => setShowMetadata(!showMetadata)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)', padding: '4px', display: 'flex', alignItems: 'center', flexShrink: 0 }} title={showMetadata ? 'Hide details' : 'Show details'}>
              {showMetadata ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
          <div className="reader-actions-row">
            <button className="reader-action-icon" onClick={() => openCompose('reply', email)} title="Reply" aria-label="Reply"><Reply size={16} strokeWidth={1.5} /></button>
            <button className="reader-action-icon" onClick={() => openCompose('replyAll', email)} title="Reply all" aria-label="Reply all"><Users size={16} strokeWidth={1.5} /></button>
            <button className="reader-action-icon" onClick={() => openCompose('forward', email)} title="Forward" aria-label="Forward"><Forward size={16} strokeWidth={1.5} /></button>
          </div>
          {/* Label chips */}
          {email.labelIds && email.labelIds.filter(l => !['INBOX','UNREAD','IMPORTANT'].includes(l)).length > 0 && (
            <div className="label-chips">
              {email.labelIds
                .filter(l => !['INBOX','UNREAD','IMPORTANT'].includes(l))
                .map(labelId => {
                  const isSystem = ['STARRED','SENT','DRAFT','TRASH','CATEGORY_PERSONAL','CATEGORY_PROMOTIONS','CATEGORY_SOCIAL','CATEGORY_UPDATES','CATEGORY_FORUMS'].includes(labelId);
                  const labelName = labelId.startsWith('CATEGORY_') ? labelId.replace('CATEGORY_', '').toLowerCase()
                    : labelId.charAt(0) + labelId.slice(1).toLowerCase();
                  return (
                    <span key={labelId} className={`label-chip${isSystem ? ' label-chip-system' : ''}`}>
                      {labelName}
                      {!isSystem && (
                        <button className="label-chip-remove" title="Remove label" onClick={async () => {
                          if (!email.accountId) return;
                          await fetch(`${API_BASE}/emails/${email.accountId}/${email.id}/labels`, {
                            method: 'POST', credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ removeLabelIds: [labelId] }),
                          });
                          setEmails(prev => {
                            // Scope to the acted-on account so a colliding id in
                            // another account keeps its labels.
                            const acc = prev[email.accountId]; if (!acc) return prev;
                            const u = {};
                            for (const c of Object.keys(acc)) {
                              u[c] = (acc[c] || []).map(e2 =>
                                e2.id === email.id ? { ...e2, labelIds: (e2.labelIds || []).filter(l => l !== labelId) } : e2
                              );
                            }
                            return { ...prev, [email.accountId]: u };
                          });
                        }}>
                          <X size={10} />
                        </button>
                      )}
                    </span>
                  );
                })}
            </div>
          )}
          {/* Thread view */}
          {email.threadId && selectedThread?.messages?.length > 1 && !isLoadingThread && (() => {
            const msgs = selectedThread.messages;
            const newestMsg = msgs[msgs.length - 1];

            const isCollapsed = (m) => {
              if (threadExpanded) return false;
              if (collapsedMsgIds.has(m.id)) return true;
              if (!collapsedMsgIds.has('__initialized__')) return m.id !== newestMsg.id;
              return false;
            };

            const toggleMsg = (m) => {
              setCollapsedMsgIds(prev => {
                const next = new Set(prev);
                next.add('__initialized__');
                if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                return next;
              });
            };

            const hiddenMidCount = msgs.length > 4 ? msgs.length - 3 : 0;
            const showHiddenMid = threadExpanded || collapsedMsgIds.has('__showmid__');

            return (
              <div style={{ marginBottom: 16 }}>
                <div className="thread-controls">
                  <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                    Conversation · {msgs.length} messages
                  </span>
                  <button className="thread-control-btn" onClick={() => {
                    setThreadExpanded(false);
                    setCollapsedMsgIds(new Set());
                  }}>Collapse all</button>
                  <button className="thread-control-btn" onClick={() => {
                    setThreadExpanded(true);
                    setCollapsedMsgIds(new Set(['__initialized__']));
                  }}>Expand all</button>
                </div>

                {msgs.map((m, mi) => {
                  const collapsed = isCollapsed(m);
                  const isNewest = m.id === newestMsg.id;

                  if (!showHiddenMid && hiddenMidCount > 0 && mi > 0 && mi < msgs.length - 2 && mi <= msgs.length - 3) {
                    if (mi === 1) {
                      return (
                        <button key="hidden-mid" className="thread-collapsed-group"
                          onClick={() => setCollapsedMsgIds(prev => { const n = new Set(prev); n.add('__showmid__'); return n; })}>
                          <ChevronDown size={14} strokeWidth={1.5} style={{ opacity: 0.5 }} />
                          {hiddenMidCount} older messages
                        </button>
                      );
                    }
                    if (mi > 1 && mi < msgs.length - 2) return null;
                  }

                  if (collapsed) {
                    return (
                      <div key={m.id} className="thread-message-collapsed" onClick={() => toggleMsg(m)}>
                        <Avatar email={getEmailOnly(m.from || '')} name={stripName(m.from || '')} size={24} />
                        <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-1)', flexShrink: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stripName(m.from || '')}</span>
                        <span className="thread-message-collapsed-snippet">{m.snippet || ''}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-3)', flexShrink: 0 }}>{formatTime(m.date || '')}</span>
                      </div>
                    );
                  }

                  // Thread messages all belong to the reader email's account,
                  // so key their bodies/headers by that account + each message id.
                  const msgBody = isNewest ? emailBodies[readerKey] : emailBodies[mailKey(email.accountId, m.id)];
                  const msgHeaders = isNewest ? emailHeaders[readerKey] : emailHeaders[mailKey(email.accountId, m.id)];
                  const expandedBody = !!expandedBodies[m.id];

                  return (
                    <div key={m.id} style={{ border: '1px solid var(--line-0)', borderRadius: 'var(--r-sm)', marginBottom: 8, overflow: 'hidden' }}>
                      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', background: 'var(--bg-2)' }}
                        onClick={() => !isNewest && toggleMsg(m)}>
                        <Avatar email={getEmailOnly(m.from || '')} name={stripName(m.from || '')} size={32} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-0)' }}>{stripName(m.from || '')}</span>
                            <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>{getEmailOnly(m.from || '')}</span>
                          </div>
                          {msgHeaders?.to && <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: 2 }}>To: {msgHeaders.to}</div>}
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-3)', flexShrink: 0 }}>{formatTime(m.date || email.date)}</span>
                        {isNewest && (
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <button className="reader-action-icon" onClick={e => { e.stopPropagation(); openCompose('reply', email); }} title="Reply"><Reply size={14} strokeWidth={1.5} /></button>
                            <button className="reader-action-icon" onClick={e => { e.stopPropagation(); openCompose('forward', email); }} title="Forward"><Forward size={14} strokeWidth={1.5} /></button>
                          </div>
                        )}
                      </div>
                      <div style={{ background: 'var(--email-bg)' }}>
                        {!msgBody ? (
                          <div style={{ padding: '16px', fontSize: '13px', color: 'var(--text-3)' }}>
                            {m.snippet || 'Loading...'}
                          </div>
                        ) : (
                          <>
                            <iframe
                              title={`Thread message ${m.id}`}
                              srcDoc={buildEmailSrcDoc(msgBody, { loadRemoteImages })}
                              sandbox="allow-same-origin allow-popups"
                              scrolling="no"
                              style={{ width: '100%', border: 'none', display: 'block', background: 'var(--email-bg)' }}
                              onLoad={e => {
                                const iframe = e.target;
                                if (!iframe?.contentDocument?.body) return;
                                const resize = () => { try { const h = iframe.contentDocument.body.scrollHeight; if (h > 0) iframe.style.height = (expandedBody ? h : Math.min(h, 360)) + 'px'; } catch(_) {} };
                                resize(); setTimeout(resize, 200); setTimeout(resize, 800);
                              }}
                            />
                            {!expandedBody && msgBody.length > 2000 && (
                              <button className="expand-message-btn" onClick={() => setExpandedBodies(prev => ({ ...prev, [m.id]: true }))}>View entire message</button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div className="email-body-wrapper">
            {isLoadingBody ? (
              <div style={{ padding: '32px', background: 'var(--email-bg)' }}>
                {email.snippet
                  ? <p style={{ color: 'rgba(0,0,0,0.45)', fontSize: '0.875rem', lineHeight: 1.7, margin: 0, fontStyle: 'italic' }}>{email.snippet}</p>
                  : <div style={{ textAlign: 'center', padding: '48px 0', color: 'rgba(0,0,0,0.35)', fontSize: '0.9375rem' }}>Loading…</div>
                }
              </div>
            ) : (
              <>
              {emailHtmlHasRemoteImages(emailBodies[readerKey]) && !loadRemoteImages && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 12px', background: 'var(--bg-3)', borderBottom: '1px solid var(--line-0)', fontSize: '12px', color: 'var(--text-2)' }}>
                  <span>Remote images are hidden to protect your privacy.</span>
                  {onShowImages && <button className="btn-ghost" style={{ fontSize: '12px', padding: '4px 10px', flexShrink: 0 }} onClick={onShowImages}>Show images</button>}
                </div>
              )}
              <iframe title="Email content" ref={iframeRef}
                sandbox="allow-same-origin allow-popups"
                srcDoc={buildEmailSrcDoc(emailBodies[readerKey] || '<div style="padding:16px;">(no content)</div>', { loadRemoteImages })}
                scrolling="no"
                onLoad={() => {
                  if (iframeResizeCleanupRef.current) iframeResizeCleanupRef.current();
                  const iframe = iframeRef.current;
                  if (!iframe?.contentDocument?.body) return;
                  const resize = () => { try { const h = iframe.contentDocument.body.scrollHeight; if (h > 0) iframe.style.height = h + 'px'; } catch(e) {} };
                  resize();
                  const timers = [100, 500, 1000, 2000].map(ms => setTimeout(resize, ms));
                  const imgs = [];
                  try { Array.from(iframe.contentDocument.images || []).forEach(img => { if (!img.complete) { img.addEventListener('load', resize); imgs.push(img); } }); } catch(e) {}
                  let ro; try { ro = new ResizeObserver(resize); ro.observe(iframe.contentDocument.body); } catch(e) {}
                  iframeResizeCleanupRef.current = () => { timers.forEach(clearTimeout); imgs.forEach(i => { try { i.removeEventListener('load', resize); } catch(e) {} }); if (ro) ro.disconnect(); };
                }}
                style={{ width: '100%', border: '0', display: 'block', background: 'var(--email-bg)', borderRadius: '8px', overflow: 'hidden' }} />
              </>
            )}
          </div>
          {emailAttachments[readerKey]?.length > 0 && (
            <div className="attachment-section">
              <div className="attachment-header">
                <Paperclip size={13} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
                {emailAttachments[readerKey].length} attachment{emailAttachments[readerKey].length !== 1 ? 's' : ''}
              </div>
              <div className="attachment-list">
                {emailAttachments[readerKey].map((att, idx) => (
                  <button key={idx} className="btn-ghost" onClick={() => downloadAttachment(email.accountId, email.id, att.attachmentId, att.filename, att.mimeType)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Paperclip size={14} /><span style={{ fontSize: '13px' }}>{att.filename}</span>
                      <span style={{ fontSize: '11px', opacity: 0.5 }}>({(att.size / 1024).toFixed(1)} KB)</span>
                    </div>
                    <Download size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ==================== RENDER: MAIL PANELS ====================
  const SidebarComponent = (
    <Sidebar
      sidebarCollapsed={sidebarCollapsed}
      setSidebarCollapsed={setSidebarCollapsed}
      activeCategory={activeCategory}
      setActiveCategory={setActiveCategory}
      categoryCounts={categoryCounts}
      openCompose={openCompose}
      clearSelection={clearSelection}
      setSelectedEmail={setSelectedEmail}
      setSelectedThread={setSelectedThread}
      setSelectedThreadActiveMessageId={setSelectedThreadActiveMessageId}
      setEditMode={setEditMode}
      setFullPageReaderOpen={setFullPageReaderOpen}
    />
  );

  if (splitMode === 'none') return (
    <>
      <Panel defaultSize="15%" minSize="12%" maxSize="22%" id="sidebar-none">
        {SidebarComponent}
      </Panel>
      <PanelResizeHandle className="panel-resize-handle" />
      <Panel minSize="30%" id="main-none">{fullPageReaderOpen && selectedEmail ? renderReader(selectedEmail, { fullPage: true }) : renderEmailList()}</Panel>
    </>
  );
  if (splitMode === 'vertical') return (
    <>
      <Panel defaultSize="15%" minSize="12%" maxSize="22%" id="sidebar-vert">
        {SidebarComponent}
      </Panel>
      <PanelResizeHandle className="panel-resize-handle" />
      <Panel defaultSize="32%" minSize="22%" id="list-vert">{renderEmailList()}</Panel>
      <PanelResizeHandle className="panel-resize-handle" />
      <Panel minSize="26%" id="reader-vert">{renderReader(selectedEmail)}</Panel>
    </>
  );
  if (splitMode === 'horizontal') return (
    <>
      <Panel defaultSize="15%" minSize="12%" maxSize="22%" id="sidebar-horiz">
        {SidebarComponent}
      </Panel>
      <PanelResizeHandle className="panel-resize-handle" />
      <Panel minSize="40%" id="content-horiz">
        <PanelGroup orientation="vertical" id="atm-horizontal-inner">
          <Panel defaultSize="45%" minSize="25%" id="list-horiz">{renderEmailList()}</Panel>
          <PanelResizeHandle className="panel-resize-handle-vertical" />
          <Panel minSize="25%" id="reader-horiz">{renderReader(selectedEmail)}</Panel>
        </PanelGroup>
      </Panel>
    </>
  );
  return null;
};

// Small inner component to handle hover state locally without polluting parent.
// All actions route through the canonical operations passed from useEmail so
// mouse and keyboard paths stay identical and account-scoped.
const HoverActions = ({ email, archiveEmail, trashEmail, spamEmail, markRead, markUnread, setSnoozeDropdownEmailId, formatTime }) => {
  const [isHovered, setIsHovered] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ display: 'contents' }}
    >
      {isHovered ? (
        <div className="row-hover-actions" onClick={e => e.stopPropagation()}>
          <button className="row-action-btn" onClick={() => archiveEmail(email)} title="Archive"><Archive size={14} strokeWidth={1.5} /></button>
          <button className="row-action-btn danger" onClick={() => trashEmail(email)} title="Delete"><Trash2 size={14} strokeWidth={1.5} /></button>
          {spamEmail && <button className="row-action-btn" onClick={() => spamEmail(email)} title="Report spam"><ShieldAlert size={14} strokeWidth={1.5} /></button>}
          <button className="row-action-btn" onClick={() => (email.isRead ? markUnread : markRead)?.(email)} title={email.isRead ? 'Mark unread' : 'Mark read'}>
            {email.isRead ? <Mail size={14} strokeWidth={1.5} /> : <MailOpen size={14} strokeWidth={1.5} />}
          </button>
          <button className="row-action-btn" onClick={e2 => { e2.stopPropagation(); const k = emailKey(email); setSnoozeDropdownEmailId(prev => prev === k ? null : k); }} title="Snooze"><BellOff size={14} strokeWidth={1.5} /></button>
        </div>
      ) : (
        <span className="row-time" style={{ color: !email.isRead ? 'var(--text-0)' : 'var(--text-3)', fontWeight: !email.isRead ? 500 : 400 }}>{formatTime(email.date)}</span>
      )}
    </div>
  );
};

export default MailModule;
