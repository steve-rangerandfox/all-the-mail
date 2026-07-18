import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock react-quill (heavy editor) — same shim the sibling ComposeModal test uses.
jest.mock('react-quill', () => {
  const React = require('react');
  const MockQuill = React.forwardRef((props, ref) =>
    React.createElement('textarea', {
      'data-testid': 'mock-quill',
      value: props.value || '',
      onChange: (e) => props.onChange && props.onChange(e.target.value),
      placeholder: props.placeholder,
      ref,
    })
  );
  MockQuill.displayName = 'MockQuill';
  return MockQuill;
});
jest.mock('react-quill/dist/quill.snow.css', () => {});

import ComposeModal from './ComposeModal';

// ---------------------------------------------------------------------------
// Blocker 2 regression tests — closing after a FAILED draft save must never
// discard work silently. The modal must raise a Retry / Keep editing / Discard
// decision, keep every field intact, and only close on explicit success or
// explicit discard.
//
// The modal delegates preservation to the `closeCompose` prop, which returns
// { closed, failed }. These tests drive that contract with a mock.
// ---------------------------------------------------------------------------

const SAVE_FAILED_TEXT = /Couldn.t save your draft/;

const baseProps = {
  composeOpen: true,
  composeMode: 'compose',
  composeSending: false,
  composeError: null,
  composeFromAccountId: '1',
  setComposeFromAccountId: jest.fn(),
  composeTo: '', setComposeTo: jest.fn(),
  composeCc: '', setComposeCc: jest.fn(),
  composeBcc: '', setComposeBcc: jest.fn(),
  composeSubject: '', setComposeSubject: jest.fn(),
  composeBody: '', setComposeBody: jest.fn(),
  composeShowCcBcc: false, setComposeShowCcBcc: jest.fn(),
  composeAttachments: [], handleFileSelect: jest.fn(), removeAttachment: jest.fn(),
  connectedAccounts: [
    { id: '1', account_name: 'Work', gmail_email: 'work@gmail.com' },
    { id: '2', account_name: 'Personal', gmail_email: 'personal@gmail.com' },
  ],
  sendCompose: jest.fn(),
  scheduleSend: jest.fn(),
  saveDraft: jest.fn(),
};

const meaningful = { composeSubject: 'Quarterly report', composeTo: 'boss@x.com' };

function renderModal(overrides = {}) {
  const props = { ...baseProps, ...overrides };
  return { props, ...render(<ComposeModal {...props} />) };
}

afterEach(() => jest.clearAllMocks());

test('failed save + meaningful content + X does NOT close — raises the decision', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  renderModal({ closeCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Close'));

  expect(await screen.findByText(SAVE_FAILED_TEXT)).toBeInTheDocument();
  expect(closeCompose).toHaveBeenCalledTimes(1);
  // Composer is still mounted with its fields — nothing was dismissed.
  expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
  expect(screen.getByText('Retry save')).toBeInTheDocument();
  expect(screen.getByText('Keep editing')).toBeInTheDocument();
  expect(screen.getByText('Discard')).toBeInTheDocument();
});

test('Retry save success closes safely (dialog clears)', async () => {
  const closeCompose = jest.fn()
    .mockResolvedValueOnce({ closed: false, failed: true })  // initial X
    .mockResolvedValueOnce({ closed: true, failed: false }); // retry succeeds
  renderModal({ closeCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Close'));
  await screen.findByText(SAVE_FAILED_TEXT);

  fireEvent.click(screen.getByText('Retry save'));

  await waitFor(() => expect(screen.queryByText(SAVE_FAILED_TEXT)).not.toBeInTheDocument());
  expect(closeCompose).toHaveBeenCalledTimes(2);
});

test('Retry save failure keeps the composer open (dialog persists)', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  renderModal({ closeCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Close'));
  await screen.findByText(SAVE_FAILED_TEXT);
  fireEvent.click(screen.getByText('Retry save'));

  // Still failing → dialog remains, composer still open.
  await waitFor(() => expect(closeCompose).toHaveBeenCalledTimes(2));
  expect(screen.getByText(SAVE_FAILED_TEXT)).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
});

test('Keep editing dismisses the dialog and preserves fields + attachments', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  const discardCompose = jest.fn();
  renderModal({ closeCompose, discardCompose, ...meaningful, composeAttachments: [{ name: 'a.pdf' }] });

  // With attachments, X first warns; confirm to proceed to the save attempt.
  fireEvent.click(screen.getByTitle('Close'));
  fireEvent.click(screen.getByText('Close')); // attachment warning → proceed
  await screen.findByText(SAVE_FAILED_TEXT);

  fireEvent.click(screen.getByText('Keep editing'));

  await waitFor(() => expect(screen.queryByText(SAVE_FAILED_TEXT)).not.toBeInTheDocument());
  // Nothing discarded; fields + attachment chip intact.
  expect(discardCompose).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
  expect(screen.getByText('a.pdf')).toBeInTheDocument();
});

test('Discard from the decision closes only after explicit confirmation', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  const discardCompose = jest.fn();
  renderModal({ closeCompose, discardCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Close'));
  await screen.findByText(SAVE_FAILED_TEXT);
  // discard not called until the user picks it explicitly
  expect(discardCompose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText('Discard'));
  expect(discardCompose).toHaveBeenCalledTimes(1);
});

test('Minimize never invokes the save-failed dialog or a close', () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  const discardCompose = jest.fn();
  renderModal({ closeCompose, discardCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Minimize'));

  expect(screen.queryByText(SAVE_FAILED_TEXT)).not.toBeInTheDocument();
  expect(closeCompose).not.toHaveBeenCalled();
  expect(discardCompose).not.toHaveBeenCalled();
});

test('empty composer closes normally with no decision dialog', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: true, failed: false });
  renderModal({ closeCompose }); // no content, no attachments

  fireEvent.click(screen.getByTitle('Close'));

  await waitFor(() => expect(closeCompose).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(SAVE_FAILED_TEXT)).not.toBeInTheDocument();
});

test('save-in-progress / unresolved close cannot silently lose content', async () => {
  // closeCompose reports the save could not be confirmed → must not dismiss.
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  renderModal({ closeCompose, ...meaningful });

  fireEvent.click(screen.getByTitle('Close'));

  expect(await screen.findByText(SAVE_FAILED_TEXT)).toBeInTheDocument();
  // The message is still on screen — the To value is a controlled prop and the
  // composer body is still mounted.
  expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
});

test('two-account composer keeps its sending account through the retry/discard decision', async () => {
  const closeCompose = jest.fn().mockResolvedValue({ closed: false, failed: true });
  const discardCompose = jest.fn();
  // Composing from the SECOND account.
  renderModal({ closeCompose, discardCompose, composeFromAccountId: '2', ...meaningful });

  // Sending account is account 2 before the decision.
  expect(screen.getByRole('combobox').value).toBe('2');

  fireEvent.click(screen.getByTitle('Close'));
  await screen.findByText(SAVE_FAILED_TEXT);

  // Still account 2 while the decision is up — identity is not disturbed.
  expect(screen.getByRole('combobox').value).toBe('2');

  fireEvent.click(screen.getByText('Discard'));
  // The parent's discardCompose (closed over the account-2 draft) is invoked.
  expect(discardCompose).toHaveBeenCalledTimes(1);
});
