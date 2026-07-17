// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom (the CRA test environment) does not expose structuredClone, which
// fake-indexeddb relies on for every write. Polyfill it so IndexedDB-backed
// tests (utils/emailCache.test.js) can persist records. Harmless no-op when a
// native structuredClone is already present.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (val) => (val === undefined ? undefined : JSON.parse(JSON.stringify(val)));
}
