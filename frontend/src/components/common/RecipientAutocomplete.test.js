import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RecipientAutocomplete from './RecipientAutocomplete';

const setup = (value, onChange = jest.fn(), extra = {}) => {
  render(<RecipientAutocomplete value={value} onChange={onChange} contacts={[]} placeholder="Recipients" {...extra} />);
  return onChange;
};

describe('RecipientAutocomplete (chips)', () => {
  test('renders a chip per committed recipient', () => {
    setup('a@x.com, b@y.com');
    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    expect(screen.getByText('b@y.com')).toBeInTheDocument();
  });

  test('removing a chip emits the value without that recipient', () => {
    const onChange = setup('a@x.com, b@y.com');
    fireEvent.mouseDown(screen.getByLabelText('Remove a@x.com'));
    expect(onChange).toHaveBeenCalledWith('b@y.com');
  });

  test('typing a comma commits the token', () => {
    const onChange = setup('');
    const input = screen.getByPlaceholderText('Recipients');
    fireEvent.change(input, { target: { value: 'new@z.com,' } });
    expect(onChange).toHaveBeenCalledWith('new@z.com');
  });

  test('Enter commits the typed address', () => {
    const onChange = setup('');
    const input = screen.getByPlaceholderText('Recipients');
    fireEvent.change(input, { target: { value: 'typed@z.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('typed@z.com');
  });

  test('invalid recipient is flagged (distinct styling)', () => {
    const { container } = render(<RecipientAutocomplete value="bad@" onChange={jest.fn()} contacts={[]} placeholder="Recipients" />);
    expect(container.querySelector('.recipient-chip-invalid')).toBeTruthy();
  });

  test('duplicate address is de-duplicated on commit', () => {
    const onChange = setup('a@x.com');
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'A@X.com,' } });
    expect(onChange).toHaveBeenCalledWith('a@x.com');
  });

  test('blur commits a half-typed address so it is never dropped', () => {
    const onChange = jest.fn();
    const onBlur = jest.fn();
    render(<RecipientAutocomplete value="" onChange={onChange} contacts={[]} placeholder="Recipients" onBlur={onBlur} />);
    const input = screen.getByPlaceholderText('Recipients');
    fireEvent.change(input, { target: { value: 'half@z.com' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('half@z.com');
    expect(onBlur).toHaveBeenCalled();
  });
});
