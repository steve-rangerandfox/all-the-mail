import { validateFile, validateFiles, MAX_FILES, formatBytes } from './attachments';

const file = (name, size = 1000) => ({ name, size });

describe('attachment validation (client mirror of backend limits)', () => {
  test('accepts an ordinary file', () => {
    expect(validateFile(file('report.pdf', 1000)).ok).toBe(true);
  });

  test('rejects blocked executable types with a file-specific message', () => {
    const r = validateFile(file('malware.exe'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/malware\.exe/);
    expect(r.error).toMatch(/not allowed/);
  });

  test('rejects oversize files (>25 MB) naming the file', () => {
    const r = validateFile(file('big.zip', 26 * 1024 * 1024));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/big\.zip/);
    expect(r.error).toMatch(/too large/);
  });

  test('rejects beyond the count cap', () => {
    const r = validateFile(file('extra.txt'), MAX_FILES);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Too many/);
  });

  test('validateFiles partitions accepted vs rejected and respects existing count', () => {
    const existing = Array.from({ length: 9 }, (_, i) => file(`e${i}.txt`));
    const { accepted, rejected } = validateFiles(
      [file('ok.txt'), file('second.txt'), file('bad.bat')],
      existing
    );
    // 9 existing + 1 accepted = 10 (cap); the 2nd is over cap, the .bat is blocked.
    expect(accepted.map(f => f.name)).toEqual(['ok.txt']);
    expect(rejected.map(r => r.name).sort()).toEqual(['bad.bat', 'second.txt']);
  });

  test('formatBytes renders human sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
