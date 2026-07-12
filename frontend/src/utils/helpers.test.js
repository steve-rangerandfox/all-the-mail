import {
  stripName,
  ensurePrefix,
  getEmailOnly,
  splitList,
  uniqLower,
  formatRelativeEdit,
  getShortLabel,
  getDocEditUrl,
  getDocIcon,
  getDocEditorLabel,
  hexToRgb,
  getAccountGradient,
  buildEmailSrcDoc,
  emailHtmlHasRemoteImages,
  getSenderLogoUrl,
  sanitizeDocHtml,
} from './helpers';
import { FileText, Table2, Presentation } from 'lucide-react';

// ---------- stripName ----------
describe('stripName', () => {
  it('strips HTML tags from a name string', () => {
    expect(stripName('John <john@example.com>')).toBe('John');
  });
  it('returns empty string for empty input', () => {
    expect(stripName('')).toBe('');
  });
  it('returns the name unchanged if no tags', () => {
    expect(stripName('Alice')).toBe('Alice');
  });
  it('handles null/undefined gracefully', () => {
    expect(stripName(null)).toBe('');
    expect(stripName(undefined)).toBe('');
  });
});

// ---------- ensurePrefix ----------
describe('ensurePrefix', () => {
  it('adds Re: prefix to a plain subject', () => {
    expect(ensurePrefix('Hello', 'Re:')).toBe('Re: Hello');
  });
  it('does not double-add Re: prefix', () => {
    expect(ensurePrefix('Re: Hello', 'Re:')).toBe('Re: Hello');
  });
  it('does not double-add Fwd: prefix', () => {
    expect(ensurePrefix('Fwd: Hello', 'Fwd:')).toBe('Fwd: Hello');
  });
  it('handles case-insensitive existing prefix', () => {
    expect(ensurePrefix('RE: Hello')).toBe('RE: Hello');
    expect(ensurePrefix('fw: Hello')).toBe('fw: Hello');
  });
  it('uses (no subject) for empty subject', () => {
    expect(ensurePrefix('', 'Re:')).toBe('Re: (no subject)');
  });
  it('defaults prefix to Re:', () => {
    expect(ensurePrefix('Test')).toBe('Re: Test');
  });
});

// ---------- getEmailOnly ----------
describe('getEmailOnly', () => {
  it('extracts email from "Name <email>" format', () => {
    expect(getEmailOnly('John Doe <john@example.com>')).toBe('john@example.com');
  });
  it('returns the string as-is if no angle brackets', () => {
    expect(getEmailOnly('john@example.com')).toBe('john@example.com');
  });
  it('handles empty string', () => {
    expect(getEmailOnly('')).toBe('');
  });
  it('handles undefined by using default empty string', () => {
    expect(getEmailOnly(undefined)).toBe('');
  });
});

// ---------- splitList ----------
describe('splitList', () => {
  it('splits comma-separated list', () => {
    expect(splitList('a@x.com, b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('filters out empty entries', () => {
    expect(splitList('a@x.com,, ,b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('returns empty array for empty string', () => {
    expect(splitList('')).toEqual([]);
  });
  it('handles null', () => {
    expect(splitList(null)).toEqual([]);
  });
});

// ---------- uniqLower ----------
describe('uniqLower', () => {
  it('deduplicates emails case-insensitively', () => {
    expect(uniqLower(['John <JOHN@x.com>', 'john@x.com'])).toEqual(['John <JOHN@x.com>']);
  });
  it('returns empty array for empty input', () => {
    expect(uniqLower([])).toEqual([]);
  });
  it('preserves order of first occurrence', () => {
    expect(uniqLower(['a@x.com', 'b@x.com', 'A@x.com'])).toEqual(['a@x.com', 'b@x.com']);
  });
});

// ---------- formatRelativeEdit ----------
describe('formatRelativeEdit', () => {
  it('returns empty string for falsy input', () => {
    expect(formatRelativeEdit(null)).toBe('');
    expect(formatRelativeEdit('')).toBe('');
  });
  it('returns "Edited just now" for very recent date', () => {
    const now = new Date();
    expect(formatRelativeEdit(now.toISOString())).toBe('Edited just now');
  });
  it('returns minutes ago for recent dates', () => {
    const d = new Date(Date.now() - 5 * 60000);
    expect(formatRelativeEdit(d.toISOString())).toBe('Edited 5m ago');
  });
  it('returns hours ago for dates within 24h', () => {
    const d = new Date(Date.now() - 3 * 3600000);
    expect(formatRelativeEdit(d.toISOString())).toBe('Edited 3h ago');
  });
  it('returns "Edited yesterday" for 1 day ago', () => {
    const d = new Date(Date.now() - 1 * 86400000);
    expect(formatRelativeEdit(d.toISOString())).toBe('Edited yesterday');
  });
  it('returns days ago for 2-6 days', () => {
    const d = new Date(Date.now() - 3 * 86400000);
    expect(formatRelativeEdit(d.toISOString())).toBe('Edited 3d ago');
  });
  it('returns formatted date for older dates', () => {
    const d = new Date(Date.now() - 30 * 86400000);
    const result = formatRelativeEdit(d.toISOString());
    expect(result).toMatch(/^Edited /);
    expect(result).not.toMatch(/ago$/);
  });
});

// ---------- getShortLabel ----------
describe('getShortLabel', () => {
  it('returns first word of account_name', () => {
    expect(getShortLabel({ account_name: 'Acme Corp' })).toBe('Acme');
  });
  it('truncates long first words with ellipsis', () => {
    expect(getShortLabel({ account_name: 'Superlongfirstname Lastname' })).toBe('Superlongfirs\u2026');
  });
  it('falls back to email prefix when no name', () => {
    expect(getShortLabel({ account_name: '', gmail_email: 'john@gmail.com' })).toBe('john');
  });
  it('handles missing fields', () => {
    expect(getShortLabel({ account_name: '', gmail_email: '' })).toBe('');
  });
});

// ---------- getDocEditUrl ----------
describe('getDocEditUrl', () => {
  it('returns webViewLink when available', () => {
    expect(getDocEditUrl({ webViewLink: 'https://example.com' })).toBe('https://example.com');
  });
  it('constructs URL from mimeType for Google Docs', () => {
    const doc = { id: 'abc123', mimeType: 'application/vnd.google-apps.document' };
    expect(getDocEditUrl(doc)).toBe('https://docs.google.com/document/d/abc123/edit');
  });
  it('constructs URL for Google Sheets', () => {
    const doc = { id: 'xyz', mimeType: 'application/vnd.google-apps.spreadsheet' };
    expect(getDocEditUrl(doc)).toBe('https://docs.google.com/spreadsheets/d/xyz/edit');
  });
  it('returns null for unknown mimeType without webViewLink', () => {
    expect(getDocEditUrl({ id: '1', mimeType: 'application/pdf' })).toBeNull();
  });
});

// ---------- getDocIcon ----------
describe('getDocIcon', () => {
  it('returns FileText for documents', () => {
    expect(getDocIcon('application/vnd.google-apps.document')).toBe(FileText);
  });
  it('returns Table2 for spreadsheets', () => {
    expect(getDocIcon('application/vnd.google-apps.spreadsheet')).toBe(Table2);
  });
  it('returns Presentation for presentations', () => {
    expect(getDocIcon('application/vnd.google-apps.presentation')).toBe(Presentation);
  });
  it('returns FileText as default', () => {
    expect(getDocIcon('application/octet-stream')).toBe(FileText);
  });
});

// ---------- getDocEditorLabel ----------
describe('getDocEditorLabel', () => {
  it('returns "Google Docs" for document mime type', () => {
    expect(getDocEditorLabel('application/vnd.google-apps.document')).toBe('Google Docs');
  });
  it('returns "Google Sheets" for spreadsheet mime type', () => {
    expect(getDocEditorLabel('application/vnd.google-apps.spreadsheet')).toBe('Google Sheets');
  });
  it('returns "Google Docs" as default for unknown type', () => {
    expect(getDocEditorLabel('application/unknown')).toBe('Google Docs');
  });
});

// ---------- hexToRgb ----------
describe('hexToRgb', () => {
  it('converts hex to RGB object', () => {
    expect(hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
  });
  it('handles hex without #', () => {
    expect(hexToRgb('00FF00')).toEqual({ r: 0, g: 255, b: 0 });
  });
  it('converts black', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('converts white', () => {
    expect(hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

// ---------- getAccountGradient ----------
describe('getAccountGradient', () => {
  it('returns a gradient object with expected properties', () => {
    const result = getAccountGradient(0);
    expect(result).toHaveProperty('gradient');
    expect(result).toHaveProperty('rgb0');
    expect(result).toHaveProperty('rgb1');
    expect(result).toHaveProperty('mid');
    expect(result.gradient).toMatch(/^linear-gradient/);
  });
  it('returns midRgba function that produces rgba string', () => {
    const result = getAccountGradient(0);
    expect(result.midRgba(0.5)).toMatch(/^rgba\(/);
  });
  it('wraps around gradient presets', () => {
    const a = getAccountGradient(0);
    const b = getAccountGradient(8);
    expect(a.gradient).toBe(b.gradient);
  });
});

// ---------- buildEmailSrcDoc ----------
describe('buildEmailSrcDoc', () => {
  it('returns an HTML document string', () => {
    const result = buildEmailSrcDoc('<p>Hello</p>');
    expect(result).toContain('<!doctype html>');
    expect(result).toContain('<p>Hello</p>');
  });
  it('strips input script tags from the email body', () => {
    const result = buildEmailSrcDoc('<script>alert("xss")</script><p>Safe</p>');
    expect(result).not.toContain('alert("xss")');
    expect(result).toContain('<p>Safe</p>');
  });
  it('strips input style tags from the email body', () => {
    const result = buildEmailSrcDoc('<style>body{color:red}</style><p>Text</p>');
    expect(result).not.toContain('body{color:red}');
    expect(result).toContain('<p>Text</p>');
  });
  it('provides fallback for empty/null HTML', () => {
    const result = buildEmailSrcDoc(null);
    expect(result).toContain('(empty)');
  });
  it('blocks remote images by default via CSP (no remote img-src)', () => {
    try { localStorage.removeItem('atm_load_remote_images'); } catch {}
    const result = buildEmailSrcDoc('<img src="https://tracker.example/pixel.gif">');
    expect(result).toContain('Content-Security-Policy');
    expect(result).toContain("img-src data: cid:");
    expect(result).not.toContain('img-src https:');
  });
  it('allows remote images when explicitly opted in', () => {
    const result = buildEmailSrcDoc('<img src="https://cdn.example/logo.png">', { loadRemoteImages: true });
    expect(result).toContain('img-src https: http: data: cid:');
  });
  it('respects the global localStorage opt-in preference', () => {
    try { localStorage.setItem('atm_load_remote_images', 'true'); } catch {}
    const result = buildEmailSrcDoc('<img src="https://cdn.example/logo.png">');
    expect(result).toContain('img-src https: http: data: cid:');
    try { localStorage.removeItem('atm_load_remote_images'); } catch {}
  });
});

// ---------- emailHtmlHasRemoteImages ----------
describe('emailHtmlHasRemoteImages', () => {
  it('detects remote http/https images', () => {
    expect(emailHtmlHasRemoteImages('<img src="https://x.com/a.png">')).toBe(true);
    expect(emailHtmlHasRemoteImages('<img src="http://x.com/a.png">')).toBe(true);
  });
  it('ignores inline data: images and empty input', () => {
    expect(emailHtmlHasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(emailHtmlHasRemoteImages('')).toBe(false);
    expect(emailHtmlHasRemoteImages(null)).toBe(false);
  });
});

// ---------- getSenderLogoUrl (Clearbit leak removed) ----------
describe('getSenderLogoUrl', () => {
  it('never returns a third-party URL (privacy: Clearbit removed)', () => {
    expect(getSenderLogoUrl('Acme <hi@acme.com>')).toBeNull();
    expect(getSenderLogoUrl('someone@gmail.com')).toBeNull();
  });
});

// ---------- sanitizeDocHtml ----------
describe('sanitizeDocHtml', () => {
  it('allows safe tags', () => {
    expect(sanitizeDocHtml('<p>Hello</p>')).toBe('<p>Hello</p>');
  });
  it('strips script tags', () => {
    expect(sanitizeDocHtml('<script>alert("xss")</script>')).toBe('');
  });
  it('allows href and src attributes', () => {
    const result = sanitizeDocHtml('<a href="https://example.com">Link</a>');
    expect(result).toContain('href="https://example.com"');
  });
  it('strips disallowed attributes', () => {
    const result = sanitizeDocHtml('<p onclick="alert()">Test</p>');
    expect(result).not.toContain('onclick');
  });
});
