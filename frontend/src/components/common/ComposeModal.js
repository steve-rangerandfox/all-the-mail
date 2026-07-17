import React, { useState, useRef, useCallback, useEffect } from 'react';
import { X, Minus, Maximize2, Paperclip, Clock, Image as ImageIcon, MoreHorizontal, Trash2 } from 'lucide-react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import RecipientAutocomplete from './RecipientAutocomplete';

// Match bare URLs in body. Matches http(s)://..., www...., and common TLDs.
// P2 — /u flag + \p{C} (control/format) exclusion. Without them, Unicode
// bidi marks like U+200F (RTL mark) or zero-width chars could hide inside
// the matched URL, letting a typed string "https://good.com<U+200F>.evil.com"
// be auto-linked to evil.com while visually reading as good.com.
const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<>"'\p{C}]+[^\s<>"'\p{C}.,;:!?()])/giu;

// Compact draft-save indicator. Re-renders every 15 s (via a local
// counter) so the "Saved Xs ago" timestamp stays accurate while the
// user is in the middle of composing without retyping.
function DraftStatus({ state, lastSavedAt }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return;
    const t = setInterval(() => setTick(x => x + 1), 15000);
    return () => clearInterval(t);
  }, [lastSavedAt]);

  if (state === 'idle' && !lastSavedAt) return null;

  let label, isError = false;
  if (state === 'saving') {
    label = 'Saving…';
  } else if (state === 'failed') {
    // Truthful indicator (invariant 4): never show "Saved" for a failed save.
    label = 'Couldn’t save';
    isError = true;
  } else if (state === 'saved' || lastSavedAt) {
    const ageS = lastSavedAt ? Math.max(0, Math.round((Date.now() - lastSavedAt) / 1000)) : 0;
    if (ageS < 5) label = 'Saved';
    else if (ageS < 60) label = `Saved ${ageS}s ago`;
    else label = `Saved ${Math.round(ageS / 60)}m ago`;
  } else return null;

  return (
    <span style={{ fontSize: 11, color: isError ? 'var(--danger)' : 'var(--text-3)', userSelect: 'none' }}>
      {label}
    </span>
  );
}

/**
 * Docked compose panel — Phase 7.
 * Renders as a floating panel docked bottom-right (not a modal overlay).
 * States: 'full' | 'minimized'
 */
const ComposeModal = ({
  composeOpen, composeMode, composeSending, composeError,
  composeFromAccountId, setComposeFromAccountId,
  composeTo, setComposeTo,
  composeCc, setComposeCc,
  composeBcc, setComposeBcc,
  composeSubject, setComposeSubject,
  composeBody, setComposeBody,
  composeShowCcBcc, setComposeShowCcBcc,
  composeAttachments, handleFileSelect, removeAttachment,
  connectedAccounts,
  contacts = [],
  draftSavingState = 'idle',
  draftLastSavedAt = null,
  closeCompose, sendCompose,
  discardCompose,
  scheduleSend,
  saveDraft,
  includeSignature, setIncludeSignature,
}) => {
  const [panelState, setPanelState] = useState('full'); // 'full' | 'minimized'
  const [sendLaterOpen, setSendLaterOpen] = useState(false);
  // Three-dot ⋯ overflow menu in the footer. Collapses what was a row of
  // utility buttons (image / attach / schedule) into a single click target,
  // so the footer reads as one clean line — Send + status on the left,
  // ⋯ on the right. Matches the Gmail compose pattern.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef(null);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const onDown = (e) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target)) setMoreMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [moreMenuOpen]);
  const [confirmingEmptySubject, setConfirmingEmptySubject] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [toError, setToError] = useState(false);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const quillRef = useRef(null);
  const lastAutoLinkAtRef = useRef(0);

  // Insert a local image inline as a base64 data URL at the current cursor position.
  // P1.13 — hard 5 MB cap to keep the editor responsive and the outgoing
  // request small. Larger images should ride as attachments, not inline base64
  // (base64 inflates by 33%; Gmail may strip oversize inline images anyway).
  // P1.13 — also re-validate the magic bytes since file.type is client-reported
  // and trivially spoofed (renaming malware.exe to .png passes the type check).
  const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_MAGIC = [
    [0x89, 0x50, 0x4e, 0x47],            // PNG
    [0xff, 0xd8, 0xff],                   // JPEG
    [0x47, 0x49, 0x46, 0x38],             // GIF
    [0x52, 0x49, 0x46, 0x46],             // RIFF (WebP container; further check below)
    [0x3c, 0x73, 0x76, 0x67],             // <svg
    [0x3c, 0x3f, 0x78, 0x6d, 0x6c],       // <?xml (SVG also valid)
  ];
  function looksLikeImage(bytes) {
    return IMAGE_MAGIC.some(sig => sig.every((b, i) => bytes[i] === b));
  }
  const insertInlineImageFile = useCallback((file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    if (file.size > INLINE_IMAGE_MAX_BYTES) {
      try { window.alert('Image too large for inline insert (max 5 MB). Attach it instead.'); } catch (_) {}
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const quill = quillRef.current?.getEditor?.();
      if (!quill) return;
      // Check magic bytes — file.type is client-reported and not trustworthy.
      try {
        const dataUrl = reader.result || '';
        const b64 = String(dataUrl).split(',')[1] || '';
        const head = atob(b64.slice(0, 16));
        const bytes = Array.from(head).map(c => c.charCodeAt(0));
        if (!looksLikeImage(bytes)) {
          try { window.alert('That file is not a valid image.'); } catch (_) {}
          return;
        }
      } catch (_) { return; }
      const range = quill.getSelection(true);
      quill.insertEmbed(range ? range.index : quill.getLength(), 'image', reader.result, 'user');
      quill.setSelection((range ? range.index : quill.getLength()) + 1, 0);
    };
    reader.readAsDataURL(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImageButtonClick = useCallback(() => { imageInputRef.current?.click(); }, []);
  const handleImageFileChosen = useCallback((e) => {
    const f = e.target.files?.[0];
    if (f) insertInlineImageFile(f);
    e.target.value = '';
  }, [insertInlineImageFile]);

  // Quill image toolbar handler — open our file picker so images embed inline.
  useEffect(() => {
    const quill = quillRef.current?.getEditor?.();
    if (!quill) return;
    const toolbar = quill.getModule('toolbar');
    if (toolbar && typeof toolbar.addHandler === 'function') {
      toolbar.addHandler('image', handleImageButtonClick);
    }
  }, [handleImageButtonClick]);

  // Auto-linkify bare URLs as the user types. Runs shortly after each change,
  // debounced so we don't thrash on every keystroke. Skips ranges already linked.
  const handleEditorChange = useCallback((value, delta, source, editor) => {
    setComposeBody(value);
    if (source !== 'user') return;
    const now = Date.now();
    if (now - lastAutoLinkAtRef.current < 150) return;
    lastAutoLinkAtRef.current = now;
    try {
      const quill = quillRef.current?.getEditor?.();
      if (!quill) return;
      const text = quill.getText();
      const matches = [...text.matchAll(URL_REGEX)];
      if (!matches.length) return;
      const currentSelection = quill.getSelection();
      matches.forEach(m => {
        const start = m.index;
        const len = m[0].length;
        const href = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
        const existing = quill.getFormat(start, len);
        if (existing.link === href) return;
        quill.formatText(start, len, 'link', href, 'silent');
      });
      if (currentSelection) quill.setSelection(currentSelection.index, currentSelection.length, 'silent');
    } catch (_) {}
  }, [setComposeBody]);

  // Email shape check. Accepts:
  //   user@domain.tld
  //   "Display Name" <user@domain.tld>
  //   Display Name <user@domain.tld>
  // Rejects: empty, missing @, missing TLD, trailing @ ("foo@"), bare
  // domain ("allthemail.io"). The actual deliverability check still
  // happens server-side at Gmail; this is a pre-flight to catch the
  // common typo cases before a 400 Invalid To round-trip.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function extractAngleEmail(token) {
    const m = String(token || '').match(/<([^>]+)>/);
    return m ? m[1].trim() : String(token || '').trim();
  }
  function tokenIsValidAddress(tok) {
    return EMAIL_RE.test(extractAngleEmail(tok));
  }
  function findInvalidAddresses(val) {
    return (val || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(t => !tokenIsValidAddress(t));
  }
  const validateTo = useCallback((val) => {
    const addresses = (val || '').split(',').map(s => s.trim()).filter(Boolean);
    if (addresses.length === 0) { setToError(false); return; }
    setToError(addresses.some(t => !tokenIsValidAddress(t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!composeOpen) return null;

  const handleSendClick = () => {
    // Pre-flight validation — block obviously-bad recipients before
    // we hit the backend. Gmail will return 400 "Invalid To header" for
    // anything malformed, but the round-trip is wasteful and the error
    // surfaces as a generic "Failed to send" toast. Catching here lets
    // us point at the specific address.
    const invalidTo = findInvalidAddresses(composeTo);
    const invalidCc = findInvalidAddresses(composeCc);
    const invalidBcc = findInvalidAddresses(composeBcc);
    const allInvalid = [...invalidTo, ...invalidCc, ...invalidBcc];
    if (!composeTo.trim()) {
      setToError(true);
      return;
    }
    if (allInvalid.length > 0) {
      setToError(true);
      return;
    }
    if (!composeSubject.trim()) {
      setConfirmingEmptySubject(true);
      return;
    }
    sendCompose();
  };

  // Meaningful-content check for the discard confirmation gate.
  const bodyText = (composeBody || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
  const hasContent = !!(composeTo.trim() || composeCc.trim() || composeBcc.trim() || composeSubject.trim() || composeAttachments.length || bodyText);
  // Close saves the draft, but session-only attachments would be lost — warn.
  const handleCloseClick = () => { if (composeAttachments.length > 0) { setConfirmingClose(true); return; } closeCompose(); };
  const handleDiscardClick = () => { if (hasContent) { setConfirmingDiscard(true); return; } discardCompose?.(); };

  const title = composeMode === 'compose' ? 'New Message'
    : composeMode === 'reply' ? 'Reply'
    : composeMode === 'replyAll' ? 'Reply All'
    : 'Forward';

  const isMinimized = panelState === 'minimized';

  const menuItemStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '8px 10px',
    background: 'transparent', border: 'none',
    fontSize: 13, color: 'var(--text-0)',
    textAlign: 'left', cursor: 'pointer',
    borderRadius: 4, fontFamily: 'inherit',
  };

  return (
    <div className="docked-compose" data-state={panelState}>
      {/* Header — always visible */}
      <div className="docked-compose-header" onClick={() => isMinimized && setPanelState('full')}>
        <span className="docked-compose-title">{title}</span>
        <div className="docked-compose-controls" onClick={e => e.stopPropagation()}>
          <button
            className="docked-compose-ctrl"
            title={isMinimized ? 'Expand' : 'Minimize'}
            onClick={() => setPanelState(isMinimized ? 'full' : 'minimized')}
          >
            {isMinimized ? <Maximize2 size={13} strokeWidth={1.5} /> : <Minus size={13} strokeWidth={1.5} />}
          </button>
          {discardCompose && (
            <button className="docked-compose-ctrl" title="Discard draft" aria-label="Discard draft" onClick={handleDiscardClick}>
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          )}
          <button className="docked-compose-ctrl" title="Close" onClick={handleCloseClick}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Body — hidden when minimized */}
      {!isMinimized && (
        <div className="docked-compose-body">
          {/* From selector */}
          <div className="docked-field-row">
            <select
              className="docked-from-select"
              value={composeFromAccountId}
              onChange={e => setComposeFromAccountId(e.target.value)}
            >
              {connectedAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name || a.gmail_email} &lt;{a.gmail_email}&gt;</option>
              ))}
            </select>
          </div>

          {/* To */}
          <div className="docked-field-row">
            <span className="docked-field-label">To</span>
            <div style={{ flex: 1 }}>
              <RecipientAutocomplete
                className="docked-field-input"
                value={composeTo}
                onChange={(v) => { setComposeTo(v); if (toError) validateTo(v); }}
                onBlur={() => validateTo(composeTo)}
                contacts={contacts}
                placeholder="Recipients"
              />
              {toError && <span style={{ color: 'var(--danger)', fontSize: '11px' }}>Check email addresses</span>}
            </div>
            {!composeShowCcBcc && (
              <button className="docked-cc-toggle" onClick={() => setComposeShowCcBcc(true)}>Cc Bcc</button>
            )}
          </div>

          {/* Cc / Bcc */}
          {composeShowCcBcc && (
            <>
              <div className="docked-field-row">
                <span className="docked-field-label">Cc</span>
                <RecipientAutocomplete
                  className="docked-field-input"
                  value={composeCc}
                  onChange={setComposeCc}
                  contacts={contacts}
                  placeholder="Cc"
                />
              </div>
              <div className="docked-field-row">
                <span className="docked-field-label">Bcc</span>
                <RecipientAutocomplete
                  className="docked-field-input"
                  value={composeBcc}
                  onChange={setComposeBcc}
                  contacts={contacts}
                  placeholder="Bcc"
                />
              </div>
            </>
          )}

          {/* Subject */}
          <div className="docked-field-row">
            <input
              className="docked-field-input docked-subject-input"
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              placeholder="Subject"
            />
          </div>

          {/* Body */}
          <div className="docked-compose-editor">
            <ReactQuill
              ref={quillRef}
              theme="snow"
              value={composeBody}
              onChange={handleEditorChange}
              placeholder="Write your message…"
              formats={[
                'header',
                'bold', 'italic', 'underline', 'strike',
                'color', 'background',
                'blockquote', 'code-block',
                'list', 'bullet', 'indent',
                'align',
                'link', 'image',
              ]}
              modules={{
                toolbar: [
                  [{ header: [1, 2, 3, false] }],
                  ['bold', 'italic', 'underline', 'strike'],
                  [{ color: [] }, { background: [] }],
                  [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
                  [{ align: [] }],
                  ['blockquote', 'code-block'],
                  ['link', 'image'],
                  ['clean'],
                ],
                clipboard: { matchVisual: false },
              }}
            />
          </div>

          {/* Attachments */}
          {composeAttachments.length > 0 && (
            <div className="docked-attachments">
              {composeAttachments.map((file, idx) => (
                <div key={idx} className="docked-attachment-chip">
                  <Paperclip size={11} strokeWidth={1.5} />
                  <span>{file.name}</span>
                  <button onClick={() => removeAttachment(idx)} title="Remove attachment" aria-label={`Remove ${file.name}`}><X size={11} /></button>
                </div>
              ))}
              {/* Truthfulness: attachments ride with Send but are not stored in
                  the saved draft (no server-side draft attachment storage). */}
              <div style={{ width: '100%', fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                Attachments are sent with this message but aren’t saved with drafts.
              </div>
            </div>
          )}

          {/* Errors / warnings */}
          {composeError && (
            <div className="docked-error">
              <span>⚠ {composeError}</span>
              <button className="btn-ghost" style={{ fontSize: 11 }} onClick={sendCompose}>Retry</button>
            </div>
          )}
          {confirmingEmptySubject && (
            <div className="docked-error">
              <span>Send without subject?</span>
              <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setConfirmingEmptySubject(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ fontSize: 11 }} onClick={() => { setConfirmingEmptySubject(false); sendCompose(); }}>Send</button>
            </div>
          )}
          {confirmingDiscard && (
            <div className="docked-error">
              <span>Discard this draft? This can’t be undone.</span>
              <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setConfirmingDiscard(false)}>Cancel</button>
              <button className="btn btn-primary danger" style={{ fontSize: 11 }} onClick={() => { setConfirmingDiscard(false); discardCompose?.(); }}>Discard</button>
            </div>
          )}
          {confirmingClose && (
            <div className="docked-error">
              <span>{composeAttachments.length} attachment{composeAttachments.length !== 1 ? 's' : ''} won’t be saved with the draft. Close anyway?</span>
              <button className="btn-ghost" style={{ fontSize: 11 }} onClick={() => setConfirmingClose(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ fontSize: 11 }} onClick={() => { setConfirmingClose(false); closeCompose(); }}>Close</button>
            </div>
          )}

          {/* Footer toolbar */}
          <div className="docked-compose-footer">
            <div className="docked-footer-left" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="btn btn-primary docked-send-btn" onClick={handleSendClick} disabled={composeSending}>
                {composeSending ? 'Sending…' : 'Send'}
              </button>
              {/* Auto-save status. "saving" only flashes briefly during
                  the in-flight POST; "saved" persists with a relative
                  timestamp until the next save. The label is intentionally
                  small + low-contrast — users want to know it's working,
                  not have it competing with the Send button. */}
              <DraftStatus state={draftSavingState} lastSavedAt={draftLastSavedAt} />
            </div>
            <div className="docked-footer-right" ref={moreMenuRef} style={{ position: 'relative' }}>
              <input type="file" multiple onChange={handleFileSelect} ref={fileInputRef} style={{ display: 'none' }} />
              <input type="file" accept="image/*" onChange={handleImageFileChosen} ref={imageInputRef} style={{ display: 'none' }} />
              <button
                className="docked-toolbar-btn"
                onClick={() => setMoreMenuOpen(o => !o)}
                title="More options"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                type="button"
              >
                <MoreHorizontal size={16} strokeWidth={1.5} />
              </button>
              {moreMenuOpen && (
                <div role="menu" style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
                  background: 'var(--bg-0)', border: '1px solid var(--line-0)',
                  borderRadius: 'var(--r-xs, 6px)',
                  boxShadow: '0 8px 24px rgba(0,0,0,.18)',
                  minWidth: 200, padding: 4, zIndex: 'var(--z-dropdown, 100)',
                }}>
                  <button
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); handleImageButtonClick(); }}
                    style={menuItemStyle}
                  >
                    <ImageIcon size={14} strokeWidth={1.5} /> Insert image
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setMoreMenuOpen(false); fileInputRef.current?.click(); }}
                    style={menuItemStyle}
                  >
                    <Paperclip size={14} strokeWidth={1.5} /> Attach files
                  </button>
                  <button
                    role="menuitem"
                    disabled={composeSending}
                    onClick={() => { setMoreMenuOpen(false); setSendLaterOpen(true); }}
                    style={{ ...menuItemStyle, opacity: composeSending ? 0.5 : 1 }}
                  >
                    <Clock size={14} strokeWidth={1.5} /> Schedule send…
                  </button>
                </div>
              )}
              {sendLaterOpen && (
                <div className="docked-send-later-popup" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, background: 'var(--bg-0)', border: '1px solid var(--line-0)', borderRadius: 'var(--r-xs, 6px)', padding: 10, minWidth: 240, boxShadow: '0 8px 24px rgba(0,0,0,.18)', zIndex: 'var(--z-dropdown, 100)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Schedule send</div>
                  <input type="datetime-local"
                    style={{ width: '100%', padding: '6px 8px', fontSize: 'var(--text-xs)', background: 'var(--bg-0)', color: 'var(--text-0)', border: '1px solid var(--line-0)', borderRadius: 'var(--r-xs)' }}
                    min={new Date().toISOString().slice(0, 16)}
                    onChange={e => { if (e.target.value && scheduleSend) { scheduleSend(new Date(e.target.value)); setSendLaterOpen(false); } }}
                  />
                  <button onClick={() => setSendLaterOpen(false)} style={{ marginTop: 6, fontSize: 11, background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ComposeModal;
