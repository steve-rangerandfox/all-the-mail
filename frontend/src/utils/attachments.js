// Client-side mirror of the backend's multer attachment restrictions
// (backend/routes/emails.js): 25 MB per file, 10 files max, and a block-list of
// executable/script types by extension. Mirroring here lets the composer give
// file-specific feedback at selection time instead of a generic "Failed to
// send" after a wasted upload. The backend remains the authority — this is a
// pre-flight for UX, not a security control.

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_FILES = 10;

// Mirrors BLOCKED_EXT_RE in backend/routes/emails.js.
export const BLOCKED_EXT_RE = /\.(exe|msi|bat|cmd|com|scr|pif|cpl|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|jar|lnk|dll|sys|hta|inf|reg|app)$/i;

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate one incoming file against the current count.
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateFile(file, currentCount = 0) {
  const name = file?.name || 'file';
  if (currentCount >= MAX_FILES) {
    return { ok: false, error: `Too many files (max ${MAX_FILES})` };
  }
  if (BLOCKED_EXT_RE.test(name)) {
    return { ok: false, error: `${name}: file type not allowed` };
  }
  if (typeof file?.size === 'number' && file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `${name}: too large (${formatBytes(file.size)}, max 25 MB)` };
  }
  return { ok: true };
}

/**
 * Validate a batch of newly-selected files against the already-attached list.
 * Accepts files greedily up to the count cap; returns accepted files and
 * per-file rejection reasons so the UI can name the affected file.
 * @returns {{ accepted: File[], rejected: {name:string,error:string}[] }}
 */
export function validateFiles(newFiles, existing = []) {
  const accepted = [];
  const rejected = [];
  let count = existing.length;
  for (const f of Array.from(newFiles || [])) {
    const res = validateFile(f, count);
    if (res.ok) {
      accepted.push(f);
      count += 1;
    } else {
      rejected.push({ name: f?.name || 'file', error: res.error });
    }
  }
  return { accepted, rejected };
}
