// ## js-cache — IndexedDB stores (waveforms, listings, pinned, audio), session bytes, computePeaks
// IndexedDB stores precomputed waveform peaks per file (Float32Array of length WF_PEAKS).
// Key: `${path}::${lastModified}` — changing lm invalidates old peaks.
// Non-pinned encoded bytes also get a tab-scoped LRU in RAM so revisiting a folder
// in the same session doesn't re-fetch everything. Long-lived offline copies still
// live in IndexedDB behind the explicit "Available offline" toggle.
// 500 covers a ~500px-wide waveform at 1px/peak — anything denser is wasted on
// every layout we ship. Halves the cached Float32Array per file.
import { CFG, IS_MOBILE, loadBytes, _registerListCache } from './config.js';

export const WF_PEAKS = 500;
const DB_NAME = 'syncplayer';
const STORE = 'waveforms', LIST_STORE = 'listings', PINNED_STORE = 'pinned', AUDIO_STORE = 'audio';
export const TREE_STORAGE_KEY = `syncplayer.tree::${CFG.adapterId || 'default'}`;
export const TREE_CRAWL_MAX_DEPTH = 1;
const SESSION_AUDIO_CACHE_LIMIT = (() => {
    const mem = Number(navigator.deviceMemory || 0);
    if (IS_MOBILE) {
        if (mem >= 8) return 64 * 1024 * 1024;
        if (mem >= 4) return 32 * 1024 * 1024;
        return 16 * 1024 * 1024;
    }
    if (mem >= 16) return 192 * 1024 * 1024;
    if (mem >= 8) return 128 * 1024 * 1024;
    if (mem >= 4) return 96 * 1024 * 1024;
    return 64 * 1024 * 1024;
})();

let _dbPromise = null;
const _sessionAudioCache = new Map();
let _sessionAudioCacheBytes = 0;
export const openDB = () => {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, 3);
        r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains(STORE))        db.createObjectStore(STORE);
            if (!db.objectStoreNames.contains(LIST_STORE))   db.createObjectStore(LIST_STORE);
            if (!db.objectStoreNames.contains(PINNED_STORE)) db.createObjectStore(PINNED_STORE);
            if (!db.objectStoreNames.contains(AUDIO_STORE))  db.createObjectStore(AUDIO_STORE);
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => { _dbPromise = null; rej(r.error); };
    });
    return _dbPromise;
};

export const storeGet = async (store, key) => {
    try {
        const db = await openDB();
        return new Promise(res => {
            const r = db.transaction(store).objectStore(store).get(key);
            r.onsuccess = () => res(r.result || null);
            r.onerror = () => res(null);
        });
    } catch (_) { return null; }
};

export const storePut = async (store, key, val) => {
    try {
        const db = await openDB();
        return new Promise(res => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(val, key);
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        });
    } catch (_) {}
};

export const storeDel = async (store, key) => {
    try {
        const db = await openDB();
        return new Promise(res => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        });
    } catch (_) {}
};

export const cacheGet      = key      => storeGet(STORE, key);
export const cachePut      = (key, v) => storePut(STORE, key, v);
export const listCacheGet  = key      => storeGet(LIST_STORE, key);
export const listCachePut  = (key, v) => storePut(LIST_STORE, key, v);
export const getPin        = path     => storeGet(PINNED_STORE, path);
export const setPin        = (p, v)   => storePut(PINNED_STORE, p, v);
export const delPin        = path     => storeDel(PINNED_STORE, path);
export const audioCacheGet = key      => storeGet(AUDIO_STORE, key);
export const audioCachePut = (key, v) => storePut(AUDIO_STORE, key, v);
export const audioCacheDel = key      => storeDel(AUDIO_STORE, key);
export const audioKey      = f        => `${f.path}::${f.lm || ''}`;

function cloneBytes(bytes) {
    return bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes;
}

function sessionAudioCacheGet(key) {
    const hit = _sessionAudioCache.get(key);
    if (!hit) return null;
    _sessionAudioCache.delete(key);
    _sessionAudioCache.set(key, hit);
    return cloneBytes(hit.bytes);
}

function sessionAudioCachePut(key, bytes) {
    if (!(bytes instanceof ArrayBuffer) || !SESSION_AUDIO_CACHE_LIMIT) return;
    const size = bytes.byteLength || 0;
    if (!size || size > SESSION_AUDIO_CACHE_LIMIT) return;
    const prev = _sessionAudioCache.get(key);
    if (prev) _sessionAudioCacheBytes -= prev.size;
    _sessionAudioCache.delete(key);
    _sessionAudioCache.set(key, { bytes: cloneBytes(bytes), size });
    _sessionAudioCacheBytes += size;
    while (_sessionAudioCacheBytes > SESSION_AUDIO_CACHE_LIMIT && _sessionAudioCache.size > 1) {
        const oldestKey = _sessionAudioCache.keys().next().value;
        if (typeof oldestKey === 'undefined') break;
        const oldest = _sessionAudioCache.get(oldestKey);
        _sessionAudioCache.delete(oldestKey);
        _sessionAudioCacheBytes -= oldest?.size || 0;
    }
}

export async function loadCachedBytes(file, options = {}) {
    const key = audioKey(file);
    let bytes = sessionAudioCacheGet(key);
    if (bytes) return { bytes, source: 'session' };
    bytes = await audioCacheGet(key);
    if (bytes) {
        sessionAudioCachePut(key, bytes);
        return { bytes, source: 'idb' };
    }
    bytes = await loadBytes(file.path);
    sessionAudioCachePut(key, bytes);
    if (options.persist) {
        try { await audioCachePut(key, bytes); } catch (_) {}
    }
    return { bytes, source: 'network' };
}

export const storeGetAllKeys = async (store) => {
    try {
        const db = await openDB();
        return new Promise(res => {
            const r = db.transaction(store).objectStore(store).getAllKeys();
            r.onsuccess = () => res(r.result || []);
            r.onerror   = () => res([]);
        });
    } catch (_) { return []; }
};

// Set of folder paths currently pinned — loaded before each render so badges
// show without an extra async round-trip inside renderFolderItems.
export let _pinnedPaths = new Set();
export async function loadPinnedPaths() {
    _pinnedPaths = new Set(await storeGetAllKeys(PINNED_STORE));
}

export function folderOfflineState(path) {
    if (_pinnedPaths.has(path)) return 'offline';
    for (const pinnedPath of _pinnedPaths) {
        if (pinnedPath === '/' || pinnedPath.startsWith(path + '/')) return 'contains';
        if (path.startsWith(pinnedPath + '/')) return 'offline';
    }
    return '';
}

// Per segment, max(|sample|) → one Float32. WF_PEAKS segments total.
export function computePeaks(audioBuffer, n = WF_PEAKS) {
    const ch = audioBuffer.getChannelData(0);
    const step = ch.length / n;
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const start = (i * step) | 0;
        const end = Math.min(ch.length, ((i + 1) * step) | 0);
        let mx = 0;
        for (let j = start; j < end; j++) { const v = Math.abs(ch[j]); if (v > mx) mx = v; }
        peaks[i] = mx;
    }
    return peaks;
}

_registerListCache(listCachePut, listCacheGet);
