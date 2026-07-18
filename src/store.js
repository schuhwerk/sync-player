// ## js-store — tiny observable store (no deps): get/set/subscribe/batch

export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  let batchDepth = 0;
  let batchDirty = false;
  let preState = null; // snapshot taken at outermost batch entry

  function shallowEqual(a, b) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
  }

  function notify() {
    for (const fn of subs) fn(state);
  }

  function get() {
    return state;
  }

  function set(patch) {
    const next = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    if (shallowEqual(state, next)) return;
    state = next;
    if (batchDepth > 0) {
      batchDirty = true;
    } else {
      notify();
    }
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function batch(fn) {
    if (batchDepth === 0) preState = state;
    batchDepth++;
    try {
      fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0) {
        const changed = batchDirty && !shallowEqual(preState, state);
        batchDirty = false;
        preState = null;
        if (changed) notify();
      }
    }
  }

  return { get, set, subscribe, batch };
}
