import { test, expect, describe } from 'bun:test';
import { createStore } from '../src/store.js';

describe('createStore', () => {
  test('get returns initial state', () => {
    const s = createStore({ x: 1 });
    expect(s.get()).toEqual({ x: 1 });
  });

  test('set with object patch shallow-merges and notifies', () => {
    const s = createStore({ x: 1, y: 2 });
    const calls = [];
    s.subscribe(st => calls.push(st));
    s.set({ x: 10 });
    expect(s.get()).toEqual({ x: 10, y: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ x: 10, y: 2 });
  });

  test('set with function patch works', () => {
    const s = createStore({ count: 0 });
    const calls = [];
    s.subscribe(st => calls.push(st));
    s.set(st => ({ count: st.count + 1 }));
    expect(s.get().count).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('no-op set does not notify (shallow-equality guard)', () => {
    const s = createStore({ x: 1, y: 2 });
    const calls = [];
    s.subscribe(st => calls.push(st));
    s.set({ x: 1, y: 2 });
    expect(calls).toHaveLength(0);
    expect(s.get()).toEqual({ x: 1, y: 2 });
  });

  test('subscribe returns working unsubscribe', () => {
    const s = createStore({ v: 0 });
    const calls = [];
    const unsub = s.subscribe(st => calls.push(st));
    s.set({ v: 1 });
    expect(calls).toHaveLength(1);
    unsub();
    s.set({ v: 2 });
    expect(calls).toHaveLength(1); // no new calls after unsub
  });

  test('multiple subscribers all notified', () => {
    const s = createStore({ n: 0 });
    const a = [], b = [];
    s.subscribe(st => a.push(st.n));
    s.subscribe(st => b.push(st.n));
    s.set({ n: 5 });
    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
  });

  test('batch coalesces multiple sets into one notification', () => {
    const s = createStore({ x: 0, y: 0 });
    const calls = [];
    s.subscribe(st => calls.push({ ...st }));
    s.batch(() => {
      s.set({ x: 1 });
      s.set({ y: 2 });
      s.set({ x: 3 });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ x: 3, y: 2 });
  });

  test('batch with no real change does not notify', () => {
    const s = createStore({ x: 1 });
    const calls = [];
    s.subscribe(st => calls.push(st));
    s.batch(() => {
      s.set({ x: 2 });
      s.set({ x: 1 }); // back to original
    });
    expect(calls).toHaveLength(0);
  });

  test('nested batches coalesce into outermost', () => {
    const s = createStore({ a: 0 });
    const calls = [];
    s.subscribe(st => calls.push(st.a));
    s.batch(() => {
      s.set({ a: 1 });
      s.batch(() => {
        s.set({ a: 2 });
      });
      s.set({ a: 3 });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(3);
  });
});
