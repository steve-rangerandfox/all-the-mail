import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock react-quill before importing the component
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

// Mock the CSS import
jest.mock('react-quill/dist/quill.snow.css', () => {});

import ComposeModal from './ComposeModal';

const defaultProps = {
  composeOpen: true,
  composeMode: 'compose',
  composeSending: false,
  composeError: null,
  composeFromAccountId: '1',
  setComposeFromAccountId: jest.fn(),
  composeTo: '',
  setComposeTo: jest.fn(),
  composeCc: '',
  setComposeCc: jest.fn(),
  composeBcc: '',
  setComposeBcc: jest.fn(),
  composeSubject: '',
  setComposeSubject: jest.fn(),
  composeBody: '',
  setComposeBody: jest.fn(),
  composeShowCcBcc: false,
  setComposeShowCcBcc: jest.fn(),
  composeAttachments: [],
  handleFileSelect: jest.fn(),
  removeAttachment: jest.fn(),
  connectedAccounts: [
    { id: '1', account_name: 'Work', gmail_email: 'work@gmail.com' },
    { id: '2', account_name: 'Personal', gmail_email: 'personal@gmail.com' },
  ],
  closeCompose: jest.fn(),
  sendCompose: jest.fn(),
};

const renderModal = (overrides = {}) =>
  render(<ComposeModal {...defaultProps} {...overrides} />);

describe('ComposeModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when composeOpen is false', () => {
    const { container } = renderModal({ composeOpen: false });
    expect(container.innerHTML).toBe('');
  });

  it('renders when composeOpen is true', () => {
    renderModal();
    expect(screen.getByText('New Message')).toBeInTheDocument();
  });

  it('renders To field and Subject placeholder', () => {
    renderModal();
    expect(screen.getByText('To')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Recipients')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
  });

  it('renders From select with connected accounts', () => {
    renderModal();
    // The select option format is: "Work <work@gmail.com>"
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(select.options.length).toBe(2);
  });

  it('shows Send button', () => {
    renderModal();
    expect(screen.getByText('Send')).toBeInTheDocument();
  });

  it('shows Sending… when composeSending is true', () => {
    renderModal({ composeSending: true });
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  it('shows Cc Bcc toggle button when not showing Cc/Bcc', () => {
    renderModal();
    expect(screen.getByText('Cc Bcc')).toBeInTheDocument();
  });

  it('shows Cc/Bcc fields when composeShowCcBcc is true', () => {
    renderModal({ composeShowCcBcc: true });
    expect(screen.getByText('Cc')).toBeInTheDocument();
    expect(screen.getByText('Bcc')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Cc')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Bcc')).toBeInTheDocument();
  });

  it('does not show Cc/Bcc fields when not toggled', () => {
    renderModal({ composeShowCcBcc: false });
    expect(screen.queryByPlaceholderText('Cc')).not.toBeInTheDocument();
  });

  it('calls sendCompose when Send is clicked with a recipient and subject', () => {
    renderModal({ composeSubject: 'Test subject', composeTo: 'a@b.com' });
    fireEvent.click(screen.getByText('Send'));
    expect(defaultProps.sendCompose).toHaveBeenCalled();
  });

  it('shows empty subject confirmation instead of sending', () => {
    renderModal({ composeSubject: '', composeTo: 'a@b.com' });
    fireEvent.click(screen.getByText('Send'));
    expect(screen.getByText('Send without subject?')).toBeInTheDocument();
    expect(defaultProps.sendCompose).not.toHaveBeenCalled();
  });

  it('blocks Send with no recipient (does not call sendCompose)', () => {
    renderModal({ composeSubject: 'Has subject', composeTo: '' });
    fireEvent.click(screen.getByText('Send'));
    expect(defaultProps.sendCompose).not.toHaveBeenCalled();
  });

  it('shows a truthful "Couldn’t save" indicator on save failure', () => {
    renderModal({ draftSavingState: 'failed' });
    expect(screen.getByText('Couldn’t save')).toBeInTheDocument();
  });

  it('renders a discard control and confirms before discarding meaningful content', () => {
    const discardCompose = jest.fn();
    renderModal({ discardCompose, composeSubject: 'Draft in progress' });
    fireEvent.click(screen.getByLabelText('Discard draft'));
    // Confirmation gate — not discarded yet.
    expect(discardCompose).not.toHaveBeenCalled();
    expect(screen.getByText(/Discard this draft/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard'));
    expect(discardCompose).toHaveBeenCalled();
  });

  it('warns that attachments are not saved before closing with attachments', () => {
    const closeCompose = jest.fn();
    renderModal({ closeCompose, composeAttachments: [{ name: 'a.pdf' }] });
    fireEvent.click(screen.getByTitle('Close'));
    // Close is gated behind the attachment-loss warning.
    expect(closeCompose).not.toHaveBeenCalled();
    expect(screen.getByText(/won’t be saved with the draft/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(closeCompose).toHaveBeenCalled();
  });

  it('states that attachments are not saved with drafts', () => {
    renderModal({ composeAttachments: [{ name: 'a.pdf' }] });
    expect(screen.getByText(/aren’t saved with drafts/)).toBeInTheDocument();
  });

  it('calls closeCompose when X button is clicked', () => {
    renderModal();
    // The X close button has title="Close"
    fireEvent.click(screen.getByTitle('Close'));
    expect(defaultProps.closeCompose).toHaveBeenCalled();
  });

  it('displays correct mode title for reply', () => {
    renderModal({ composeMode: 'reply' });
    expect(screen.getByText('Reply')).toBeInTheDocument();
  });

  it('displays correct mode title for forward', () => {
    renderModal({ composeMode: 'forward' });
    expect(screen.getByText('Forward')).toBeInTheDocument();
  });

  it('shows error message when composeError is set', () => {
    renderModal({ composeError: 'Failed to send email' });
    expect(screen.getByText(/Failed to send email/)).toBeInTheDocument();
  });

  it('minimizes and restores panel', () => {
    renderModal();
    // Initially full — Subject placeholder is visible
    expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
    // Click minimize button
    fireEvent.click(screen.getByTitle('Minimize'));
    // Subject input should no longer be visible
    expect(screen.queryByPlaceholderText('Subject')).not.toBeInTheDocument();
    // Click expand
    fireEvent.click(screen.getByTitle('Expand'));
    expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
  });
});
