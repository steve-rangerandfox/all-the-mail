import {
  extractEmail, isValidAddress, parseRecipients, stringifyRecipients,
  dedupeRecipients, findInvalidRecipients, excludeAddresses, removeDuplicatesOf,
} from './recipients';

describe('recipients helpers', () => {
  test('extractEmail unwraps angle-bracket addresses', () => {
    expect(extractEmail('"Alice B" <alice@x.com>')).toBe('alice@x.com');
    expect(extractEmail('bob@y.com')).toBe('bob@y.com');
    expect(extractEmail('')).toBe('');
  });

  test('isValidAddress accepts well-formed, rejects typos', () => {
    expect(isValidAddress('alice@x.com')).toBe(true);
    expect(isValidAddress('"Alice" <alice@x.com>')).toBe(true);
    expect(isValidAddress('alice@')).toBe(false);
    expect(isValidAddress('allthemail.io')).toBe(false);
    expect(isValidAddress('')).toBe(false);
  });

  test('parse / stringify round-trip and ignore blanks', () => {
    expect(parseRecipients('a@x.com,  b@y.com ,')).toEqual(['a@x.com', 'b@y.com']);
    expect(stringifyRecipients(['a@x.com', 'b@y.com'])).toBe('a@x.com, b@y.com');
  });

  test('dedupe is case-insensitive by address and keeps first', () => {
    expect(dedupeRecipients(['Alice <a@x.com>', 'a@X.COM', 'b@y.com']))
      .toEqual(['Alice <a@x.com>', 'b@y.com']);
  });

  test('findInvalidRecipients returns only the bad tokens', () => {
    expect(findInvalidRecipients('good@x.com, bad@, ok@y.com')).toEqual(['bad@']);
    expect(findInvalidRecipients('good@x.com')).toEqual([]);
  });

  test('excludeAddresses drops matching addresses (self-exclusion)', () => {
    expect(excludeAddresses(['me@x.com', 'Them <them@y.com>'], ['ME@x.com']))
      .toEqual(['Them <them@y.com>']);
  });

  test('removeDuplicatesOf performs cross-field dedup', () => {
    expect(removeDuplicatesOf(['a@x.com', 'c@z.com'], ['A@X.com', 'b@y.com']))
      .toEqual(['c@z.com']);
  });
});
