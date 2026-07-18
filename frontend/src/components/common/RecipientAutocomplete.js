import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { X } from 'lucide-react';
import { parseRecipients, stringifyRecipients, dedupeRecipients, isValidAddress, extractEmail } from '../../utils/recipients';

// Recipient field for compose To/Cc/Bcc.
//
// Committed recipients render as removable chips; an inline input holds the
// address currently being typed. This resolves completed addresses distinctly
// from unfinished input and lets each recipient be edited or removed
// individually — while keeping the historical value/onChange contract (a single
// comma-separated string of committed recipients) so the send/draft payloads and
// reply-all math are unchanged.
//
// Commit triggers: comma, Enter, Tab, selecting a suggestion, or blur (so a
// half-typed address is never silently dropped). Backspace on an empty input
// removes the last chip. Chips whose address fails the shape check are marked
// invalid (red) so problems are visible before Send.

function lastToken(value) {
  const s = String(value || '');
  const i = s.lastIndexOf(',');
  return i === -1 ? s : s.slice(i + 1);
}

const MAX_SUGGESTIONS = 8;

const RecipientAutocomplete = ({
  value,
  onChange,
  contacts,
  placeholder,
  className,
  onBlur,
  inputRef: externalInputRef,
}) => {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const internalInputRef = useRef(null);
  const inputRef = externalInputRef || internalInputRef;
  const containerRef = useRef(null);

  const committed = useMemo(() => parseRecipients(value), [value]);

  const query = draft.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!contacts || contacts.length === 0) return [];
    const chosen = new Set(committed.map(t => extractEmail(t).toLowerCase()));
    const pool = contacts.filter(c => !chosen.has((c.email || '').toLowerCase()));
    if (!query) return pool.slice(0, MAX_SUGGESTIONS);
    const matches = [];
    for (const c of pool) {
      if ((c.email || '').toLowerCase().includes(query) || (c.name || '').toLowerCase().includes(query)) matches.push(c);
      if (matches.length >= MAX_SUGGESTIONS) break;
    }
    return matches;
  }, [contacts, query, committed]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Commit one or more tokens (from typed text) into the committed value.
  const commitTokens = useCallback((raw) => {
    const tokens = parseRecipients(raw);
    if (tokens.length === 0) return;
    const next = dedupeRecipients([...committed, ...tokens]);
    onChange(stringifyRecipients(next));
    setDraft('');
  }, [committed, onChange]);

  const acceptSuggestion = useCallback((c) => {
    const formatted = c.name ? `"${c.name}" <${c.email}>` : c.email;
    onChange(stringifyRecipients(dedupeRecipients([...committed, formatted])));
    setDraft('');
    setOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [committed, onChange, inputRef]);

  const removeChip = useCallback((idx) => {
    onChange(stringifyRecipients(committed.filter((_, i) => i !== idx)));
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [committed, onChange, inputRef]);

  const onInputChange = (e) => {
    const v = e.target.value;
    // A comma finalizes the token(s) typed so far.
    if (v.includes(',')) { commitTokens(v); setOpen(true); return; }
    setDraft(v);
    setOpen(true);
  };

  const onKeyDown = (e) => {
    if (open && suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActiveIdx(i => e.key === 'ArrowDown' ? (i + 1) % suggestions.length : (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (open && suggestions.length > 0 && draft.trim()) { e.preventDefault(); acceptSuggestion(suggestions[activeIdx]); return; }
      if (draft.trim()) { e.preventDefault(); commitTokens(draft); return; }
      // else let Tab move focus / Enter do nothing
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Backspace' && !draft && committed.length > 0) {
      e.preventDefault();
      removeChip(committed.length - 1);
    }
  };

  const handleBlur = () => {
    // Never drop a half-typed address: commit it on blur.
    if (draft.trim()) commitTokens(draft);
    if (onBlur) onBlur();
  };

  return (
    <div ref={containerRef} className="recipient-field" style={{ position: 'relative', flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {committed.map((tok, i) => {
        const valid = isValidAddress(tok);
        return (
          <span key={`${tok}-${i}`} className={`recipient-chip${valid ? '' : ' recipient-chip-invalid'}`}
            title={valid ? extractEmail(tok) : 'Invalid address'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '1px 4px 1px 8px', borderRadius: 999, fontSize: 12,
              background: valid ? 'var(--bg-3)' : 'rgba(255,58,29,0.12)',
              color: valid ? 'var(--text-1)' : 'var(--danger)',
              border: `1px solid ${valid ? 'var(--line-0)' : 'var(--danger)'}`,
              maxWidth: '100%',
            }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tok}</span>
            <button type="button" aria-label={`Remove ${extractEmail(tok)}`} onMouseDown={(e) => { e.preventDefault(); removeChip(i); }}
              style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}>
              <X size={11} />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        className={className}
        value={draft}
        onChange={onInputChange}
        onFocus={() => setOpen(true)}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
        placeholder={committed.length === 0 ? placeholder : ''}
        autoComplete="off"
        style={{ flex: 1, minWidth: 120, border: 'none', background: 'transparent', outline: 'none' }}
      />
      {open && suggestions.length > 0 && (
        <div role="listbox" style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2,
          background: 'var(--bg-0)', border: '1px solid var(--line-0)', borderRadius: 'var(--r-xs, 6px)',
          boxShadow: '0 8px 24px rgba(0,0,0,.16)', maxHeight: 280, overflowY: 'auto', zIndex: 'var(--z-dropdown, 100)',
        }}>
          {suggestions.map((c, i) => (
            <div key={c.email} role="option" aria-selected={i === activeIdx}
              onMouseDown={(e) => { e.preventDefault(); acceptSuggestion(c); }}
              onMouseEnter={() => setActiveIdx(i)}
              style={{ padding: '6px 10px', cursor: 'pointer', background: i === activeIdx ? 'var(--bg-1, #f5f5f0)' : 'transparent', fontSize: 13, lineHeight: 1.35, borderBottom: i < suggestions.length - 1 ? '1px solid var(--line-0)' : 'none' }}>
              {c.name ? (<><span style={{ color: 'var(--text-0)' }}>{c.name}</span><span style={{ color: 'var(--text-3)', marginLeft: 6 }}>&lt;{c.email}&gt;</span></>) : (<span style={{ color: 'var(--text-0)' }}>{c.email}</span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RecipientAutocomplete;
