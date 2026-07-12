import { jest } from '@jest/globals';

// Required env before importing lib/google.js (it validates on load).
process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

// Track revokeToken calls across constructed OAuth2 clients.
const revokeCalls = [];
let revokeShouldThrow = false;

jest.unstable_mockModule('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ from: jest.fn() })),
}));

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        generateAuthUrl: jest.fn(() => 'https://accounts.google.com/fake'),
        setCredentials: jest.fn(),
        on: jest.fn(),
        revokeToken: jest.fn(async (token) => {
          revokeCalls.push(token);
          if (revokeShouldThrow) throw new Error('network down');
          return { data: {} };
        }),
      })),
    },
  },
}));

const { revokeGoogleGrant, invalidateClientCache } = await import('../lib/google.js');

describe('revokeGoogleGrant', () => {
  beforeEach(() => { revokeCalls.length = 0; revokeShouldThrow = false; });

  test('revokes using the refresh_token when present', async () => {
    const result = await revokeGoogleGrant({ refresh_token: 'rt-123', access_token: 'at-123' });
    expect(result).toEqual({ revoked: true });
    expect(revokeCalls).toEqual(['rt-123']); // prefers refresh_token
  });

  test('falls back to access_token when no refresh_token', async () => {
    const result = await revokeGoogleGrant({ access_token: 'at-only' });
    expect(result.revoked).toBe(true);
    expect(revokeCalls).toEqual(['at-only']);
  });

  test('returns not-revoked (no throw) when there is no token', async () => {
    const result = await revokeGoogleGrant({});
    expect(result).toEqual({ revoked: false, reason: 'no_token' });
    expect(revokeCalls).toHaveLength(0);
  });

  test('swallows revoke errors and reports reason — never throws', async () => {
    revokeShouldThrow = true;
    const result = await revokeGoogleGrant({ refresh_token: 'rt-err' });
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/network down/);
  });
});

describe('invalidateClientCache', () => {
  test('accepts (accountId, userId) and (accountId) without throwing', () => {
    expect(() => invalidateClientCache('acc-1', 'user-1')).not.toThrow();
    expect(() => invalidateClientCache('acc-1')).not.toThrow();
  });
});
