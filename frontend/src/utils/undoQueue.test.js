import { createUndoQueue } from './undoQueue';

describe('createUndoQueue', () => {
  let now, timers, q;
  beforeEach(() => {
    now = 0;
    timers = [];
    const st = (fn, ms) => { const id = timers.length; timers.push({ fn, at: now + ms, id, live: true }); return id; };
    const ct = (id) => { if (timers[id]) timers[id].live = false; };
    const advance = (ms) => { now += ms; timers.forEach(t => { if (t.live && t.at <= now) { t.live = false; t.fn(); } }); };
    q = createUndoQueue({ delay: 5000, setTimeout: st, clearTimeout: ct });
    q._advance = advance;
  });

  test('a single scheduled action fires its provider call after the delay', () => {
    const exec = jest.fn();
    q.schedule(exec);
    expect(exec).not.toHaveBeenCalled();
    q._advance(5000);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('rapid successive actions all reach the provider (no dropped ops)', () => {
    const a = jest.fn(); const b = jest.fn(); const c = jest.fn();
    q.schedule(a);            // pending: a
    q.schedule(b);            // flushes a immediately, pending: b
    q.schedule(c);            // flushes b immediately, pending: c
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();
    q._advance(5000);         // c fires on its timer
    expect(c).toHaveBeenCalledTimes(1);
  });

  test('cancel (Undo) skips the provider call', () => {
    const exec = jest.fn();
    q.schedule(exec);
    q.cancel();
    q._advance(10000);
    expect(exec).not.toHaveBeenCalled();
  });

  test('flush runs the provider call immediately (dismiss)', () => {
    const exec = jest.fn(); const onFire = jest.fn();
    q.schedule(exec, onFire);
    q.flush();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('onFire runs after a timer-fired execute', () => {
    const exec = jest.fn(); const onFire = jest.fn();
    q.schedule(exec, onFire);
    q._advance(5000);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
