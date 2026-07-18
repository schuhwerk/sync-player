// Browser-global shims + a MockAudioContext so src/player.js (and its
// config.js / cache.js imports) evaluate under `bun test` with no DOM, no real
// IndexedDB, and no audio hardware. Imported for side effects BEFORE player.js
// so window.CFG et al. exist at module-eval time; also exports the mocks.

// ─── Globals ──────────────────────────────────────────────────────────────────
globalThis.window = globalThis;

window.CFG = {
    adapterId: 'test', path: '/', audioExt: ['mp3', 'ogg'],
    canWrite: false, buildVersion: 'test', pw: '', appPw: '',
};

const memStore = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null),
             setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
globalThis.localStorage = memStore();
globalThis.sessionStorage = memStore();

globalThis.navigator = { deviceMemory: 4, hardwareConcurrency: 8, onLine: true };
globalThis.location = { search: '', href: 'http://localhost/', protocol: 'http:' };
globalThis.matchMedia = () => ({ matches: false });

const noopEl = { classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
                 setAttribute() {}, hidden: true, innerHTML: '', dataset: {} };
globalThis.document = {
    body: noopEl,
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ ...noopEl, children: [], appendChild() {}, prepend() {} }),
};

// rAF via setTimeout (macrotask) so player's self-scheduling tick loop yields
// instead of starving the test's own timers. cancel removes a pending id.
let _rafSeq = 0;
const _cancelledRaf = new Set();
globalThis.requestAnimationFrame = fn => {
    const id = ++_rafSeq;
    setTimeout(() => { if (!_cancelledRaf.has(id)) fn(0); else _cancelledRaf.delete(id); }, 0);
    return id;
};
globalThis.cancelAnimationFrame = id => { _cancelledRaf.add(id); };

// openDB() is lazy, but stub indexedDB so any stray call fails gracefully.
globalThis.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror?.({ target: {} }), 0); return r; } };

// ─── MockAudioContext ─────────────────────────────────────────────────────────
export class MockAudioBuffer {
    constructor(duration = 1) {
        this.duration = duration;
        this.numberOfChannels = 1;
        this.sampleRate = 44100;
        this.length = Math.round(duration * this.sampleRate);
    }
    getChannelData() { return new Float32Array(this.length); }
}

class MockGainNode {
    constructor() {
        this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {},
                      cancelScheduledValues() {}, cancelAndHoldAtTime() {} };
    }
    connect() {}
}

class MockBufferSource {
    constructor(ctx) {
        this.buffer = null;
        this.onended = null;
        this._started = false;
        this._stopped = false;
        ctx._sources.push(this);
    }
    connect() {}
    start(when, offset) { this._started = true; this._startOffset = offset ?? 0; }
    stop() {
        if (this._stopped) return;
        this._stopped = true;
        setTimeout(() => { if (this.onended) this.onended(); }, 0);
    }
}

class MockDynamicsCompressor {
    constructor() {
        for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[k] = { value: 0 };
    }
    connect() {}
}

export class MockAudioContext {
    constructor() {
        this.state = 'suspended';
        this.currentTime = 0;
        this.destination = {};
        this._sources = [];
        this._resumeCalls = 0;
        this._suspendCalls = 0;
        this._closeCalls = 0;
        this._listeners = {};
        this._resumeImpl = async () => { this.state = 'running'; };
        this._suspendImpl = async () => { this.state = 'suspended'; };
        this._closeImpl = async () => { this.state = 'closed'; };
    }
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
    _dispatch(type) { (this._listeners[type] || []).forEach(fn => fn()); }
    async resume() { this._resumeCalls++; await this._resumeImpl(); this._dispatch('statechange'); }
    async suspend() { this._suspendCalls++; await this._suspendImpl(); this._dispatch('statechange'); }
    async close() { this._closeCalls++; await this._closeImpl(); this._dispatch('statechange'); }
    createGain() { return new MockGainNode(); }
    createDynamicsCompressor() { return new MockDynamicsCompressor(); }
    createBufferSource() { return new MockBufferSource(this); }
    async decodeAudioData() { await new Promise(r => setTimeout(r, 0)); return new MockAudioBuffer(1.0); }
}

window.AudioContext = MockAudioContext;
window.webkitAudioContext = MockAudioContext;

// ─── Player test helpers ────────────────────────────────────────────────────────
export function fakeFiles(n = 2) {
    return Array.from({ length: n }, (_, i) => ({
        name: `track${i}.mp3`, path: `/track${i}.mp3`, lm: `${i}`, kind: 'audio',
    }));
}

// Build a SyncPlayer wired to an inspectable MockAudioContext, bypassing the
// real `new AudioContext()` inside _ctx().
export function playerWithMockCtx(SyncPlayer, files, ctx) {
    const p = new SyncPlayer(files, () => {});
    p.ctx = ctx;
    p._ctx = () => {
        if (!p.ctx) { p.ctx = new MockAudioContext(); ctx._recreated = true; }
        return p.ctx;
    };
    const lim = ctx.createDynamicsCompressor();
    lim.connect(ctx.destination);
    p.limiter = lim;
    return p;
}

// Simulate fetched-but-not-decoded encoded bytes (mobile pre-play state).
export function injectEncodedBytes(p) {
    const bytes = new ArrayBuffer(128);
    p._encoded = p.files.map(() => bytes);
    p.fetchedFraction = 1;
    p.loadedFraction = 1;
}

// Simulate fully decoded buffers (desktop / post-decode state).
export function injectDecodedBuffers(p) {
    injectEncodedBytes(p);
    p.buffers = p.files.map(() => new MockAudioBuffer(1.0));
    p._encoded = p.files.map(() => null);
    p._deferDecode = false;
    p.duration = 1.0;
    p.loadedFraction = 1;
    p.fetchedFraction = 1;
}
