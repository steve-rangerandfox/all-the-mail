import {
  blankComposerSession, htmlToText, composerHasContent,
  computeRecipients, buildQuotedHtml, buildComposerSession, recomputeForFrom,
} from './composerSession';

describe('composerSession — blank + content detection', () => {
  test('blank session initializes every field, notably draftId=null', () => {
    const s = blankComposerSession();
    expect(s).toMatchObject({
      mode: 'compose', originalEmail: null, fromAccountId: '', draftId: null,
      to: '', cc: '', bcc: '', subject: '', body: '', baselineBody: '',
      showCcBcc: false, replyContext: null,
    });
  });

  test('composerHasContent: recipients/subject/attachments count', () => {
    expect(composerHasContent({ to: 'a@x.com' })).toBe(true);
    expect(composerHasContent({ subject: 'hi' })).toBe(true);
    expect(composerHasContent({ attachments: [{ name: 'f' }] })).toBe(true);
    expect(composerHasContent({})).toBe(false);
  });

  test('composerHasContent: body counts only when changed from baseline', () => {
    const baselineBody = '<br><br><div>Sig</div>';
    expect(composerHasContent({ body: baselineBody, baselineBody })).toBe(false);
    expect(composerHasContent({ body: '<p>hello</p>' + baselineBody, baselineBody })).toBe(true);
  });

  test('htmlToText strips markup and zero-width', () => {
    expect(htmlToText('<p>Hi<br>there</p>')).toBe('Hi\nthere');
  });
});

describe('composerSession — recipient computation', () => {
  test('reply targets the original sender only', () => {
    expect(computeRecipients({ mode: 'reply', oFrom: 'Alice <a@x.com>', oTo: 'me@z.com', oCc: 'c@y.com' }))
      .toEqual({ to: 'a@x.com', cc: '', bcc: '' });
  });

  test('forward keeps no recipients', () => {
    expect(computeRecipients({ mode: 'forward', oFrom: 'a@x.com', oTo: 'b@y.com' }))
      .toEqual({ to: '', cc: '', bcc: '' });
  });

  test('reply-all excludes the sending self address and dedups', () => {
    const r = computeRecipients({
      mode: 'replyAll',
      oFrom: 'Alice <a@x.com>',
      oTo: 'me@z.com, c@y.com',
      oCc: 'c@y.com, d@w.com',
      selfEmail: 'me@z.com',
    });
    expect(r.to).toBe('a@x.com');
    expect(r.cc).toContain('c@y.com');
    expect(r.cc).toContain('d@w.com');
    expect(r.cc).not.toContain('me@z.com');
    // c@y.com appears once despite being in both To and Cc
    expect(r.cc.match(/c@y\.com/g).length).toBe(1);
  });
});

describe('composerSession — quoting', () => {
  const email = { from: 'Alice <a@x.com>', date: '2024-01-01T00:00:00Z', subject: 'Hi', snippet: 'PREVIEWSTUB' };
  const headers = { from: 'Alice <a@x.com>', to: 'me@z.com', date: 'Jan 1, 2024', subject: 'Hi' };
  const fullBody = '<p>This is the full original body, much longer than a preview.</p>';

  test('reply quote uses the FULL body, not the snippet', () => {
    const q = buildQuotedHtml({ mode: 'reply', headers, email, fullBodyHtml: fullBody });
    expect(q).toContain('full original body');
    expect(q).not.toContain('PREVIEWSTUB');
    expect(q).toContain('blockquote');
  });

  test('forward quote includes forwarded header and full body', () => {
    const q = buildQuotedHtml({ mode: 'forward', headers, email, fullBodyHtml: fullBody });
    expect(q).toContain('Forwarded message');
    expect(q).toContain('full original body');
  });
});

describe('composerSession — buildComposerSession', () => {
  const email = { id: 'm1', accountId: 'A', threadId: 't1', from: 'Alice <a@x.com>', date: '2024-01-01', subject: 'Hi', snippet: 's' };
  const headers = { from: 'Alice <a@x.com>', to: 'me@z.com, bob@y.com', cc: '', subject: 'Hi', date: 'Jan 1' };
  const fullBody = '<p>Original full content here</p>';

  test('reply session: full quote, subject prefixed, draftId null, baseline set', () => {
    const s = buildComposerSession({ mode: 'reply', email, fromAccountId: 'A', headers, fullBodyHtml: fullBody, selfEmail: 'me@z.com' });
    expect(s.to).toBe('a@x.com');
    expect(s.subject).toMatch(/^Re:/);
    expect(s.body).toContain('Original full content here');
    expect(s.draftId).toBeNull();
    expect(s.baselineBody).toBe(s.body);
    expect(s.replyContext).toBeTruthy();
  });

  test('forward session has empty recipients and full body', () => {
    const s = buildComposerSession({ mode: 'forward', email, fromAccountId: 'A', headers, fullBodyHtml: fullBody });
    expect(s.to).toBe('');
    expect(s.subject).toMatch(/^Fwd:/);
    expect(s.body).toContain('Original full content here');
  });

  test('compose session with signature only', () => {
    const s = buildComposerSession({ mode: 'compose', fromAccountId: 'A', signatureHtml: '<div>Sig</div>', includeSignature: true });
    expect(s.to).toBe('');
    expect(s.body).toContain('Sig');
    expect(s.baselineBody).toBe(s.body);
  });

  test('reply-all recomputes exclusion when From switches accounts', () => {
    const s = buildComposerSession({
      mode: 'replyAll', email, fromAccountId: 'A',
      headers: { from: 'Alice <a@x.com>', to: 'me@z.com, bob@y.com', cc: 'me2@w.com' },
      fullBodyHtml: fullBody, selfEmail: 'me@z.com',
    });
    // Originally me@z.com excluded; me2@w.com present in Cc.
    expect(s.cc).toContain('me2@w.com');
    // Switch sending account to me2@w.com → it should now be excluded, me@z.com returns.
    const { to, cc } = recomputeForFrom(s, 'me2@w.com');
    expect(cc).not.toContain('me2@w.com');
    expect(`${to} ${cc}`).toContain('me@z.com');
  });
});
