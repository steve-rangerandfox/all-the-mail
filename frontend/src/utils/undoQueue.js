// Undo queue for optimistic mail actions (archive / delete / spam / bulk).
//
// The UX: an action mutates the list optimistically and shows a toast with an
// Undo button; the real provider call is deferred for a few seconds so Undo can
// cancel it before it happens. The historical bug was that firing a SECOND
// action within the window replaced the toast and cancelled the first action's
// timer WITHOUT running its deferred provider call — so the first archive/delete
// was silently dropped and the message reappeared on refresh.
//
// This queue guarantees invariant 7 ("optimistic interactions never silently
// drop provider operations"): scheduling a new action first FLUSHES any pending
// one (running its provider call immediately), and cancel() is the only path
// that skips the provider call — and it is reserved for an explicit Undo.
//
// Timer functions are injectable so the guarantee is unit-testable with fake
// timers and without a React mount.

export function createUndoQueue({
  delay = 5000,
  setTimeout: st = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: ct = (id) => clearTimeout(id),
} = {}) {
  let pending = null; // { execute, onFire, timer }

  function flush() {
    if (!pending) return;
    const { execute, timer } = pending;
    ct(timer);
    pending = null;
    try { if (execute) execute(); } catch (_) { /* provider call is fire-and-forget */ }
  }

  /**
   * Schedule an optimistic action's deferred provider call.
   * Any previously-pending action is flushed first so it still reaches the
   * provider. `onFire` runs after the deferred `execute` fires on the timer.
   */
  function schedule(execute, onFire) {
    flush();
    const timer = st(() => {
      pending = null;
      try { if (execute) execute(); } finally { if (onFire) onFire(); }
    }, delay);
    pending = { execute, onFire, timer };
  }

  /** Cancel the pending action WITHOUT running its provider call (Undo only). */
  function cancel() {
    if (!pending) return;
    ct(pending.timer);
    pending = null;
  }

  function hasPending() { return !!pending; }

  return { schedule, flush, cancel, hasPending };
}
