import { jest } from '@jest/globals';

// Env must be set before any module import.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only-32chars!';

const OWNER_ID = 'user-1';
const OTHER_ID = 'user-2';
const ACCT = 'acct-shared';

// Filter-aware Supabase mock: the gmail_accounts ownership row exists ONLY for
// (id = ACCT, user_id = OWNER_ID). Everyone else sees null → "not found".
jest.unstable_mockModule('@supabase/supabase-js', () => {
  const resolve = (table, filters) => {
    if (table === 'gmail_accounts' && filters.id === ACCT && filters.user_id === OWNER_ID) {
      return { data: { id: ACCT, user_id: OWNER_ID, gmail_email: 'owner@x.com', account_name: 'Owner', granted_scopes: ['mail'] }, error: null };
    }
    return { data: null, error: null };
  };
  const makeBuilder = (table) => {
    const filters = {};
    const builder = {
      select: () => builder,
      eq: (col, val) => { filters[col] = val; return builder; },
      order: () => builder,
      limit: () => builder,
      single: () => Promise.resolve(resolve(table, filters)),
      maybeSingle: () => Promise.resolve(resolve(table, filters)),
      then: (cb) => Promise.resolve(resolve(table, filters)).then(cb),
    };
    return builder;
  };
  return { createClient: jest.fn(() => ({ from: jest.fn((table) => makeBuilder(table)) })) };
});

// lib/google.js — stub every export the routes import so server.js loads, and
// hand back a dummy OAuth client for the contacts fetch.
jest.unstable_mockModule('../lib/google.js', () => ({
  oauth2Client: { generateAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth') },
  newOAuth2Client: jest.fn(() => ({ generateAuthUrl: jest.fn(() => 'https://accounts.google.com') })),
  getOAuth2ClientForAccount: jest.fn(() => Promise.resolve({})),
  buildUpgradeAuthUrl: jest.fn(() => 'https://accounts.google.com'),
  ALL_SCOPES: [], MINIMUM_SCOPES: [], SERVICE_SCOPES: { profile: [] },
  encryptToken: jest.fn(() => 'enc'), decryptToken: jest.fn(() => 'dec'),
  invalidateClientCache: jest.fn(), revokeGoogleGrant: jest.fn(() => Promise.resolve()),
  accountHasGroup: jest.fn(() => Promise.resolve(true)),
}));

// googleapis — gmail returns one sent message with a To header so the contacts
// scan succeeds and populates the cache for the owner.
jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ generateAuthUrl: jest.fn(), setCredentials: jest.fn(), on: jest.fn() })) },
    gmail: jest.fn(() => ({
      users: {
        messages: {
          list: jest.fn(() => Promise.resolve({ data: { messages: [{ id: 'm1' }] } })),
          get: jest.fn(() => Promise.resolve({ data: { payload: { headers: [{ name: 'To', value: 'Contact <contact@x.com>' }] } } })),
        },
      },
    })),
  },
}));

jest.unstable_mockModule('stripe', () => ({ default: jest.fn(() => null) }));

// Bypass the subscription gate — this test is about account-boundary ownership,
// not billing. Pass-through keeps the focus on the contacts cache guarantee.
jest.unstable_mockModule('../middleware/plan.js', () => ({
  requireActiveAccess: (req, res, next) => next(),
  requireActiveAccessOrRedirect: (req, res, next) => next(),
  invalidatePlanCache: jest.fn(),
  getPlan: jest.fn(() => Promise.resolve({ plan: 'pro', status: 'active', isAdmin: false })),
  isProActive: jest.fn(() => true),
}));

const { default: request } = await import('supertest');
const { default: jwt } = await import('jsonwebtoken');
const { default: app } = await import('../server.js');

const cookieFor = (userId) => [`auth_token=${jwt.sign({ userId }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`];

describe('Contacts cache — ownership verified before cache read, keyed by user', () => {
  test('owner gets contacts (and populates the cache)', async () => {
    const res = await request(app)
      .get(`/emails/${ACCT}/contacts`)
      .set('Cookie', cookieFor(OWNER_ID));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.contacts)).toBe(true);
    expect(res.body.contacts.some(c => c.email === 'contact@x.com')).toBe(true);
  });

  test('a different user is NOT served the owner\'s cached contacts (404, no leak)', async () => {
    // Prime the cache as the owner first.
    await request(app).get(`/emails/${ACCT}/contacts`).set('Cookie', cookieFor(OWNER_ID));
    // A non-owner requesting the SAME account id must be rejected — ownership is
    // checked before the cache read, and the cache is keyed by (user, account).
    const res = await request(app)
      .get(`/emails/${ACCT}/contacts`)
      .set('Cookie', cookieFor(OTHER_ID));
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('contacts');
    expect(res.body).toHaveProperty('error');
  });
});
