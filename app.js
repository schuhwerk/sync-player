// Sync player frontend. Reads window.CFG injected by index.php.
// See AGENTS.md for region map.

// ## js-config — CFG, api/loadBytes dispatch, navigate, SW registration
const CFG = window.CFG;
CFG.canWrite = !!CFG.canWrite;

function readStoredAuth(key) {
    try {
        const val = localStorage.getItem(key);
        if (val !== null) return val;
    } catch (e) {}
    try {
        const legacy = sessionStorage.getItem(key);
        if (legacy !== null) {
            try { localStorage.setItem(key, legacy); } catch (e) {}
            return legacy;
        }
    } catch (e) {}
    return '';
}

function writeStoredAuth(key, val) {
    try {
        localStorage.setItem(key, val);
        return;
    } catch (e) {}
    try { sessionStorage.setItem(key, val); } catch (e) {}
}

CFG.pw = readStoredAuth('spw_' + CFG.adapterId);
CFG.appPw = readStoredAuth('apw_' + CFG.adapterId);

// Touch-only devices get cheaper defaults: no waveforms, no stage, sequential decode.
// hover:none + pointer:coarse identifies phones/tablets regardless of viewport size,
// so a narrow desktop window keeps the full experience.
const IS_MOBILE = (() => {
    try { return matchMedia('(hover: none) and (pointer: coarse)').matches; }
    catch (_) { return false; }
})();
const MOBILE_PREDECODE_LIMIT = (() => {
    if (!IS_MOBILE) return 0;
    const mem = Number(navigator.deviceMemory || 0);
    if (mem >= 8) return 24 * 1024 * 1024;
    if (mem >= 4) return 12 * 1024 * 1024;
    if (mem > 0) return 0;
    return 8 * 1024 * 1024;
})();
const VOLUME_SLIDER_MIN = 0;
const VOLUME_SLIDER_MAX = 100;
const DEFAULT_VOLUME = 0.5;
const VOLUME_RAMP_SECONDS = 0.012;
const gainToSliderValue = v => Math.max(VOLUME_SLIDER_MIN, Math.min(VOLUME_SLIDER_MAX, Math.round(v * VOLUME_SLIDER_MAX)));
const sliderToGainValue = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_VOLUME;
    return Math.max(VOLUME_SLIDER_MIN, Math.min(VOLUME_SLIDER_MAX, n)) / VOLUME_SLIDER_MAX;
};

const _cloudUrlTemplate = CFG.cloudUrl || null;
let _networkState = navigator.onLine ? 'online' : 'offline';
const INSPECT_KEY = 'syncplayer.inspect';
const INSPECT_MAX = 160;
let _inspectEnabled = false;
const _inspectEvents = [];
let _inspectSeq = 0;

function searchParams() {
    return new URLSearchParams(location.search);
}

function pathFromLocation() {
    return searchParams().get('path') || '/';
}

function hasInspectQuery() {
    return searchParams().has('inspect');
}

CFG.path = pathFromLocation() || CFG.path || '/';

const $ = id => document.getElementById(id);
const fmt = s => { s = Math.max(0, s|0); return `${(s/60)|0}:${String(s%60).padStart(2,'0')}`; };
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function syncNetworkIndicator() {
    const el = $('net-ind');
    if (!el) return;
    const offline = _networkState !== 'online';
    el.hidden = !offline;
    el.title = offline ? 'Showing cached data while offline' : '';
}

function setNetworkState(state) {
    _networkState = state === 'online' ? 'online' : 'offline';
    syncNetworkIndicator();
    inspect('network', { state: _networkState });
}

function inspect(type, detail) {
    if (!_inspectEnabled) return;
    const payload = typeof detail === 'function' ? detail() : (detail || {});
    const evt = { at: new Date().toISOString(), type, path: CFG.path, ...payload };
    _inspectEvents.push(evt);
    if (_inspectEvents.length > INSPECT_MAX) {
        _inspectEvents.splice(0, _inspectEvents.length - INSPECT_MAX);
    }
    renderInspectRow(evt);
    try {
        console.debug('[syncplayer]', type, evt);
    } catch (_) {}
}

function nextInspectId(prefix) {
    _inspectSeq += 1;
    return `${prefix}-${_inspectSeq}`;
}

function inspectResultSummary(data) {
    return {
        stale: !!data?._stale,
        appAuth: !!data?._appAuth,
        shareAuth: !!data?._auth,
        folders: Array.isArray(data?.folders) ? data.folders.length : 0,
        files: Array.isArray(data?.files) ? data.files.length : 0,
        attachments: Array.isArray(data?.attachments) ? data.attachments.length : 0,
        error: data?.error || '',
    };
}

// Floating bottom-right panel mirroring _inspectEvents — the only practical way
// to see what's happening on a phone where DevTools is impractical. Only the
// last ~30 rows are kept in the DOM; the full ring buffer stays in memory.
const INSPECT_DOM_MAX = 30;
function renderInspectRow(evt) {
    const panel = $('inspect-log');
    if (!panel || panel.hidden) return;
    const t = (evt.at || '').slice(11, 19); // HH:MM:SS
    const { at, type, path, ...rest } = evt;
    const v = Object.keys(rest).length ? JSON.stringify(rest) : '';
    const row = document.createElement('div');
    row.className = 'inspect-row';
    row.innerHTML = `<span class="inspect-t"></span><span class="inspect-k"></span><span class="inspect-v"></span>`;
    row.children[0].textContent = t;
    row.children[1].textContent = type;
    row.children[2].textContent = v;
    panel.prepend(row);
    while (panel.children.length > INSPECT_DOM_MAX) panel.lastChild.remove();
}

function syncInspectUI() {
    const btn = $('menu-inspect');
    const info = $('menu-inspect-info');
    const panel = $('inspect-log');
    const visible = hasInspectQuery();
    if (btn) btn.hidden = !visible;
    if (info) info.hidden = !visible;
    if (panel) {
        panel.hidden = !(visible && _inspectEnabled);
        if (panel.hidden) panel.innerHTML = '';
        else _inspectEvents.slice(-INSPECT_DOM_MAX).forEach(renderInspectRow);
    }
    if (!btn || !visible) return;
    btn.classList.toggle('on', _inspectEnabled);
    btn.setAttribute('aria-checked', String(_inspectEnabled));
}

function setInspectEnabled(on) {
    _inspectEnabled = !!on;
    try { localStorage.setItem(INSPECT_KEY, _inspectEnabled ? '1' : '0'); } catch(e) {}
    syncInspectUI();
    inspect('inspect', { enabled: _inspectEnabled });
}

function initInspect() {
    let enabled = false;
    if (hasInspectQuery()) {
        try { enabled = localStorage.getItem(INSPECT_KEY) === '1'; } catch(e) {}
        if (!enabled) enabled = searchParams().get('inspect') === '1';
    }
    _inspectEnabled = enabled;
    syncInspectUI();
}

window.SyncInspect = {
    enable() { setInspectEnabled(true); },
    disable() { setInspectEnabled(false); },
    clear() { _inspectEvents.length = 0; },
    dump() { return _inspectEvents.slice(); },
    get enabled() { return _inspectEnabled; },
};

// Backend dispatch: SyncBackend (browser-fs in single-file build) wins if present;
// otherwise hit the PHP endpoints. Both must implement `api(mode, path, extra)` and
// `loadBytes(path)`. Keeping the HTTP version inline keeps index.php a zero-dep deploy.

// Builds the URLSearchParams for a PHP endpoint hit. Always carries `mode` + `path`;
// adds the two passwords if set. Used by api/apiPost/loadBytes/fileHref.
function qs(mode, path, extra) {
    const p = new URLSearchParams({ mode, path });
    if (extra) for (const k in extra) p.set(k, extra[k]);
    if (CFG.pw)    p.set('password', CFG.pw);
    if (CFG.appPw) p.set('app_password', CFG.appPw);
    return p;
}

// Two distinct 401 shapes — app-level gate vs share-level. Hint comes from config
// so the prompt can tell the user what to type.
async function parseAuth(r) {
    const body = await r.json().catch(() => ({}));
    const key = body.error === 'app_password_required' ? '_appAuth' : '_auth';
    return { [key]: true, hint: body.hint || '', throttled: !!body.throttled };
}

function apiCacheKey(mode, path) {
    if (mode === 'list' || mode === 'load-meta') return `${mode}::${path}`;
    return null;
}

const backendApi = window.SyncBackend?.api || null;
const api = async (mode, path, extra) => {
    const reqId = nextInspectId(`api-${mode}`);
    inspect('api:start', () => ({
        reqId,
        mode,
        path,
        via: backendApi ? 'adapter' : 'http',
        extra: extra && Object.keys(extra).length ? extra : null,
    }));
    if (backendApi) {
        try {
            const data = await backendApi(mode, path, extra);
            inspect('api:done', () => ({ reqId, mode, path, via: 'adapter', ...inspectResultSummary(data) }));
            return data;
        } catch (e) {
            inspect('api:error', { reqId, mode, path, via: 'adapter', message: e?.message || String(e) });
            throw e;
        }
    }
    // Cache list/search/meta in IDB so reloading offline still shows the last
    // known content. We have two distinct failure modes to handle:
    //   - true network failure: fetch() rejects (handled in catch).
    //   - upstream failure: PHP returns 5xx + {error:"Error: N"} (the curl
    //     to Nextcloud failed). The SW already falls back to its own cache on
    //     5xx, but for cases the SW doesn't see (file://, first install, or
    //     fresh cache), we also fall back here when data.error is set.
    const cacheKey = apiCacheKey(mode, path, extra);
    try {
        const r = await fetch('?' + qs(mode, path, extra));
        if (r.status === 401) {
            const auth = await parseAuth(r);
            inspect('api:auth', { reqId, mode, path, via: 'http', throttled: !!auth.throttled, app: !!auth._appAuth });
            return auth;
        }
        const data = await r.json();
        if (cacheKey && !data.error && !data._auth && !data._appAuth) listCachePut(cacheKey, data);
        if (data.error && cacheKey) {
            const cached = await listCacheGet(cacheKey);
            if (cached) {
                inspect('api:done', () => ({
                    reqId,
                    mode,
                    path,
                    via: 'http',
                    status: r.status,
                    cacheFallback: true,
                    ...inspectResultSummary({ ...cached, _stale: true }),
                }));
                return { ...cached, _stale: true };
            }
        }
        inspect('api:done', () => ({ reqId, mode, path, via: 'http', status: r.status, ...inspectResultSummary(data) }));
        return data;
    } catch (e) {
        if (cacheKey) {
            const cached = await listCacheGet(cacheKey);
            if (cached) {
                inspect('api:done', () => ({
                    reqId,
                    mode,
                    path,
                    via: 'http',
                    cacheFallback: true,
                    ...inspectResultSummary({ ...cached, _stale: true }),
                }));
                return { ...cached, _stale: true };
            }
        }
        inspect('api:error', { reqId, mode, path, via: 'http', message: e?.message || String(e) });
        throw e;
    }
};

async function fetchFreshList(path) {
    const reqId = nextInspectId('tree-list');
    inspect('tree:list:start', { reqId, path });
    const r = await fetch('?' + qs('list', path));
    if (r.status === 401) {
        const auth = await parseAuth(r);
        inspect('tree:list:auth', { reqId, path, throttled: !!auth.throttled, app: !!auth._appAuth });
        return auth;
    }
    const data = await r.json();
    if (!data.error && !data._auth && !data._appAuth) listCachePut(`list::${path}`, data);
    inspect('tree:list:done', () => ({ reqId, path, status: r.status, ...inspectResultSummary(data) }));
    return data;
}

const backendApiPost = window.SyncBackend?.apiPost || null;
const apiPost = async (mode, path, body) => {
    const reqId = nextInspectId(`post-${mode}`);
    inspect('api-post:start', { reqId, mode, path, via: backendApiPost ? 'adapter' : 'http' });
    if (backendApiPost) {
        try {
            const data = await backendApiPost(mode, path, body);
            inspect('api-post:done', () => ({ reqId, mode, path, via: 'adapter', ...inspectResultSummary(data) }));
            return data;
        } catch (e) {
            inspect('api-post:error', { reqId, mode, path, via: 'adapter', message: e?.message || String(e) });
            throw e;
        }
    }
    const r = await fetch('?' + qs(mode, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (r.status === 401) {
        const auth = await parseAuth(r);
        inspect('api-post:auth', { reqId, mode, path, via: 'http', throttled: !!auth.throttled, app: !!auth._appAuth });
        return auth;
    }
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    inspect('api-post:done', () => ({ reqId, mode, path, via: 'http', status: r.status, ...inspectResultSummary(data) }));
    return data;
};

const backendLoadBytes = window.SyncBackend?.loadBytes || null;
const loadBytes = async path => {
    const reqId = nextInspectId('bytes');
    inspect('bytes:start', { reqId, path, via: backendLoadBytes ? 'adapter' : 'http' });
    if (backendLoadBytes) {
        try {
            const bytes = await backendLoadBytes(path);
            inspect('bytes:done', { reqId, path, via: 'adapter', bytes: bytes?.byteLength || 0 });
            return bytes;
        } catch (e) {
            inspect('bytes:error', { reqId, path, via: 'adapter', message: e?.message || String(e) });
            throw e;
        }
    }
    try {
        const r = await fetch('?' + qs('fetch', path));
        if (!r.ok) {
            setNetworkState(r.status >= 500 ? 'offline' : _networkState);
            throw new Error(`HTTP ${r.status}`);
        }
        const bytes = await r.arrayBuffer();
        setNetworkState('online');
        inspect('bytes:done', { reqId, path, via: 'http', status: r.status, bytes: bytes.byteLength });
        return bytes;
    } catch (e) {
        setNetworkState('offline');
        inspect('bytes:error', { reqId, path, via: 'http', message: e?.message || String(e) });
        inspect('audio:fetch-error', { path, message: e?.message || String(e) });
        throw e;
    }
};

function fileHref(path, download = false) {
    if (window.SyncBackend) return '#';
    return '?' + qs('fetch', path, download ? { download: '1' } : null);
}

const dirHref = path => '?' + new URLSearchParams({ path });

function currentCloudUrl() {
    if (!_cloudUrlTemplate) return null;
    try {
        const url = new URL(_cloudUrlTemplate, location.href);
        url.searchParams.set('dir', CFG.path || '/');
        return url.toString();
    } catch (_) {
        return _cloudUrlTemplate;
    }
}

let _pendingNavPath = '';

function pendingNavLabel(path) {
    const segs = String(path || '/').split('/').filter(Boolean);
    return segs.length ? `Opening ${segs[segs.length - 1]}…` : 'Opening folder…';
}

function syncPendingFolderLink() {
    document.querySelectorAll('#folders a.is-pending').forEach(a => a.classList.remove('is-pending'));
    if (!_pendingNavPath) return;
    document.querySelectorAll('#folders a[data-path]').forEach(a => {
        a.classList.toggle('is-pending', a.dataset.path === _pendingNavPath);
    });
}

function setPendingNavigation(path) {
    _pendingNavPath = path || '/';
    const root = $('root');
    if (root) {
        root.classList.add('nav-loading');
        root.dataset.navLabel = pendingNavLabel(_pendingNavPath);
        root.setAttribute('aria-busy', 'true');
    }
    syncPendingFolderLink();
    inspect('navigate:pending', { to: _pendingNavPath });
}

function clearPendingNavigation(path = null) {
    if (path && _pendingNavPath && path !== _pendingNavPath) return;
    _pendingNavPath = '';
    const root = $('root');
    if (root) {
        root.classList.remove('nav-loading');
        delete root.dataset.navLabel;
        root.removeAttribute('aria-busy');
    }
    syncPendingFolderLink();
}

// Keep folder navigation in-app for both builds so cached data stays usable offline
// and we don't depend on reloading the shell + app.js for each folder click.
function navigate(newPath) {
    newPath = newPath || '/';
    if (newPath === CFG.path) return;
    inspect('navigate', { from: CFG.path, to: newPath });
    const params = searchParams();
    params.set('path', newPath);
    history.pushState(null, '', '?' + params.toString());
    CFG.path = newPath;
    setHeader();
    setPendingNavigation(newPath);
    init();
}

if ('serviceWorker' in navigator && location.protocol !== 'file:' && window.isSecureContext) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register(new URL('sw.js', location.href)).catch(() => {});
    }, { once: true });
}
window.addEventListener('online', () => setNetworkState('online'));
window.addEventListener('offline', () => setNetworkState('offline'));
// ## js-cache — IndexedDB stores (waveforms, listings, pinned, audio), session bytes, computePeaks
// IndexedDB stores precomputed waveform peaks per file (Float32Array of length WF_PEAKS).
// Key: `${path}::${lastModified}` — changing lm invalidates old peaks.
// Non-pinned encoded bytes also get a tab-scoped LRU in RAM so revisiting a folder
// in the same session doesn't re-fetch everything. Long-lived offline copies still
// live in IndexedDB behind the explicit "Available offline" toggle.
// 500 covers a ~500px-wide waveform at 1px/peak — anything denser is wasted on
// every layout we ship. Halves the cached Float32Array per file.
const WF_PEAKS = 500;
const DB_NAME = 'syncplayer';
const STORE = 'waveforms', LIST_STORE = 'listings', PINNED_STORE = 'pinned', AUDIO_STORE = 'audio';
const TREE_STORAGE_KEY = `syncplayer.tree::${CFG.adapterId || 'default'}`;
const TREE_CRAWL_MAX_DEPTH = 1;
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
const openDB = () => {
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

const storeGet = async (store, key) => {
    try {
        const db = await openDB();
        return new Promise(res => {
            const r = db.transaction(store).objectStore(store).get(key);
            r.onsuccess = () => res(r.result || null);
            r.onerror = () => res(null);
        });
    } catch (_) { return null; }
};

const storePut = async (store, key, val) => {
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

const storeDel = async (store, key) => {
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

const cacheGet      = key      => storeGet(STORE, key);
const cachePut      = (key, v) => storePut(STORE, key, v);
const listCacheGet  = key      => storeGet(LIST_STORE, key);
const listCachePut  = (key, v) => storePut(LIST_STORE, key, v);
const getPin        = path     => storeGet(PINNED_STORE, path);
const setPin        = (p, v)   => storePut(PINNED_STORE, p, v);
const delPin        = path     => storeDel(PINNED_STORE, path);
const audioCacheGet = key      => storeGet(AUDIO_STORE, key);
const audioCachePut = (key, v) => storePut(AUDIO_STORE, key, v);
const audioCacheDel = key      => storeDel(AUDIO_STORE, key);
const audioKey      = f        => `${f.path}::${f.lm || ''}`;

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

async function loadCachedBytes(file, options = {}) {
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

const storeGetAllKeys = async (store) => {
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
let _pinnedPaths = new Set();
async function loadPinnedPaths() {
    _pinnedPaths = new Set(await storeGetAllKeys(PINNED_STORE));
}

function folderOfflineState(path) {
    if (_pinnedPaths.has(path)) return 'offline';
    for (const pinnedPath of _pinnedPaths) {
        if (pinnedPath === '/' || pinnedPath.startsWith(path + '/')) return 'contains';
        if (path.startsWith(pinnedPath + '/')) return 'offline';
    }
    return '';
}

// Per segment, max(|sample|) → one Float32. WF_PEAKS segments total.
function computePeaks(audioBuffer, n = WF_PEAKS) {
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
// ## js-tree — preload full folder tree from server; flat map used by filter + pin
let _tree = null; // path → {folders, files, attachments}
let _treeRefreshPromise = null;
let _treeRefreshTimer = 0;

function normalizeTreeEntry(data) {
    return {
        folders: Array.isArray(data?.folders) ? data.folders : [],
        files: Array.isArray(data?.files) ? data.files : [],
        attachments: Array.isArray(data?.attachments) ? data.attachments : [],
    };
}

function treeEntrySize(entry) {
    if (!entry) return 0;
    return (entry.folders?.length || 0) + (entry.files?.length || 0) + (entry.attachments?.length || 0);
}

function treeEntry(path) {
    return _tree?.[path] ? normalizeTreeEntry(_tree[path]) : null;
}

function saveTreeToLocalStorage(tree) {
    try { localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(tree)); } catch (_) {}
}

function loadTreeFromLocalStorageSync() {
    try {
        const raw = localStorage.getItem(TREE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : null;
    } catch (_) {
        return null;
    }
}

async function persistTree(tree) {
    saveTreeToLocalStorage(tree);
    await listCachePut('tree::/', tree);
}

function mergeTreeEntries(entries, options = {}) {
    if (!entries || typeof entries !== 'object') return _tree;
    const stalePaths = options.stalePaths || null;
    const next = { ...(_tree || {}) };
    for (const [path, incomingRaw] of Object.entries(entries)) {
        const incoming = normalizeTreeEntry(incomingRaw);
        const existing = next[path] ? normalizeTreeEntry(next[path]) : null;
        if (stalePaths?.has(path) && existing && treeEntrySize(existing) > treeEntrySize(incoming)) {
            continue;
        }
        next[path] = incoming;
    }
    _tree = next;
    return _tree;
}

async function loadStoredTree() {
    const fromLocalStorage = loadTreeFromLocalStorageSync();
    if (fromLocalStorage) return fromLocalStorage;
    const cached = await listCacheGet('tree::/');
    if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
    return null;
}

async function updateTreeEntry(path, data) {
    const next = mergeTreeEntries({ [path]: normalizeTreeEntry(data) });
    await persistTree(_tree);
    return next[path];
}

async function fetchTree(rootPath = CFG.path || '/', maxDepth = TREE_CRAWL_MAX_DEPTH) {
    if (_treeRefreshPromise) return _treeRefreshPromise;
    _treeRefreshPromise = (async () => {
        const tree = {};
        const stalePaths = new Set();
        const visited = new Set();
        const queue = [{ path: rootPath || '/', depth: 0 }];
        let isComplete = true;
        inspect('tree:refresh-start', { rootPath: rootPath || '/', maxDepth });
        while (queue.length) {
            const next = queue.shift();
            const path = next?.path;
            const depth = next?.depth || 0;
            if (!path || visited.has(path)) continue;
            visited.add(path);
            let data;
            try { data = await fetchFreshList(path); } catch (_) { isComplete = false; continue; }
            if (!data || data.error || data._auth || data._appAuth) { isComplete = false; continue; }
            const entry = normalizeTreeEntry(data);
            tree[path] = entry;
            if (depth < maxDepth) {
                for (const folder of entry.folders) {
                    if (!visited.has(folder.path)) queue.push({ path: folder.path, depth: depth + 1 });
                }
            }
        }
        if (Object.keys(tree).length) {
            mergeTreeEntries(tree, { stalePaths });
            await persistTree(_tree);
            syncFolderFilterUI();
        }
        inspect('tree:refresh-done', {
            rootPath: rootPath || '/',
            maxDepth,
            fetchedPaths: Object.keys(tree).length,
            complete: isComplete,
        });
        return _tree;
    })();
    try {
        return await _treeRefreshPromise;
    } finally {
        _treeRefreshPromise = null;
    }
}

function refreshTreeInBackground(rootPath = CFG.path || '/', maxDepth = TREE_CRAWL_MAX_DEPTH) {
    fetchTree(rootPath, maxDepth).catch(() => {});
}

function scheduleTreeRefresh(rootPath = CFG.path || '/', delay = 180, maxDepth = TREE_CRAWL_MAX_DEPTH) {
    if (IS_MOBILE || window.SyncBackend || _treeRefreshPromise || _treeRefreshTimer) return;
    _treeRefreshTimer = setTimeout(() => {
        _treeRefreshTimer = 0;
        refreshTreeInBackground(rootPath, maxDepth);
    }, delay);
}

async function loadTree() {
    if (_tree) return;
    const cached = await loadStoredTree();
    if (cached) {
        mergeTreeEntries(cached);
        return;
    }
}

// ## js-player — SyncPlayer: one AudioContext, sample-accurate sync, soft limiter
// Web Audio sync player — patterned after chor-player/web-api-player.ts but trimmed.
// One AudioContext, one gain node per track, sources recreated on play/seek (BufferSourceNodes are one-shot).
async function forEachConcurrent(items, limit, fn) {
    if (!items.length) return;
    const width = Math.max(1, Math.min(limit || items.length, items.length));
    let next = 0;
    const workers = Array.from({ length: width }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

class SyncPlayer {
    constructor(files, onChange) {
        this.files = files;
        this.onChange = onChange;
        this.ctx = null;
        this.buffers = [];
        this.peaks = [];
        this.gains = [];
        this.sources = [];
        this.volumes = files.map(() => DEFAULT_VOLUME);
        this.maxVolume = 1;
        this.duration = 0;
        this.isPlay = false;
        this.currentTime = 0;
        this._playbackBase = 0;
        // On mobile we postpone decodeAudioData until the user actually presses
        // play, but the play button still needs to enable after the bytes are
        // available. fetchedFraction tracks fetch completion; loadedFraction
        // tracks decode completion. Desktop keeps both moving in lockstep.
        this.fetchedFraction = 0;
        this.loadedFraction = 0;
        this.loadError = '';
        this.repeat = true;
        this._rafId = 0;
        // Encoded bytes, kept around on mobile until the first play() resolves
        // them into AudioBuffers. Nulled after decode to release memory.
        this._encoded = [];
        this._deferDecode = IS_MOBILE;
        this._decodePromise = null;
        this._starting = false;
        this._emitRafId = 0;
        this._ctxHoldCount = 0;
        this._ctxSuspendTimer = 0;
        this._playbackEndTimer = 0;
        this._closeCtxWhenIdle = false;
        this._destroyed = false;
        this._gestureUnlocked = false; // AudioContext unlocked via a user gesture
        this._earlyDecodeWanted = false; // gesture fired before fetch completed
        this._sourceRunId = 0;
        this.limiter = null;
    }

    _startTickLoop() {
        if (this._rafId) return;
        const loop = () => {
            if (!this.isPlay) { this._rafId = 0; return; }
            this._tick();
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }
    _stopTickLoop() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    }
    _clearCtxSuspendTimer() {
        if (!this._ctxSuspendTimer) return;
        clearTimeout(this._ctxSuspendTimer);
        this._ctxSuspendTimer = 0;
    }
    _clearPlaybackEndTimer() {
        if (!this._playbackEndTimer) return;
        clearTimeout(this._playbackEndTimer);
        this._playbackEndTimer = 0;
    }
    _closeCtxNow() {
        const ctx = this.ctx;
        this.ctx = null;
        this.gains = [];
        this.limiter = null;
        this._closeCtxWhenIdle = false;
        if (!ctx) return;
        try { ctx.close(); } catch(e) {}
    }
    _resumeCtx() {
        const ctx = this._ctx();
        this._closeCtxWhenIdle = false;
        this._clearCtxSuspendTimer();
        try { ctx.resume(); } catch(e) {}
        return ctx;
    }
    _scheduleCtxSuspend() {
        if (!this.ctx) { this._closeCtxWhenIdle = false; return; }
        this._clearCtxSuspendTimer();
        if (this.isPlay || this._ctxHoldCount > 0) return;
        // Let the current event turn finish first so transient UI sounds can chain
        // without fighting an immediate suspend/resume.
        this._ctxSuspendTimer = setTimeout(() => {
            this._ctxSuspendTimer = 0;
            const ctx = this.ctx;
            if (!ctx || this.isPlay || this._ctxHoldCount > 0) return;
            if (this._closeCtxWhenIdle) {
                this._closeCtxNow();
                return;
            }
            if (ctx.state === 'closed') return;
            try { ctx.suspend(); } catch(e) {}
        }, 0);
    }
    _schedulePlaybackEnd(runId) {
        this._clearPlaybackEndTimer();
        const schedule = delayMs => {
            this._playbackEndTimer = setTimeout(() => {
                this._playbackEndTimer = 0;
                if (!this.isPlay || runId !== this._sourceRunId) return;
                this._syncCurrentTime();
                const remainingMs = Math.max(0, (this.duration - this.currentTime) * 1000);
                if (remainingMs > 120) {
                    const ctx = this.ctx;
                    schedule((!ctx || ctx.state === 'running') ? remainingMs + 80 : Math.min(remainingMs + 80, 1000));
                    return;
                }
                this._handlePlaybackEnded(runId);
            }, Math.max(0, Math.ceil(delayMs)));
        };
        const remainingMs = Math.max(0, (this.duration - this.currentTime) * 1000);
        schedule(remainingMs + 80);
    }
    holdContext() {
        this._ctxHoldCount++;
        const ctx = this._resumeCtx();
        let released = false;
        return {
            ctx,
            release: () => {
                if (released) return;
                released = true;
                this._ctxHoldCount = Math.max(0, this._ctxHoldCount - 1);
                this._scheduleCtxSuspend();
            },
        };
    }

    _ctx() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            const ctx = this.ctx;
            // Soft limiter: stops multi-track sums from clipping at the output.
            const lim = ctx.createDynamicsCompressor();
            lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
            lim.attack.value = 0.003; lim.release.value = 0.1;
            lim.connect(ctx.destination);
            this.limiter = lim;
            // Browser can auto-suspend the context (tab backgrounding, BT device change,
            // inactivity). When it resumes and we're supposed to be playing AND lost our
            // sources, restart them — otherwise the UI shows "playing" but is silent.
            // The `sources.length === 0` guard avoids racing with our own explicit
            // resume() inside play(), which would otherwise double-start the sources.
            ctx.addEventListener('statechange', () => {
                if (this.ctx !== ctx) return;
                if (ctx.state === 'running' && this.isPlay && this.sources.length === 0) {
                    this._restartSources();
                }
            });
        }
        return this.ctx;
    }
    _syncCurrentTime() {
        if (!this.isPlay || !this.ctx || this.ctx.state === 'closed') return this.currentTime;
        this.currentTime = Math.max(0, Math.min(this.duration, this.ctx.currentTime - this._playbackBase));
        return this.currentTime;
    }
    _invalidateSourceRun() {
        this._sourceRunId++;
        this._clearPlaybackEndTimer();
    }
    _handlePlaybackEnded(runId) {
        if (!this.isPlay || runId !== this._sourceRunId) return;
        this._clearPlaybackEndTimer();
        this.currentTime = this.duration;
        this.sources = [];
        if (this.repeat) {
            this.currentTime = 0;
            this._restartSources();
        } else {
            this.isPlay = false;
            this._stopTickLoop();
            this._scheduleCtxSuspend();
        }
        this._emit();
    }
    _emit() {
        if (this._destroyed || this._emitRafId) return;
        this._emitRafId = requestAnimationFrame(() => {
            this._emitRafId = 0;
            if (this._destroyed) return;
            this.onChange?.(this);
        });
    }
    _normalizeVolume(v) {
        return Number.isFinite(v) ? Math.max(0, Math.min(this.maxVolume, v)) : 0;
    }
    trackOutputVolume(i) {
        return this._normalizeVolume(this.volumes[i]);
    }
    _trackGainTarget(i) {
        return this.trackOutputVolume(i);
    }
    _applyTrackGain(i, immediate = false) {
        const g = this.gains[i];
        if (!g) return;
        const target = this._trackGainTarget(i);
        if (immediate || !this.ctx) {
            g.gain.value = target;
            return;
        }
        const now = this.ctx.currentTime;
        if (typeof g.gain.cancelAndHoldAtTime === 'function') g.gain.cancelAndHoldAtTime(now);
        else {
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(g.gain.value, now);
        }
        g.gain.linearRampToValueAtTime(target, now + VOLUME_RAMP_SECONDS);
    }

    async load() {
        const loadId = nextInspectId('player-load');
        const total = this.files.length;
        let fetched = 0;
        this.loadError = '';
        inspect('player:load-start', { loadId, tracks: total, deferDecode: this._deferDecode });
        // Mobile keeps only two encoded tracks in flight at once; desktop keeps
        // the original parallel fetch behaviour and still decodes sequentially.
        const loadOne = async (f, i) => {
            try {
                const key = `${f.path}::${f.lm}`;
                const wfHidden = document.body.classList.contains('hide-wf');
                inspect('player:track-start', { loadId, index: i, path: f.path, lm: f.lm || '', waveformCached: !wfHidden });
                const cached = wfHidden ? null : await cacheGet(key);
                if (this._destroyed) return;
                if (cached?.peaks) { this.peaks[i] = cached.peaks; this._emit(); }
                const { bytes, source } = await loadCachedBytes(f);
                inspect('player:track-source', { loadId, index: i, path: f.path, source });
                if (this._destroyed) return;
                fetched++;
                this.fetchedFraction = total ? fetched / total : 1;
                this._encoded[i] = bytes;
                inspect('player:track-ready', {
                    loadId,
                    index: i,
                    path: f.path,
                    source,
                    bytes: bytes?.byteLength || 0,
                    fetchedFraction: this.fetchedFraction,
                });
            } catch (e) {
                if (this._destroyed) return;
                this.buffers[i] = null;
                this._encoded[i] = null;
                const m = e?.message || '';
                this.loadError = this.loadError || (/^HTTP /.test(m)
                    ? `Audio unavailable (${m}).`
                    : 'Audio unavailable — source is offline or unreachable.');
                inspect('audio:track-unavailable', { path: f.path, message: m || String(e) });
            }
            // Mobile gates play on bytes available; desktop on decoded buffers.
            // On desktop we'll run _decodeAll immediately after Promise.all.
            if (this._destroyed) return;
            if (this._deferDecode) this.loadedFraction = this.fetchedFraction;
            this._emit();
        };
        if (this._deferDecode) await forEachConcurrent(this.files, 2, loadOne);
        else await Promise.all(this.files.map(loadOne));
        if (this._destroyed) return;
        this.fetchedFraction = 1;
        if (!this._deferDecode) {
            await this._decodeAll();
            if (this._destroyed) return;
            this.loadedFraction = 1;
        }
        this._emit();
        this._maybePredecode();
        if (this._earlyDecodeWanted) {
            this._earlyDecodeWanted = false;
            this._tryEarlyDecode();
        }
        inspect('player:load-done', {
            loadId,
            tracks: total,
            fetched: this.files.filter((_, i) => !!this._encoded[i] || !!this.buffers[i]).length,
            decoded: this.buffers.filter(Boolean).length,
            duration: this.duration,
            loadError: this.loadError || '',
        });
    }

    _maybePredecode() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || !MOBILE_PREDECODE_LIMIT) return;
        const totalBytes = this._encoded.reduce((sum, bytes) => sum + (bytes?.byteLength || 0), 0);
        if (!totalBytes || totalBytes > MOBILE_PREDECODE_LIMIT) return;
        inspect('audio:mobile-predecode', { totalBytes, limit: MOBILE_PREDECODE_LIMIT, tracks: this.files.length });
        this._decodeAll();
    }

    // Run decodeAudioData for every fetched track. Sequential to keep peak
    // memory low — at any moment only one ArrayBuffer + its decoded buffer
    // are live. Encoded bytes are nulled out as we go so they can be GC'd.
    async _decodeAll() {
        if (this._destroyed) return;
        if (this._decodePromise) return this._decodePromise;
        this._decodePromise = (async () => {
            const wfHidden = document.body.classList.contains('hide-wf');
            const total = this.files.length;
            let decoded = this.buffers.filter(Boolean).length;
            for (let i = 0; i < total; i++) {
                if (this._destroyed) return;
                const bytes = this._encoded[i];
                if (!bytes || this.buffers[i]) continue;
                try {
                    const buf = await this._ctx().decodeAudioData(bytes);
                    if (this._destroyed) return;
                    this.buffers[i] = buf;
                    this._encoded[i] = null; // release for GC
                    if (!wfHidden) {
                        const f = this.files[i];
                        const key = `${f.path}::${f.lm}`;
                        const cached = await cacheGet(key);
                        if (this._destroyed) return;
                        if (!cached?.peaks) {
                            this.peaks[i] = computePeaks(this.buffers[i]);
                            cachePut(key, { peaks: this.peaks[i] });
                        } else if (!this.peaks[i]) {
                            this.peaks[i] = cached.peaks;
                        }
                    }
                } catch (e) {
                    if (this._destroyed) return;
                    this.buffers[i] = null;
                    this._encoded[i] = null;
                    this.loadError = this.loadError || 'Audio could not be decoded — file may be corrupt.';
                    inspect('audio:decode-error', { path: this.files[i].path, message: e?.message || String(e) });
                }
                decoded++;
                if (!this._deferDecode) this.loadedFraction = total ? decoded / total : 1;
                this._emit();
            }
            const readyBuffers = this.buffers.filter(Boolean);
            this.duration = readyBuffers.length ? Math.max(...readyBuffers.map(b => b.duration)) : 0;
            if (this._deferDecode) {
                this._deferDecode = false;
                this.loadedFraction = 1;
            }
            this._emit();
        })();
        try {
            return await this._decodePromise;
        } finally {
            this._decodePromise = null;
        }
    }

    primePlayback() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || this.isPlay) return;
        const hold = this.holdContext();
        this._decodeAll().finally(() => {
            if (!this.isPlay) hold.release();
        });
    }

    // Call from any user-gesture handler (pointerdown anywhere on the page).
    // Unlocks the AudioContext on iOS and starts decoding as soon as bytes are
    // ready — so play is instant even for large sets that skip _maybePredecode.
    primeOnGesture() {
        if (this._destroyed || !this._deferDecode || this.isPlay) return;
        if (!this._gestureUnlocked) {
            // Resume within the gesture so iOS marks the context as allowed.
            // Release right after — we don't want to keep a BT connection alive.
            const hold = this.holdContext();
            this._gestureUnlocked = true;
            Promise.resolve().then(() => { if (!this.isPlay) hold.release(); });
        }
        this._tryEarlyDecode();
    }

    _tryEarlyDecode() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || this.isPlay) return;
        if (this.fetchedFraction < 1) { this._earlyDecodeWanted = true; return; }
        this._decodeAll();
    }

    // Compute peaks for buffers we skipped (e.g. waveforms started hidden, user
    // toggled them on). Called from applyShowWaveforms. Cheap relative to decode.
    computeMissingPeaks() {
        for (let i = 0; i < this.buffers.length; i++) {
            const buf = this.buffers[i];
            if (!buf || this.peaks[i]) continue;
            this.peaks[i] = computePeaks(buf);
            const f = this.files[i];
            cachePut(`${f.path}::${f.lm}`, { peaks: this.peaks[i] });
        }
        this._emit();
    }

    _tick() {
        if (!this.isPlay) return;
        this._syncCurrentTime();
        if (this.currentTime >= this.duration) {
            this._handlePlaybackEnded(this._sourceRunId);
            return;
        }
        this._emit();
    }

    _restartSources() {
        const ctx = this._ctx();
        const startAt = Math.max(0, Math.min(this.duration, this.currentTime));
        const runId = this._sourceRunId + 1;
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        const nextSources = this.buffers.map((buf, i) => {
            if (!buf || startAt >= buf.duration) return null;
            let g = this.gains[i];
            if (!g) {
                g = this.gains[i] = ctx.createGain();
                g.connect(this.limiter); // connect once — repeated connects stack and inflate gain
            }
            this._applyTrackGain(i, true);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(g);
            src.start(0, startAt);
            return src;
        }).filter(Boolean);
        let pending = nextSources.length;
        nextSources.forEach(src => {
            src.onended = () => {
                if (runId !== this._sourceRunId) return;
                pending = Math.max(0, pending - 1);
                if (pending === 0) this._handlePlaybackEnded(runId);
            };
        });
        this.sources = nextSources;
        this._playbackBase = ctx.currentTime - startAt;
        this._schedulePlaybackEnd(runId);
    }

    async play() {
        // Re-entrancy guard: on mobile play() awaits decode, so a second toggle
        // press before the first resolved would otherwise double-fire _restartSources.
        if (this.isPlay || this._starting) return;
        this._starting = true;
        this._emit();
        try {
            // First mobile play(): decode now. Resume the context first so iOS
            // honours the user gesture — decodeAudioData itself works on a
            // suspended context, but the subsequent start() needs the gesture
            // chain unbroken.
            if (this._deferDecode) {
                this._resumeCtx();
                await this._decodeAll();
            }
            if (!this.buffers.some(Boolean)) return;
            this._resumeCtx();
            this._restartSources();
            this.isPlay = true;
            this._starting = false;
            this._startTickLoop();
            this._emit();
        } finally {
            if (this._starting) {
                this._starting = false;
                this._emit();
            }
        }
    }
    pause() {
        if (!this.isPlay) return;
        this._syncCurrentTime();
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        this.sources = [];
        this.isPlay = false;
        this._stopTickLoop();
        // Release the audio hardware so Bluetooth output reverts to other apps.
        // Browsers only drop the device when the context is suspended or closed.
        // Close it on an explicit pause so the next play() recreates a clean sink.
        this._closeCtxWhenIdle = true;
        this._scheduleCtxSuspend();
        this._emit();
    }
    toggle() { this.isPlay ? this.pause() : this.play(); }
    seek(delta) { this.jumpTo(this.currentTime + delta); }
    jumpTo(sec) {
        this._syncCurrentTime();
        this.currentTime = Math.max(0, Math.min(this.duration, sec));
        if (this.isPlay) this._restartSources();
        this._emit();
    }
    setVolume(i, v, { emit = true } = {}) {
        const next = this._normalizeVolume(v);
        if (this.volumes[i] === next) return;
        this.volumes[i] = next;
        this._applyTrackGain(i);
        if (emit) this._emit();
    }
    setVolumes(nextVolumes) {
        let changed = false;
        for (let i = 0; i < this.volumes.length; i++) {
            const next = this._normalizeVolume(nextVolumes[i]);
            if (this.volumes[i] === next) continue;
            this.volumes[i] = next;
            this._applyTrackGain(i);
            changed = true;
        }
        if (changed) this._emit();
    }
    setAllVolumes(v) { this.setVolumes(this.volumes.map(() => v)); }
    toggleMute() {
        this._preMuteAll ??= [];
        const allMuted = this.volumes.every(v => v === 0);
        if (allMuted) {
            this.volumes.forEach((_, i) => this.setVolume(i, this._preMuteAll[i] ?? DEFAULT_VOLUME));
            return;
        }
        this._preMuteAll = [...this.volumes];
        this.setAllVolumes(0);
    }
    toggleTrackMute(i) {
        // Stash the pre-mute volume so unmute can restore it. Default to 50% if track was already at 0.
        this._preMute ??= [];
        if (this.volumes[i] > 0) { this._preMute[i] = this.volumes[i]; this.setVolume(i, 0); }
        else                    { this.setVolume(i, this._preMute[i] || DEFAULT_VOLUME); }
    }
    soloTrack(i) {
        // If others are already silenced and this one alone is audible, restore everyone. Otherwise solo.
        this._preMute ??= [];
        const othersAllMuted = this.volumes.every((v, k) => k === i ? v > 0 : v === 0);
        if (othersAllMuted) {
            this.volumes.forEach((_, k) => { if (k !== i) this.setVolume(k, this._preMute[k] || DEFAULT_VOLUME); });
        } else {
            this.volumes.forEach((v, k) => {
                if (k === i) { if (v === 0) this.setVolume(k, this._preMute[k] || DEFAULT_VOLUME); }
                else { if (v > 0) this._preMute[k] = v; this.setVolume(k, 0); }
            });
        }
    }
    toggleRepeat() { this.repeat = !this.repeat; this._emit(); }
    destroy() {
        inspect('player:destroy', {
            tracks: this.files.length,
            hadBuffers: this.buffers.filter(Boolean).length,
            hadEncoded: this._encoded.filter(Boolean).length,
            wasPlaying: this.isPlay,
        });
        this._destroyed = true;
        this._stopTickLoop();
        if (this._emitRafId) { cancelAnimationFrame(this._emitRafId); this._emitRafId = 0; }
        this._clearCtxSuspendTimer();
        this._clearPlaybackEndTimer();
        this._ctxHoldCount = 0;
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        this.sources = [];
        this.isPlay = false;
        this.onChange = null;
        this._encoded = [];
        this.buffers = [];
        this.peaks = [];
        this._closeCtxNow();
    }
}
// ## js-waveform — precomputed peaks → DPR-aware canvas with played overlay
const waveformLayerCache = new WeakMap();
const waveformColorProbe = document.createElement('span');
waveformColorProbe.style.cssText = 'position:absolute;inline-size:0;block-size:0;overflow:hidden;pointer-events:none;opacity:0';

function resolveCssColor(value, fallback) {
    if (!value) return fallback;
    if (!waveformColorProbe.isConnected) document.documentElement.appendChild(waveformColorProbe);
    waveformColorProbe.style.color = fallback;
    waveformColorProbe.style.color = value;
    return getComputedStyle(waveformColorProbe).color || fallback;
}

function waveformColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        wave: resolveCssColor(cs.getPropertyValue('--wave').trim(), '#0082c9'),
        played: resolveCssColor(cs.getPropertyValue('--wave-played').trim(), 'coral'),
    };
}

// Cached colour + force-repaint flag. Invalidated on theme change, resize,
// and tab visibility return (Firefox can drop canvas backing-store while hidden).
let _cachedWaveformColors = null;
let _wfFullRepaint = false;
function getWaveformColors() {
    if (!_cachedWaveformColors) _cachedWaveformColors = waveformColors();
    return _cachedWaveformColors;
}
function invalidateWaveformPaint() {
    _cachedWaveformColors = null;
    _wfFullRepaint = true;
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        if (!document.body.classList.contains('hide-wf')) invalidateWaveformPaint();
        if (player) onPlayerChange(player);
    }
});

function buildWaveformLayer(peaks, w, h, dpr, color) {
    const layer = document.createElement('canvas');
    layer.width = w * dpr;
    layer.height = h * dpr;
    const ctx = layer.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mid = h / 2, n = peaks.length;
    let max = 0;
    for (let i = 0; i < n; i++) if (peaks[i] > max) max = peaks[i];
    const scale = max > 0 ? 1 / max : 1;
    const barW = Math.max(1, w / n - 0.5);
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
        if (peaks[i] <= 0) continue;
        const x = (i / n) * w;
        const a = Math.pow(peaks[i] * scale, 0.7) * (mid - 1);
        ctx.fillRect(x, mid - a, barW, a * 2);
    }
    return layer;
}

function cachedWaveformLayers(peaks, w, h, dpr, colors) {
    const key = `${w}x${h}@${dpr}:${colors.wave}:${colors.played}`;
    let cached = waveformLayerCache.get(peaks);
    if (!cached) {
        cached = new Map();
        waveformLayerCache.set(peaks, cached);
    }
    if (!cached.has(key)) {
        cached.set(key, {
            wave: buildWaveformLayer(peaks, w, h, dpr, colors.wave),
            played: buildWaveformLayer(peaks, w, h, dpr, colors.played),
        });
    }
    return cached.get(key);
}

// Always repaint — Firefox can drop canvas backing-store pixels (tab backgrounding,
// GPU restart, memory pressure) while keeping width/height, so caching the paint
// would leave bars invisible until a reflow.
function paintWaveform(canvas, layer, w, h, dpr) {
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(layer, 0, 0, w, h);
}

// Paint the bars onto both canvases. Returns false if layout isn't ready
// yet (Firefox 0-width race). Caller can retry next frame.
function paintTrackWaveform(trackEl, peaks, colors) {
    const baseCanvas = trackEl._wfBase;
    const playedWrap = trackEl._wfPlayedWrap;
    const playedCanvas = trackEl._wfPlayedCanvas;
    if (!baseCanvas || !playedWrap || !playedCanvas) return false;
    const dpr = window.devicePixelRatio || 1;
    let w = baseCanvas.clientWidth, h = baseCanvas.clientHeight;
    if ((!w || !h) && trackEl._wf) { w = trackEl._wf.clientWidth; h = trackEl._wf.clientHeight; }
    if (!w || !h) return false;
    const layers = cachedWaveformLayers(peaks, w, h, dpr, colors);
    paintWaveform(baseCanvas, layers.wave, w, h, dpr);
    paintWaveform(playedCanvas, layers.played, w, h, dpr);
    return true;
}

function updateTrackProgress(trackEl, played01) {
    const playedWrap = trackEl._wfPlayedWrap;
    if (!playedWrap) return;
    playedWrap.style.setProperty('--played', `${Math.max(0, Math.min(1, played01)) * 100}%`);
}
// ## js-basetones — per-file base tones (note + freq), inline editor, cascade playback
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_INDEX = new Map([
    ['C', 0], ['B#', 0],
    ['C#', 1], ['DB', 1],
    ['D', 2],
    ['D#', 3], ['EB', 3],
    ['E', 4], ['FB', 4],
    ['F', 5], ['E#', 5],
    ['F#', 6], ['GB', 6],
    ['G', 7],
    ['G#', 8], ['AB', 8],
    ['A', 9],
    ['A#', 10], ['BB', 10],
    ['B', 11], ['CB', 11],
]);

// Folder metadata: description + per-file base tones. Server splits storage into
// readme.md (description) and .sync-player.json (tones); the wire shape is unified.
// Tones are persisted as {note} only; freq is derived here.
let baseTones = {};
let metaDescription = '';
// Optimistic-lock tokens from the last server load/save. Null = file expected absent;
// string = expected token; false (default) = no expectation, write unconditionally.
let metaVersions = { readme: false, sidecar: false };
let metaEditMode = false;
let baseToneDirty = false;
let baseToneSaving = false;
let baseToneStatus = '';
let baseToneStatusError = false;
let baseToneSaveTimer = 0;
let baseToneVersion = 0;
let baseToneSavedVersion = 0;
let toneRunMode = '';
let toneRunTimer = 0;
let toneRunStops = [];

const roundFreq = f => Math.round(f * 1000) / 1000;

function clearToneRun() {
    if (toneRunTimer) clearTimeout(toneRunTimer);
    toneRunTimer = 0;
    toneRunStops.splice(0).forEach(stop => stop());
    toneRunMode = '';
}

function clearMetaSaveTimer() {
    if (baseToneSaveTimer) clearTimeout(baseToneSaveTimer);
    baseToneSaveTimer = 0;
}

function setBaseToneStatus(msg = '', isError = false) {
    baseToneStatus = msg;
    baseToneStatusError = isError;
    syncBaseToneUI();
}

function freqToNote(freq) {
    const semis = Math.round(12 * Math.log2(freq / 440));
    const midi = 69 + semis;
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
}

function noteToFreq(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) {
        const hz = Number(raw);
        return Number.isFinite(hz) && hz >= 20 && hz <= 20000 ? hz : null;
    }
    const m = raw.match(/^([A-Ga-g])([#bB]?)(-?\d+)$/);
    if (!m) return null;
    const note = (m[1].toUpperCase() + (m[2] || '')).toUpperCase();
    const octave = Number(m[3]);
    const idx = NOTE_INDEX.get(note);
    if (idx == null) return null;
    const midi = (octave + 1) * 12 + idx;
    return 440 * 2 ** ((midi - 69) / 12);
}

const shiftHalftone = (freq, steps) => freq * 2 ** (steps / 12);

function canonicalTone(freq) {
    const rounded = roundFreq(freq);
    return { note: freqToNote(rounded), freq: rounded };
}

function toneForFile(name) {
    const tone = baseTones[name];
    return tone && Number.isFinite(tone.freq) ? tone : null;
}

function serializeMeta() {
    const tones = Object.fromEntries(
        Object.keys(baseTones).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
            .map(name => [name, { note: canonicalTone(baseTones[name].freq).note }])
    );
    // Only include version keys the server actually gave us (false = unknown, omit).
    const versions = {};
    if (metaVersions.readme  !== false) versions.readme  = metaVersions.readme;
    if (metaVersions.sidecar !== false) versions.sidecar = metaVersions.sidecar;
    return { description: metaDescription, tones, versions };
}

function renderBaseToneControl(name) {
    const tone = toneForFile(name);
    const title = tone ? `${tone.note} (${tone.freq.toFixed(3)} Hz)` : '';
    const canEditCls = CFG.canWrite ? ' can-edit' : '';
    const editor = CFG.canWrite ? `<div class="bt-edit">
        <button type="button" class="btn bt-step bt-down" title="Lower by one semitone">♭</button>
        <input class="bt-input" type="text" value="${escapeHtml(tone?.note || '')}" placeholder="G4" inputmode="text" spellcheck="false" aria-label="Base tone for ${escapeHtml(name)}">
        <button type="button" class="btn bt-step bt-up" title="Raise by one semitone">♯</button>
        <button type="button" class="btn bt-clear" title="Clear base tone"${tone ? '' : ' disabled'}>clear</button>
    </div>` : '';
    return `<div class="bt-wrap${canEditCls}">
        <button type="button" class="btn bt-badge" title="${escapeHtml(title)}"${tone ? '' : ' hidden'}>${escapeHtml(tone?.note || '')}</button>
        ${editor}
    </div>`;
}

function syncBaseToneUI() {
    if (!player) return;

    player.files.forEach((file, i) => {
        const tr = document.querySelector(`.track[data-i="${i}"]`);
        if (!tr) return;
        const tone = toneForFile(file.name);
        const badge = tr.querySelector('.bt-badge');
        const clear = tr.querySelector('.bt-clear');
        const input = tr.querySelector('.bt-input');
        if (badge) {
            badge.textContent = tone?.note || '';
            badge.hidden = !tone;
            badge.title = tone ? `${tone.note} (${tone.freq.toFixed(3)} Hz)` : '';
        }
        if (clear) clear.disabled = !tone;
        if (input && document.activeElement !== input) input.value = tone?.note || '';
    });

    const toneCount = player.files.reduce((n, f) => n + (toneForFile(f.name) ? 1 : 0), 0);
    const hasCascade = toneCount >= 2;
    const cascadeBtn = $('bt-cascade');
    const status = $('bt-status');
    const toneBusy = !!toneRunMode;

    if (cascadeBtn) {
        cascadeBtn.hidden = !hasCascade;
        cascadeBtn.disabled = !hasCascade || toneBusy;
    }
    if (status) {
        status.textContent = baseToneStatus;
        status.classList.toggle('error', !!baseToneStatus && baseToneStatusError);
    }
}

function resetMetaState() {
    clearToneRun();
    clearMetaSaveTimer();
    baseToneDirty = false;
    baseToneSaving = false;
    baseToneStatus = '';
    baseToneStatusError = false;
    baseTones = {};
    metaDescription = '';
    metaVersions = { readme: false, sidecar: false };
    baseToneVersion = 0;
    baseToneSavedVersion = 0;
    setSaveIndicator('idle');
}

// Server-supplied optimistic-lock tokens. `false` → unknown (don't send); a
// string → expected ETag/mtime; `null` → expect file absent.
function applyMetaVersions(v) {
    if (!v || typeof v !== 'object') return;
    metaVersions = { readme: v.readme ?? null, sidecar: v.sidecar ?? null };
}

// Pure: takes a meta payload (from network or IDB) and pushes it into module state.
// Returns true if the payload was applied, false if it was an auth/error envelope.
function applyMetaPayload(res) {
    if (!res || res._appAuth || res._auth || res.error) return false;
    metaDescription = typeof res?.description === 'string' ? res.description : '';
    const tones = {};
    for (const [name, tone] of Object.entries(res?.tones || {})) {
        const note = typeof tone?.note === 'string' ? tone.note.trim() : '';
        const freq = noteToFreq(note);
        if (!Number.isFinite(freq)) continue;
        tones[name] = canonicalTone(freq);
    }
    baseTones = tones;
    applyMetaVersions(res?.versions);
    return true;
}

async function loadFolderMeta(folderPath) {
    resetMetaState();
    const res = await api('load-meta', folderPath);
    if (res._appAuth || res._auth || res.error) return res;
    applyMetaPayload(res);
    return {};
}

async function saveFolderMeta(folderPath, snapshot, saveVersion) {
    if (!CFG.canWrite) return { error: 'This source is read-only' };
    if (baseToneSaving) return { ok: true };
    baseToneSaving = true;
    setSaveIndicator('saving');
    syncBaseToneUI();
    const res = await apiPost('save-meta', folderPath, snapshot);
    baseToneSaving = false;
    if (res._appAuth || res._auth || res.error) {
        setSaveIndicator(res.error ? 'error' : 'idle');
        syncBaseToneUI();
        return res;
    }
    applyMetaVersions(res?.versions);
    baseToneSavedVersion = Math.max(baseToneSavedVersion, saveVersion);
    baseToneDirty = baseToneVersion !== baseToneSavedVersion;
    if (baseToneDirty) {
        setSaveIndicator('saving');
        scheduleMetaSave();
    } else {
        setSaveIndicator('saved');
    }
    return res;
}

async function flushMetaSave() {
    clearMetaSaveTimer();
    if (!CFG.canWrite || !baseToneDirty || baseToneSaving) return;
    const snapshot = serializeMeta();
    const saveVersion = baseToneVersion;
    const res = await saveFolderMeta(CFG.path, snapshot, saveVersion);
    if (handleAuth(res)) return;
    if (res.error === 'conflict') { await handleMetaConflict(saveVersion); return; }
    if (res.error)    setBaseToneStatus(res.error, true);
}

// Triggered when the server rejects a save because readme.md or .sync-player.json
// was changed elsewhere. OK = our edits win (force). Cancel = discard, reload theirs.
async function handleMetaConflict(saveVersion) {
    const keepMine = window.confirm(
        'This folder\'s description or base tones were changed elsewhere since you opened it.\n\n' +
        'OK   – overwrite the remote version with your changes\n' +
        'Cancel – discard your changes and reload the remote version'
    );
    if (keepMine) {
        const snapshot = { ...serializeMeta(), force: true };
        const res = await saveFolderMeta(CFG.path, snapshot, saveVersion);
        if (res.error) setBaseToneStatus(res.error, true);
        return;
    }
    // Discard local edits — clear dirty flags and reload.
    baseToneDirty = false;
    baseToneSavedVersion = baseToneVersion;
    const meta = await loadFolderMeta(CFG.path);
    if (handleAuth(meta)) return;
    if (meta.error)    { setBaseToneStatus(meta.error, true); return; }
    syncDescriptionUI();
    syncBaseToneUI();
    setSaveIndicator('idle');
}

function scheduleMetaSave(delay = 900) {
    if (!CFG.canWrite || !baseToneDirty) return;
    clearMetaSaveTimer();
    baseToneSaveTimer = setTimeout(() => { flushMetaSave(); }, delay);
}

function markMetaDirty() {
    baseToneVersion++;
    baseToneDirty = CFG.canWrite && baseToneVersion !== baseToneSavedVersion;
    if (CFG.canWrite) {
        setSaveIndicator('saving');
        scheduleMetaSave();
    }
}

function setFolderDescription(text) {
    const next = String(text || '');
    if (next === metaDescription) return;
    metaDescription = next;
    markMetaDirty();
    setBaseToneStatus('');
    syncDescriptionUI();
}

function syncDescriptionUI() {
    const edit = $('descr-edit');
    if (!edit) return;
    if (document.activeElement !== edit) edit.value = metaDescription;
    const view = $('descr-view');
    if (view) view.innerHTML = linkifyText(metaDescription || '');
    const ro = !(metaEditMode && CFG.canWrite);
    edit.readOnly = ro;
    if (!CSS.supports?.('field-sizing', 'content')) autosizeTextarea(edit);
}

function playTone(freq, durationMs = 720) {
    if (!player || !Number.isFinite(freq)) return () => {};
    const { ctx, release } = player.holdContext();
    const mix = ctx.createGain();
    // Track #mvol: scale by the same average the master slider reflects, then a fixed boost so tones cut over the mix.
    const masterVol = player.volumes.length
        ? player.volumes.reduce((a, b) => a + b, 0) / player.volumes.length
        : 1;
    mix.gain.value = 1.8 * masterVol;
    const filter = ctx.createBiquadFilter();
    // All partials sit on the fundamental — no +octave/+2-octave layers — so the ear can only lock to f.
    // Triangle carries the body; the quiet sawtooth adds harmonic series for a clear "hook" without octave ambiguity.
    const partials = [
        { type: 'triangle', level: 0.18 },
        { type: 'sawtooth', level: 0.05 },
    ];
    const voices = partials.map(part => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = part.type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(part.level, ctx.currentTime + 0.008);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, part.level * 0.28), ctx.currentTime + 0.09);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
        osc.connect(gain);
        gain.connect(mix);
        return { osc, gain };
    });
    let stopped = false;
    const stopAt = ctx.currentTime + durationMs / 1000;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        voices.forEach(({ osc, gain }) => {
            try { osc.stop(); } catch(e) {}
            osc.disconnect();
            gain.disconnect();
        });
        mix.disconnect();
        filter.disconnect();
        release();
    };

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(2600, Math.max(900, freq * 4)), ctx.currentTime);
    filter.Q.value = 0.8;
    mix.connect(filter);
    filter.connect(player.limiter || ctx.destination);
    voices.forEach(({ osc }) => {
        osc.start();
        osc.stop(stopAt + 0.02);
        osc.onended = stop;
    });
    return stop;
}

function playTrackTone(name) {
    clearToneRun();
    syncBaseToneUI();
    const tone = toneForFile(name);
    if (!tone) return;
    playTone(tone.freq);
}

function setTrackTone(name, freq, play = false) {
    if (!Number.isFinite(freq) || freq < 20 || freq > 20000) return false;
    const next = canonicalTone(freq);
    const prev = toneForFile(name);
    if (!prev || prev.freq !== next.freq) {
        baseTones = { ...baseTones, [name]: next };
        markMetaDirty();
    }
    setBaseToneStatus('');
    syncBaseToneUI();
    if (play) playTone(next.freq);
    return true;
}

function clearTrackTone(name) {
    if (!(name in baseTones)) return;
    const next = { ...baseTones };
    delete next[name];
    baseTones = next;
    markMetaDirty();
    setBaseToneStatus('');
    syncBaseToneUI();
}

function currentToneFiles() {
    return player ? player.files.map(f => ({ ...f, tone: toneForFile(f.name) })).filter(f => f.tone) : [];
}

function runCascade() {
    if (toneRunMode) return;
    const tones = currentToneFiles();
    if (tones.length < 2) return;
    clearToneRun();
    toneRunMode = 'cascade';
    syncBaseToneUI();
    const step = idx => {
        if (toneRunMode !== 'cascade') return;
        if (idx >= tones.length) {
            clearToneRun();
            syncBaseToneUI();
            return;
        }
        toneRunStops = [playTone(tones[idx].tone.freq, 520)];
        toneRunTimer = setTimeout(() => step(idx + 1), 420);
    };
    step(0);
}
// ## js-offline — opt-in "Available offline" pin, eager fetch + IDB audio cache
// Opt-in offline cache. Pinning a folder eagerly fetches every audio file +
// attachment via loadBytes and stores the bytes in the AUDIO_STORE, keyed by
// `${path}::${lm}`. SyncPlayer.load checks that store first, so on later
// offline visits the bytes come straight from IDB even if the SW Cache layer
// got evicted. Listings + meta are cached passively by api() — pinning just
// ensures the audio is there too.
//
// State for the current folder is stored in `_pinState` so the menu UI can
// reflect caching progress without re-querying IDB on every tick.
let _pinState = { pinned: false, caching: false, done: 0, total: 0, error: '' };

async function refreshPinState() {
    const pin = await getPin(CFG.path);
    _pinState = { ..._pinState, pinned: !!pin, caching: false, error: '' };
    syncOfflineUI();
}

function offlineCandidates() {
    const data = _lastRenderData || {};
    return [...(data.files || []), ...(data.attachments || [])];
}

async function pinCurrentFolder() {
    if (window.SyncBackend) return; // single-file build: files are already local
    const directItems = offlineCandidates();
    const directFolders = _lastRenderData?.folders || [];
    if (!directItems.length && !directFolders.length) return;
    // Ask the browser to keep our storage around — without this, IDB can be
    // evicted under storage pressure, which would defeat the point of pinning.
    try { await navigator.storage?.persist?.(); } catch (_) {}

    // fetchTree crawls all subfolders and writes each listing to IDB via api()
    // side-effects — making every folder navigable offline.
    _pinState = { pinned: true, caching: true, done: 0, total: 0, error: '' };
    syncOfflineUI();

    if (!_tree) await fetchTree(CFG.path || '/', Infinity).catch(() => {});

    const pfx = CFG.path;
    const allItems = _tree
        ? Object.entries(_tree)
            .filter(([p]) => pfx === '/' || p === pfx || p.startsWith(pfx + '/'))
            .flatMap(([, e]) => [...(e.files || []), ...(e.attachments || [])])
        : [...directItems]; // fetchTree failed; fall back to direct items only

    if (!allItems.length) { _pinState.caching = false; syncOfflineUI(); return; }

    _pinState.total = allItems.length;
    syncOfflineUI();
    // Persist the pin marker first, so a reload mid-caching still shows the
    // folder as pinned (resuming would happen on a future visit).
    await setPin(CFG.path, {
        pinnedAt: Date.now(),
        items: allItems.map(f => ({ path: f.path, lm: f.lm, name: f.name, kind: f.kind || 'audio' })),
    });
    for (const f of allItems) {
        const key = audioKey(f);
        try {
            let bytes = await audioCacheGet(key);
            if (!bytes) bytes = await loadBytes(f.path);
            await audioCachePut(key, bytes);
        } catch (e) {
            _pinState.error = e?.message || String(e);
        }
        _pinState.done++;
        syncOfflineUI();
    }
    _pinState.caching = false;
    syncOfflineUI();
    await loadPinnedPaths();
    rerenderFolderBadges();
}

async function unpinCurrentFolder() {
    const pin = await getPin(CFG.path);
    if (!pin) return;
    await delPin(CFG.path);
    for (const f of pin.items || []) {
        await audioCacheDel(audioKey(f));
    }
    _pinState = { pinned: false, caching: false, done: 0, total: 0, error: '' };
    syncOfflineUI();
    await loadPinnedPaths();
    rerenderFolderBadges();
}

async function toggleCurrentPin() {
    if (_pinState.caching) return;
    if (_pinState.pinned) {
        const ok = window.confirm('Remove this folder\'s offline copy?\n\nThe audio files will be re-downloaded on the next visit.');
        if (!ok) return;
        await unpinCurrentFolder();
    } else {
        await pinCurrentFolder();
    }
}

function syncOfflineUI() {
    const btn = $('menu-offline');
    const info = $('menu-offline-info');
    if (!btn) return;
    // Single-file/browser-fs build serves files from local disk — caching them
    // again would be pure overhead, so the toggle is meaningless there.
    // Show for folder-only views too: pin will recurse into sub-folders to find audio.
    const eligible = !window.SyncBackend && (offlineCandidates().length > 0 || (_lastRenderData?.folders?.length > 0));
    btn.hidden = !eligible;
    if (info) info.hidden = !eligible;
    if (!eligible) return;
    btn.classList.toggle('on', _pinState.pinned || _pinState.caching);
    btn.setAttribute('aria-checked', String(_pinState.pinned));
    btn.disabled = _pinState.caching;
    const lbl = btn.querySelector('.lbl');
    if (lbl) {
        if (_pinState.caching) {
            lbl.textContent = _pinState.total > 0
                ? `Caching ${_pinState.done} / ${_pinState.total}…`
                : 'Preparing…';
        } else if (_pinState.pinned) {
            lbl.textContent = 'Available offline';
        } else {
            lbl.textContent = 'Make available offline';
        }
    }
    if (info) {
        if (_pinState.error) info.textContent = 'Some files failed: ' + _pinState.error;
        else if (_pinState.pinned) info.textContent = 'Audio + waveforms stored in your browser. Tap to remove.';
        else info.textContent = 'Download all audio in this folder for offline playback.';
    }
}
// ## js-stage — spatial mix: tracks on a circle + draggable listener, distance sets volume
// Each track sits in a normalized [0..1] square. Distance from track to listener
// drives an equal-power falloff (cos curve). Past the per-track audibility radius
// the track is fully muted. When the stage is active it writes those values
// directly into the real per-track volumes; manual slider edits then deactivate it.
const STAGE_ENABLED_KEY = 'syncplayer.stage.enabled';
const STAGE_INFO_ACTIVE = 'Walk around the mix — drag tracks and the listener; distance sets each track\'s volume.';
const STAGE_INFO_INACTIVE = 'Stage is visible but inactive — volume sliders now drive the mix directly. Drag the stage to reactivate it.';
const STAGE_CIRCLE_R = 0.18;                        // default placement radius (square-normalized)
// Audibility radius = 1.5 × placement radius. Anchors the falloff so:
//   d = 0   (on the track)         → v = 1
//   d = a   (default listener pos) → v = cos(π/3) = 0.5
//   d = 1.5a                       → v = 0  (mute boundary)
const STAGE_AUDIBLE_R = STAGE_CIRCLE_R * 1.5;

let _stageOn = false;
let _stageActive = true;
let _stageState = null;          // {listener:{x,y}, tracks:{[name]:{x,y}}, fingerprint}
let _stagePersistTimer = 0;

const stageKey = () => `syncplayer.stage::${CFG.adapterId || 'default'}::${CFG.path}`;
// Radii are part of the fingerprint so tuning them invalidates saved positions —
// otherwise old defaults stick around against new audibility rings.
const stageFingerprint = files =>
    `r${STAGE_CIRCLE_R}-${STAGE_AUDIBLE_R}|`
    + files.map(f => `${f.name}::${f.lm || ''}`).join('|');
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

function stageDefaults(files) {
    const tracks = {};
    const n = files.length;
    for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI / n);
        tracks[files[i].name] = {
            x: 0.5 + STAGE_CIRCLE_R * Math.cos(a),
            y: 0.5 + STAGE_CIRCLE_R * Math.sin(a),
        };
    }
    return { listener: { x: 0.5, y: 0.5 }, tracks, fingerprint: stageFingerprint(files) };
}

// Reset to defaults if the saved fingerprint doesn't match the current files —
// adding, removing or replacing tracks invalidates the stored positions.
function loadStageStateFor(files) {
    const fp = stageFingerprint(files);
    try {
        const raw = localStorage.getItem(stageKey());
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.fingerprint === fp && parsed.tracks && parsed.listener) {
                const def = stageDefaults(files);
                for (const name of Object.keys(def.tracks)) {
                    if (!parsed.tracks[name]) parsed.tracks[name] = def.tracks[name];
                }
                return parsed;
            }
        }
    } catch (_) {}
    return stageDefaults(files);
}

function persistStageSoon() {
    if (_stagePersistTimer) return;
    _stagePersistTimer = setTimeout(() => {
        _stagePersistTimer = 0;
        try { localStorage.setItem(stageKey(), JSON.stringify(_stageState)); } catch (_) {}
    }, 250);
}
function persistStageNow() {
    if (_stagePersistTimer) { clearTimeout(_stagePersistTimer); _stagePersistTimer = 0; }
    try { localStorage.setItem(stageKey(), JSON.stringify(_stageState)); } catch (_) {}
}

// Pure cos falloff from v=1 at the track to v=0 at the audibility ring.
function stageTrackVolume(trackPos, listener) {
    const d = Math.hypot(trackPos.x - listener.x, trackPos.y - listener.y);
    if (d >= STAGE_AUDIBLE_R) return 0;
    return Math.cos(Math.PI / 2 * (d / STAGE_AUDIBLE_R));
}

function stageAffectsVolume() {
    return _stageOn && _stageActive;
}

function setSliderVisual(slider, pct) {
    if (!slider) return;
    const n = Number(pct);
    const clamped = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
    slider.style.setProperty('--vol-pct', `${clamped}%`);
}

function syncStageUI() {
    const inactive = _stageOn && !_stageActive;
    document.body.classList.toggle('stage-on', _stageOn);
    document.body.classList.toggle('stage-inactive', inactive);
    const btn = $('menu-stage');
    if (btn) {
        btn.classList.toggle('on', _stageOn);
        btn.setAttribute('aria-checked', String(_stageOn));
        const lbl = btn.querySelector('.lbl');
        if (lbl) lbl.textContent = inactive ? 'Stage (inactive)' : 'Stage';
    }
    const info = $('menu-stage-info');
    if (info) info.textContent = inactive ? STAGE_INFO_INACTIVE : STAGE_INFO_ACTIVE;
    const hint = $('stage-hint');
    if (hint) hint.textContent = inactive ? STAGE_INFO_INACTIVE : 'Drag tracks and the listener. Volume rises as the listener moves closer; outside a track\'s ring is mute. Tap empty space to teleport the listener.';
}

function activateStageForGesture() {
    if (_stageActive) return;
    _stageActive = true;
    syncStageUI();
}

function deactivateStageForManualVolume() {
    if (!_stageOn || !_stageActive) return;
    _stageActive = false;
    syncStageUI();
    applyStageAll();
}

function stageTrackLevel(i) {
    if (!player || !_stageState) return DEFAULT_VOLUME;
    const tp = _stageState.tracks[player.files[i].name];
    return tp ? stageTrackVolume(tp, _stageState.listener) : DEFAULT_VOLUME;
}

function stageTrackVisualLevel(v) {
    const gain = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    return gain ** 1.5;
}

function syncStageTrackVisual(i) {
    if (!player) return;
    const g = document.querySelector(`.stage-track[data-i="${i}"]`);
    if (!g) return;
    const visual = stageAffectsVolume() ? stageTrackLevel(i) : (player.volumes[i] ?? 0);
    g.style.setProperty('--stage-vol', stageTrackVisualLevel(visual).toFixed(3));
}

function applyStageTrack(i) {
    if (!player || !_stageState) return;
    if (stageAffectsVolume()) player.setVolume(i, stageTrackLevel(i));
    else syncStageTrackVisual(i);
}
function applyStageAll() {
    if (!player) return;
    if (stageAffectsVolume()) {
        player.setVolumes(player.files.map((_, i) => stageTrackLevel(i)));
    }
    for (let i = 0; i < player.files.length; i++) syncStageTrackVisual(i);
}

function renderStage(files) {
    // Stage is rendered lazily: while off, we skip the SVG entirely (no per-track
    // <g>, no pointer-event bindings, no layout). applyStageEnabled injects it
    // on demand when the user toggles the menu item on.
    if (!files.length || !_stageOn) return '';
    const tracksSVG = files.map((f, i) => {
        const label = escapeHtml(f.name.replace(/\.[^.]+$/, '').slice(0, 14));
        return `<g class="stage-track" data-i="${i}">
            <circle class="stage-track-outer" r="${(STAGE_AUDIBLE_R * 100).toFixed(2)}"/>
            <circle class="stage-track-dot" r="3"/>
            <text class="stage-track-label" y="-5.5" text-anchor="middle">${label}</text>
        </g>`;
    }).join('');
    return `<div class="stage" id="stage" aria-label="Spatial mix">
        <div class="stage-canvas">
        <button type="button" class="btn stage-reset" id="stage-reset">Reset</button>
            <svg id="stage-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <g class="stage-tracks">${tracksSVG}</g>
                <g class="stage-listener" id="stage-listener">
                    <circle class="stage-listener-halo" r="8"/>
                    <circle class="stage-listener-dot" r="3.5"/>
                </g>
            </svg>
        </div>
        <span class="stage-hint" id="stage-hint">Drag tracks and the listener. Volume rises as the listener moves closer; outside a track's ring is mute. Tap empty space to teleport the listener.</span>
    </div>`;
}

function setStageTrackPos(i, x, y) {
    const g = document.querySelector(`.stage-track[data-i="${i}"]`);
    if (g) g.setAttribute('transform', `translate(${(x * 100).toFixed(3)},${(y * 100).toFixed(3)})`);
}
function setStageListenerPos(x, y) {
    const g = $('stage-listener');
    if (g) g.setAttribute('transform', `translate(${(x * 100).toFixed(3)},${(y * 100).toFixed(3)})`);
}

// Pointer-capture drag. The SVG's bounding rect is captured at pointerdown so
// the drag doesn't tear if the page reflows mid-drag.
function bindStageDrag(el, onMove) {
    el.addEventListener('pointerdown', e => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const svg = $('stage-svg');
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        const move = ev => onMove(
            clamp01((ev.clientX - rect.left) / rect.width),
            clamp01((ev.clientY - rect.top) / rect.height),
        );
        move(e);
        const up = () => {
            try { el.releasePointerCapture(e.pointerId); } catch (_) {}
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            persistStageNow();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    });
}

function bindStage(files) {
    const svg = $('stage-svg');
    if (!svg) return;
    files.forEach((f, i) => {
        const p = _stageState.tracks[f.name];
        if (p) setStageTrackPos(i, p.x, p.y);
    });
    setStageListenerPos(_stageState.listener.x, _stageState.listener.y);
    applyStageAll();

    files.forEach((f, i) => {
        const g = svg.querySelector(`.stage-track[data-i="${i}"]`);
        if (!g) return;
        bindStageDrag(g, (x, y) => {
            activateStageForGesture();
            _stageState.tracks[f.name] = { x, y };
            setStageTrackPos(i, x, y);
            applyStageTrack(i);
            persistStageSoon();
        });
    });
    const listener = $('stage-listener');
    if (listener) bindStageDrag(listener, (x, y) => {
        activateStageForGesture();
        _stageState.listener = { x, y };
        setStageListenerPos(x, y);
        applyStageAll();
        persistStageSoon();
    });

    // Tap on empty space teleports the listener — handy on mobile where dragging
    // the small listener dot is fiddly. Track / listener pointerdowns stopProp
    // so they don't double-fire this.
    svg.addEventListener('pointerdown', e => {
        if (e.target.closest('.stage-track') || e.target.closest('.stage-listener')) return;
        const rect = svg.getBoundingClientRect();
        activateStageForGesture();
        _stageState.listener = {
            x: clamp01((e.clientX - rect.left) / rect.width),
            y: clamp01((e.clientY - rect.top) / rect.height),
        };
        setStageListenerPos(_stageState.listener.x, _stageState.listener.y);
        applyStageAll();
        persistStageNow();
    });

    $('stage-reset')?.addEventListener('click', () => {
        activateStageForGesture();
        _stageState = stageDefaults(player.files);
        player.files.forEach((f, i) => {
            const p = _stageState.tracks[f.name];
            setStageTrackPos(i, p.x, p.y);
        });
        setStageListenerPos(_stageState.listener.x, _stageState.listener.y);
        applyStageAll();
        persistStageNow();
    });
}

function initStage(files) {
    if (!files?.length) return;
    _stageState = loadStageStateFor(files);
    syncStageUI();
    // Only bind when the SVG is actually in the DOM. When off, renderStage()
    // returns '' so there's nothing to bind to.
    if (_stageOn) bindStage(files);
}

// Build + inject the stage SVG into the current player view (used when the
// user toggles the stage on after a render where it was skipped). Returns
// false if there's no player to inject into.
function mountStage() {
    if (!player || !player.files.length) return false;
    if ($('stage')) return true;
    const playerEl = document.querySelector('.player');
    if (!playerEl) return false;
    playerEl.insertAdjacentHTML('beforeend', renderStage(player.files));
    syncStageUI();
    if (!_stageState) _stageState = loadStageStateFor(player.files);
    bindStage(player.files);
    return true;
}

function unmountStage() {
    $('stage')?.remove();
}

function applyStageEnabled(on) {
    const wasOn = _stageOn;
    _stageOn = !!on;
    if (_stageOn) _stageActive = true;
    try { localStorage.setItem(STAGE_ENABLED_KEY, _stageOn ? '1' : '0'); } catch (_) {}
    syncStageUI();
    if (_stageOn && !wasOn) mountStage();
    else if (!_stageOn && wasOn) unmountStage();
    applyStageAll();
}

function initStageEnabled() {
    const def = IS_MOBILE ? '0' : '1';
    let v = def;
    try { v = localStorage.getItem(STAGE_ENABLED_KEY) ?? def; } catch (_) {}
    applyStageEnabled(v === '1');
}
// ## js-ui — init/SWR, renderView, controls, attachments, keyboard
let player = null;

// Cached DOM refs — rebuilt on every renderView so the per-tick onPlayerChange
// path skips querySelector. Cleared when the player goes away.
let _trackEls = [];
let _ui = {};
function cacheTrackElements(trackEl) {
    trackEl._wfBase = trackEl.querySelector('.wf-base');
    trackEl._wfPlayedWrap = trackEl.querySelector('.wf-played');
    trackEl._wfPlayedCanvas = trackEl._wfPlayedWrap?.querySelector('canvas');
    trackEl._wf = trackEl.querySelector('.wf');
    trackEl._tvol = trackEl.querySelector('.tvol');
    trackEl._volNum = trackEl.querySelector('.vol-num');
    trackEl._paintedPeaks = null;
}
function cachePlayerUI() {
    const seek = $('seek');
    _ui = {
        seek,
        loadFill: seek?.querySelector('i'),
        playFill: seek?.querySelector('b'),
        play: $('play'),
        back5: $('back5'),
        fwd5: $('fwd5'),
        time: $('time'),
        playIc: $('play-ic'),
        startup: $('player-startup'),
        rep: $('rep'),
        mvol: $('mvol'),
        masterWrap: document.querySelector('.master-inner .vol-wrap'),
    };
}
function clearPlayerUICache() { _trackEls = []; _ui = {}; }

// Stop an in-flight player so its loadBytes()/decode loops don't keep firing
// against a backend we've decided is unauthed or unreachable.
function teardownPlayer() {
    if (!player) return;
    try { player.destroy(); } catch (_) {}
    player = null;
    clearPlayerUICache();
    disconnectWaveformObserver();
    _lastLoadStatusKey = '';
}

function setHeader() {
    const segs = CFG.path.split('/').filter(Boolean);
    $('back').style.display = segs.length ? '' : 'none';
    const headerTitle = segs.length ? segs[segs.length - 1] : (CFG.title || 'Sync Player');
    $('ti').textContent = headerTitle;
    document.title = headerTitle;
    syncNetworkIndicator();

    const clearDemo = $('clear-demo');
    clearDemo.style.display = window.SyncBackend?.ready?.() ? '' : 'none';

    const cloud = $('menu-cloud');
    if (cloud) {
        const url = currentCloudUrl();
        if (url) { cloud.href = url; cloud.hidden = false; }
        else { cloud.removeAttribute('href'); cloud.hidden = true; }
    }
}

function navUp() {
    if (attachmentPreview.overlay) { attachmentPreview.closeOverlay(); return; }
    const p = CFG.path.replace(/\/$/, '').split('/'); p.pop();
    navigate(p.join('/') || '/');
}
window.navUp = navUp;
window.clearDemoRoot = () => {
    if (!window.SyncBackend?.clearRoot?.()) return;
};

// Browser back / Android system back closes fullscreen first.
window.addEventListener('popstate', () => {
    if (attachmentPreview.overlay) {
        attachmentPreview.closeOverlay(true);
        return;
    }
    initInspect();
    CFG.path = pathFromLocation();
    setHeader();
    setPendingNavigation(CFG.path);
    init();
});
// SPA wiring for folder navigation: keep internal `?path=` links in-app unless the
// user is explicitly opening a new tab/window.
document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="?"]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const path = new URL(a.href).searchParams.get('path');
    if (path == null) return;
    e.preventDefault();
    navigate(path || '/');
});

if (window.SyncBackend) {
    // Drag-drop or picker swapped the active root — go back to / and re-render.
    document.addEventListener('sync-root-changed', () => {
        if (CFG.path !== '/') {
            history.pushState(null, '', '?' + new URLSearchParams({ path: '/' }));
            CFG.path = '/';
        }
        init();
    });
}

const setHelp = open => $('help').hidden = !open;
const toggleHelp = () => { setHelp($('help').hidden); if (!$('help').hidden) setMenu(false); };
window.toggleHelp = toggleHelp;
document.addEventListener('click', e => {
    if ($('help').hidden) return;
    if (e.target.closest('#help') || e.target.closest('#help-btn')) return;
    setHelp(false);
});

// Header three-dot menu: edit-mode toggle + info + theme picker.
const setMenu = open => {
    const m = $('menu'); if (!m) return;
    m.hidden = !open;
    $('menu-btn')?.setAttribute('aria-expanded', String(!!open));
};
const toggleMenu = () => { setMenu($('menu').hidden); if (!$('menu').hidden) setHelp(false); };
window.toggleMenu = toggleMenu;
document.addEventListener('click', e => {
    if ($('menu')?.hidden) return;
    if (e.target.closest('#menu') || e.target.closest('#menu-btn')) return;
    setMenu(false);
});

// Theme: 'auto' (default) follows OS, 'light' / 'dark' force. Persisted in localStorage.
const THEME_KEY = 'syncplayer.theme';
const PWA_THEME_COLORS = { light: '#f3ecdc', dark: '#0e1116' };
const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';
function resolveTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try { return matchMedia(THEME_MEDIA_QUERY).matches ? 'dark' : 'light'; }
    catch (_) { return 'dark'; }
}
function syncThemeColor(theme) {
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', PWA_THEME_COLORS[resolveTheme(theme)]);
}
function applyTheme(theme) {
    const t = ['auto','light','dark'].includes(theme) ? theme : 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch(e) {}
    document.querySelectorAll('#theme-seg button').forEach(b => {
        b.classList.toggle('on', b.dataset.theme === t);
        b.setAttribute('aria-checked', String(b.dataset.theme === t));
    });
    syncThemeColor(t);
    invalidateWaveformPaint();
    if (player) onPlayerChange(player);
}
function initTheme() {
    let t = 'auto';
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch(e) {}
    applyTheme(t);
    try {
        const mql = matchMedia(THEME_MEDIA_QUERY);
        const onThemeMediaChange = () => {
            let current = 'auto';
            try { current = localStorage.getItem(THEME_KEY) || 'auto'; } catch(e) {}
            if (current === 'auto') syncThemeColor('auto');
        };
        if (mql.addEventListener) mql.addEventListener('change', onThemeMediaChange);
        else if (mql.addListener) mql.addListener(onThemeMediaChange);
    } catch (_) {}
}

const SHOW_WF_KEY = 'syncplayer.showWaveforms';
function applyShowWaveforms(show) {
    document.body.classList.toggle('hide-wf', !show);
    try { localStorage.setItem(SHOW_WF_KEY, show ? '1' : '0'); } catch(e) {}
    const btn = $('menu-show-wf');
    if (btn) {
        btn.classList.toggle('on', show);
        btn.setAttribute('aria-checked', String(show));
    }
    if (show) {
        invalidateWaveformPaint();
        observeWaveformLayouts();
        // Tracks loaded with wf hidden have empty peaks — compute them now.
        if (player) { player.computeMissingPeaks?.(); onPlayerChange(player); }
    }
}
function initShowWaveforms() {
    const def = IS_MOBILE ? '0' : '1';
    let v = def;
    try { v = localStorage.getItem(SHOW_WF_KEY) ?? def; } catch(e) {}
    applyShowWaveforms(v !== '0');
}

// Save indicator dot in the header chip. Saved state auto-fades back to idle so
// the chip rests at a neutral state when nothing's happening.
let _saveIndicatorClearTimer = 0;
function setSaveIndicator(state) {
    const chip = $('edit-chip');
    if (!chip) return;
    chip.classList.remove('saving', 'saved', 'error');
    if (state && state !== 'idle') chip.classList.add(state);
    clearTimeout(_saveIndicatorClearTimer);
    if (state === 'saved' || state === 'error') {
        _saveIndicatorClearTimer = setTimeout(() => {
            chip.classList.remove('saved', 'error');
        }, state === 'saved' ? 1600 : 4000);
    }
}

function setEditMode(on) {
    const next = !!on && CFG.canWrite;
    if (metaEditMode && !next) {
        // Commit pending text edits: blur any focused field inside an edit zone so
        // its onblur / change handler fires before the editors hide.
        const el = document.activeElement;
        if (el && (el.classList.contains('bt-input') || el.classList.contains('descr-edit'))) el.blur();
    }
    metaEditMode = next;
    document.body.classList.toggle('edit-mode', metaEditMode);
    syncDescriptionUI();
    const btn = $('menu-edit');
    if (btn) {
        btn.classList.toggle('on', metaEditMode);
        btn.setAttribute('aria-checked', String(metaEditMode));
    }
}

function bindMenu() {
    $('edit-chip')?.addEventListener('click', () => setEditMode(false));
    $('menu-cloud')?.addEventListener('click', () => setMenu(false));
    $('menu-offline')?.addEventListener('click', () => toggleCurrentPin());
    const editBtn = $('menu-edit');
    if (editBtn) {
        if (!CFG.canWrite) {
            editBtn.disabled = true;
            editBtn.title = 'This source is read-only';
            const info = $('menu-edit-info');
            if (info) info.textContent = 'This source is read-only. Base tones and the description cannot be changed here.';
        }
        editBtn.onclick = () => CFG.canWrite && setEditMode(!metaEditMode);
    }
    const inspectBtn = $('menu-inspect');
    if (inspectBtn) inspectBtn.onclick = () => setInspectEnabled(!_inspectEnabled);
    document.querySelectorAll('#theme-seg button').forEach(b => {
        b.onclick = () => applyTheme(b.dataset.theme);
    });
    const showWfBtn = $('menu-show-wf');
    if (showWfBtn) {
        showWfBtn.onclick = () => applyShowWaveforms(document.body.classList.contains('hide-wf'));
    }
    const stageBtn = $('menu-stage');
    if (stageBtn) {
        stageBtn.onclick = () => applyStageEnabled(!document.body.classList.contains('stage-on'));
    }
}

// Per-track ⋮ menu — only one open at a time.
function closeAllTrackMenus() {
    document.querySelectorAll('.track-menu-pop').forEach(p => p.hidden = true);
    document.querySelectorAll('.menu-trigger-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
function toggleTrackMenu(i) {
    const pop = $(`tmenu-${i}`);
    if (!pop) return;
    const wasOpen = !pop.hidden;
    closeAllTrackMenus();
    if (!wasOpen) {
        pop.hidden = false;
        document.querySelector(`[data-track-menu="${i}"]`)?.setAttribute('aria-expanded', 'true');
    }
}
document.addEventListener('click', e => {
    if (
        e.target.closest('.track-menu-pop')
        || e.target.closest('.menu-trigger-btn')
        || e.target.closest('.attachment-menu-pop')
        || e.target.closest('.attachment-menu-btn')
    ) return;
    closeAllTrackMenus();
    closeAllAttachmentMenus();
});

async function downloadTrackFile(file) {
    if (!file) return;
    if (window.SyncBackend?.downloadFile) {
        try { await window.SyncBackend.downloadFile(file.path, file.name); }
        catch (e) { setBaseToneStatus('Download failed: ' + (e?.message || e), true); }
        return;
    }
    const a = document.createElement('a');
    a.href = fileHref(file.path, true);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function openAttachmentNewTab(file) {
    if (!window.SyncBackend) {
        // Server target: direct URL — synchronous, no popup-blocker risk.
        window.open('?' + qs('fetch', file.path), '_blank', 'noopener,noreferrer');
        return;
    }
    try {
        const bytes = await loadAttachmentBytes(file);
        const url = URL.createObjectURL(new Blob([bytes], { type: attachmentMimeType(file) }));
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
        setBaseToneStatus('Could not open: ' + (e?.message || e), true);
    }
}

function canPreviewAttachment(file) {
    return file?.kind === 'image' || file?.kind === 'pdf';
}

async function loadAttachmentBytes(file) {
    return (await loadCachedBytes(file, { persist: true })).bytes;
}

function attachmentPreviewURL(file, blobUrl) {
    if (!window.SyncBackend && file?.kind === 'pdf') return fileHref(file.path);
    return blobUrl;
}

function attachmentMimeType(file) {
    const name = (file?.name || '').toLowerCase();
    if (name.endsWith('.avif')) return 'image/avif';
    if (name.endsWith('.bmp')) return 'image/bmp';
    if (name.endsWith('.gif')) return 'image/gif';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.svg')) return 'image/svg+xml';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
}

function shortAttachmentName(name, max = 40) {
    if (!name || name.length <= max) return name || '';
    return name.slice(0, Math.max(0, max - 3)) + '...';
}

function attachmentActionIcon(name) {
    if (name === 'open') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3z"/><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/></svg>';
    }
    if (name === 'download') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.59l3.29-3.3 1.42 1.42L12 16.41l-4.71-4.7 1.42-1.42L12 13.59V3z"/><path d="M5 19h14v2H5z"/></svg>';
    }
    if (name === 'inline') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
    if (name === 'overlay') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9V3h6"/><path d="M21 9V3h-6"/><path d="M3 15v6h6"/><path d="M21 15v6h-6"/></svg>';
    }
    return '';
}

function attachmentMenuHTML(file, i) {
    const items = [
        `<button type="button" data-attachment-opentab="${i}" role="menuitem">${attachmentActionIcon('open')}<span>Open</span></button>`,
        `<button type="button" data-attachment-download="${i}" role="menuitem">${attachmentActionIcon('download')}<span>Download</span></button>`,
    ];
    if (!IS_MOBILE && canPreviewAttachment(file)) {
        items.push(`<button type="button" data-attachment-open="${i}" role="menuitem">${attachmentActionIcon('inline')}<span>Show here</span></button>`);
        items.push(`<button type="button" data-attachment-fullscreen="${i}" role="menuitem">${attachmentActionIcon('overlay')}<span>Open large</span></button>`);
    }
    return `<div class="attachment-menu-wrap">
        <button type="button" class="btn menu-trigger-btn attachment-menu-btn" data-attachment-menu="${i}" aria-haspopup="menu" aria-expanded="false" title="More actions" aria-label="More actions for ${escapeHtml(file.name)}"><span class="menu-trigger-dots">⋮</span></button>
        <div class="attachment-menu-pop" id="attachment-menu-${i}" hidden role="menu">${items.join('')}</div>
    </div>`;
}

// Attachment preview has two modes:
//   - inline: a single bordered square below the chips (no outer wrapper chrome,
//     so it doesn't look container-in-container)
//   - fullscreen overlay: a fixed overlay z-indexed below .master (z:40), with
//     bottom offset to the master's height — so the transport bar stays visible
//     and usable while reading/viewing.
const attachmentPreview = {
    // inline state
    path: '',
    url: '',
    file: null,
    // overlay state
    overlay: null,
    overlayUrl: '',
    onKey: null,
    masterObserver: null,
    pushedHistory: false,

    panel() { return $('attachment-inline-preview'); },

    mediaHTML(file, url, cls) {
        return file.kind === 'pdf'
            ? `<object class="${cls} ${cls}-pdf" data="${escapeHtml(url)}" type="application/pdf"><a class="attachment-pdf-fallback" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open PDF</a></object>`
            : `<img class="${cls} ${cls}-image" src="${escapeHtml(url)}" alt="${escapeHtml(file.name)}" loading="lazy">`;
    },

    // Zoom is image-only — PDFs have their own viewer zoom. Buttons live in the
    // stage's overlay-actions strip; the wheel handler is on the scrollable root.
    zoomButtonsHTML(file) {
        if (file.kind !== 'image') return '';
        return `<button type="button" class="attachment-stage-btn" data-attachment-zoom-out title="Zoom out" aria-label="Zoom out">−</button>
            <button type="button" class="attachment-stage-btn" data-attachment-zoom-in title="Zoom in" aria-label="Zoom in">+</button>`;
    },

    // Always-visible open link for PDF — essential on mobile where embedded viewer is limited.
    pdfOpenHTML(file, url) {
        if (file.kind !== 'pdf') return '';
        return `<a class="attachment-stage-btn attachment-pdf-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open PDF" aria-label="Open PDF in new tab">↗</a>`;
    },

    bindZoom(root, mediaSelector) {
        const media = root.querySelector(mediaSelector);
        if (!media) return;
        let scale = 1;
        const set = (v) => {
            scale = Math.max(0.1, Math.min(8, v));
            media.style.setProperty('--scale', String(scale));
        };
        root.querySelectorAll('[data-attachment-zoom-in]').forEach(b => b.addEventListener('click', () => set(scale * 1.10)));
        root.querySelectorAll('[data-attachment-zoom-out]').forEach(b => b.addEventListener('click', () => set(scale / 1.10)));
        root.addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            set(scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05));
        }, { passive: false });
    },

    resetButtonStates() {
        document.querySelectorAll('[data-attachment-open], [data-attachment-fullscreen]').forEach(btn => {
            btn.classList.remove('on');
            btn.disabled = false;
        });
    },

    setInlineButton(i, on = false, disabled = false) {
        const btn = document.querySelector(`[data-attachment-open="${i}"]`);
        if (!btn) return;
        btn.classList.toggle('on', on);
        btn.disabled = disabled;
    },

    setFullscreenButton(i, disabled = false) {
        const btn = document.querySelector(`[data-attachment-fullscreen="${i}"]`);
        if (btn) btn.disabled = disabled;
    },

    clearInline() {
        if (this.url.startsWith('blob:')) URL.revokeObjectURL(this.url);
        this.path = '';
        this.url = '';
        this.file = null;
        const panel = this.panel();
        if (panel) {
            panel.hidden = true;
            panel.dataset.path = '';
            panel.innerHTML = '';
        }
    },

    closeOverlay(fromPopstate = false) {
        if (!this.overlay && !this.pushedHistory) return;
        if (this.masterObserver) { this.masterObserver.disconnect(); this.masterObserver = null; }
        if (this.onKey) {
            document.removeEventListener('keydown', this.onKey, true);
            this.onKey = null;
        }
        if (this.overlayUrl.startsWith('blob:')) URL.revokeObjectURL(this.overlayUrl);
        this.overlayUrl = '';
        this.overlay?.remove();
        this.overlay = null;
        if (this.pushedHistory && !fromPopstate) {
            this.pushedHistory = false;
            history.back();
        } else {
            this.pushedHistory = false;
        }
    },

    clear() {
        this.closeOverlay();
        this.clearInline();
        this.resetButtonStates();
    },

    inlineHTML(file, url) {
        return `<div class="attachment-inline-stage" id="attachment-inline-stage">
            ${this.mediaHTML(file, url, 'attachment-inline-media')}
            <div class="attachment-inline-overlay-actions">
                ${this.zoomButtonsHTML(file)}
                ${this.pdfOpenHTML(file, url)}
                <button type="button" class="attachment-stage-btn" id="attachment-preview-close" title="Close" aria-label="Close preview">×</button>
            </div>
        </div>`;
    },

    bindPanel() {
        $('attachment-preview-close')?.addEventListener('click', () => {
            this.clearInline();
            this.resetButtonStates();
        });
    },

    updateBottomOffset() {
        if (!this.overlay) return;
        const master = $('master');
        this.overlay.style.bottom = (master ? master.offsetHeight : 0) + 'px';
    },

    async openInline(file, i) {
        if (!canPreviewAttachment(file)) return;
        const panel = this.panel();
        if (!panel) return;
        if (this.path === file.path) {
            this.clearInline();
            this.resetButtonStates();
            return;
        }
        this.clearInline();
        this.setInlineButton(i, false, true);
        try {
            const bytes = await loadAttachmentBytes(file);
            const blobUrl = URL.createObjectURL(new Blob([bytes], { type: attachmentMimeType(file) }));
            const url = attachmentPreviewURL(file, blobUrl);
            this.path = file.path;
            this.url = blobUrl;
            this.file = file;
            panel.dataset.path = file.path;
            panel.hidden = false;
            panel.innerHTML = this.inlineHTML(file, url);
            this.bindPanel();
            const stage = $('attachment-inline-stage');
            if (stage) this.bindZoom(stage, '.attachment-inline-media-image');
            this.setInlineButton(i, true, false);
        } catch (e) {
            setBaseToneStatus('Preview failed: ' + (e?.message || e), true);
            this.setInlineButton(i, false, false);
        }
    },

    async openOverlay(file, i) {
        if (!canPreviewAttachment(file)) return;
        this.setFullscreenButton(i, true);
        try {
            const bytes = await loadAttachmentBytes(file);
            const blobUrl = URL.createObjectURL(new Blob([bytes], { type: attachmentMimeType(file) }));
            const url = attachmentPreviewURL(file, blobUrl);
            this.closeOverlay();
            this.overlayUrl = blobUrl;
            const overlay = document.createElement('div');
            overlay.className = 'attachment-fs-stage';
            overlay.tabIndex = -1;
            const zoomBtns = this.zoomButtonsHTML(file);
            const openLink = this.pdfOpenHTML(file, url);
            overlay.innerHTML = `<div class="attachment-fs-actions">${zoomBtns}${openLink}<button type="button" class="attachment-stage-btn attachment-fs-close" aria-label="Close fullscreen" title="Close (Esc)">×</button></div>${this.mediaHTML(file, url, 'attachment-fs-media')}`;
            this.overlay = overlay;
            document.body.appendChild(overlay);
            this.bindZoom(overlay, '.attachment-fs-media-image');
            this.updateBottomOffset();
            const master = $('master');
            if (master && typeof ResizeObserver === 'function') {
                this.masterObserver = new ResizeObserver(() => this.updateBottomOffset());
                this.masterObserver.observe(master);
            }
            // Embedded PDF viewer auto-focuses and eats keys. Focus the overlay so
            // Escape works at least until the user clicks into the PDF.
            this.onKey = (e) => { if (e.key === 'Escape') { this.closeOverlay(); e.preventDefault(); } };
            document.addEventListener('keydown', this.onKey, true);
            overlay.querySelector('.attachment-fs-close')?.addEventListener('click', () => this.closeOverlay());
            try {
                history.pushState({ syncFsOverlay: true }, '');
                this.pushedHistory = true;
            } catch {}
            overlay.focus({ preventScroll: true });
        } catch (e) {
            setBaseToneStatus('Preview failed: ' + (e?.message || e), true);
        } finally {
            this.setFullscreenButton(i, false);
        }
    },
};

async function init() {
    setHeader();
    if (window.SyncBackend && !window.SyncBackend.ready()) {
        clearPendingNavigation(CFG.path);
        window.SyncBackend.renderPicker($('root'), () => init());
        return;
    }

    // Capture the path the current init() round is for. If the user navigates
    // away before the network fetch resolves, the late response is for a
    // different folder — bail instead of overwriting the active view.
    const myPath = CFG.path;
    const stillCurrent = () => CFG.path === myPath;
    inspect('init:start', { path: myPath });

    if (!window.SyncBackend && !_tree) _tree = loadTreeFromLocalStorageSync();

    async function renderCached(cachedList) {
        if (!cachedList || !stillCurrent()) return false;
        inspect('init:cached-render', () => ({
            folders: (cachedList.folders || []).length,
            files: (cachedList.files || []).length,
            attachments: (cachedList.attachments || []).length,
        }));
        if (!treeEntry(myPath)) updateTreeEntry(myPath, cachedList).catch(() => {});
        const cachedMeta = await listCacheGet(`load-meta::${myPath}`);
        if (!stillCurrent()) return false;
        resetMetaState();
        applyMetaPayload(cachedMeta);
        renderView(cachedList);
        _lastRenderData = cachedList;
        refreshPinState();
        return true;
    }

    let renderedFromCache = await renderCached(treeEntry(myPath));

    // Load slower caches in the background — they should not hold up the first paint.
    if (!window.SyncBackend) {
        loadPinnedPaths().then(() => {
            if (!stillCurrent()) return;
            rerenderFolderBadges();
            refreshPinState();
        }).catch(() => {});
        loadTree().catch(() => {});
    }

    // SWR: paint cached list immediately so offline reloads (and slow networks)
    // show the last-known content right away. Then refresh in the background.
    // Skip for browser-fs builds — files are local, api() is the adapter's, and
    // the IDB list cache is never populated.
    if (!window.SyncBackend && !renderedFromCache) {
        const cachedList = await listCacheGet(`list::${myPath}`);
        renderedFromCache = await renderCached(cachedList);
        if (!stillCurrent()) return;
    }

    let data;
    try {
        data = await api('list', myPath);
    } catch (e) {
        setNetworkState('offline');
        inspect('init:list-error', { message: e?.message || String(e), renderedFromCache });
        const msg = e?.message || String(e);
        if (renderedFromCache) {
            setStatus('error', `Couldn’t reach the server (${msg}). Showing cached data.`);
            refreshPinState();
            return;
        }
        renderError(msg);
        return;
    }
    if (!stillCurrent()) return;
    if (handleAuth(data)) {
        // SWR may have spun up a SyncPlayer that's now firing loadBytes against
        // a 401 backend. Stop it before the auth screen takes over the DOM.
        teardownPlayer();
        return;
    }
    if (data.throttled) {
        setStatus('info', 'Nextcloud is rate-limiting this IP. First requests will be slow for a bit.');
    } else if (!data._stale && !data.error) {
        clearStatus();
    }
    setNetworkState(data._stale ? 'offline' : 'online');
    inspect('init:list-result', () => ({
        stale: !!data._stale,
        renderedFromCache,
        folders: (data.folders || []).length,
        files: (data.files || []).length,
        attachments: (data.attachments || []).length,
    }));
    if (data.error)    { if (!renderedFromCache) renderError(data.error); return; }
    if (data._stale) {
        inspect('init:stale-skip', { renderedFromCache: true });
        if (!renderedFromCache) {
            renderView(data);
            _lastRenderData = data;
        }
        refreshPinState();
        return;
    }
    await updateTreeEntry(myPath, data).catch(() => {});
    if ((data.folders || []).length) {
        scheduleTreeRefresh(myPath, renderedFromCache ? 240 : 80);
    }
    if (data.files?.length || data.attachments?.length) {
        const meta = await loadFolderMeta(myPath);
        if (!stillCurrent()) return;
        if (handleAuth(meta)) return;
        if (meta.error && !renderedFromCache) { renderError(meta.error); return; }
    } else if (!renderedFromCache) {
        resetMetaState();
    }

    if (renderedFromCache) applyFreshData(data);
    else { renderView(data); _lastRenderData = data; }
    refreshPinState();
}

// Reconcile a freshly fetched list with what's on screen. Three cases:
//   - everything matches: just refresh the meta-bound UI (description, tones).
//   - only folders changed: patch the folder UL in place, leave the player alone.
//     If the user is mid-search the patch is deferred — they'd lose their query.
//   - files/attachments changed: full re-render. Skipped while the player is
//     actively playing, since renderView destroys+recreates the SyncPlayer.
function applyFreshData(data) {
    const prev = _lastRenderData || { folders: [], files: [], attachments: [] };
    const same = (x, y) => JSON.stringify(x || []) === JSON.stringify(y || []);
    const foldersSame = same(prev.folders, data.folders);
    const filesSame   = same(prev.files,   data.files);
    const attachSame  = same(prev.attachments, data.attachments);

    if (filesSame && attachSame && foldersSame) {
        inspect('fresh:no-change', () => ({ folders: (data.folders || []).length, files: (data.files || []).length }));
        syncBaseToneUI();
        syncDescriptionUI();
        _lastRenderData = data;
        return;
    }

    if (filesSame && attachSame) {
        const nextFolders = data.folders || [];
        const hadFolders = !!(prev.folders || []).length;
        const hasFolders = !!nextFolders.length;
        const ul = $('folders');
        const inp = $('ffilter');
        if (hadFolders !== hasFolders || (!ul && hasFolders)) {
            inspect('fresh:rerender-folders', { hadFolders, hasFolders });
            const q = inp?.value || '';
            const wasFocused = inp && document.activeElement === inp;
            renderView(data);
            _lastRenderData = data;
            if (q) {
                const newInp = $('ffilter');
                if (newInp) {
                    newInp.value = q;
                    newInp.dispatchEvent(new Event('input'));
                    if (wasFocused) newInp.focus();
                }
            }
            return;
        }
        _folderState = nextFolders;
        inspect('fresh:patch-folders', { count: nextFolders.length, searching: !!inp?.value.trim() });
        if (ul) syncFolderFilterUI();
        _lastRenderData = data;
        return;
    }

    if (player?.isPlay) return; // defer; IDB is already fresh, will apply on next nav

    const inp = $('ffilter');
    const q = inp?.value || '';
    const wasFocused = inp && document.activeElement === inp;
    inspect('fresh:rerender-full', () => ({
        folders: (data.folders || []).length,
        files: (data.files || []).length,
        attachments: (data.attachments || []).length,
    }));
    renderView(data);
    _lastRenderData = data;
    if (q) {
        const newInp = $('ffilter');
        if (newInp) {
            newInp.value = q;
            newInp.dispatchEvent(new Event('input'));
            if (wasFocused) newInp.focus();
        }
    }
}

function renderError(msg) {
    clearPendingNavigation(CFG.path);
    $('root').innerHTML = `<div class="err">${escapeHtml(msg)}</div>`;
    setStatus('error', msg);
}

// Reports per-track load failures in the status banner once load() has run.
// Counted across all tracks so a partial failure ("2 of 8 unavailable") is
// visible rather than buried in console. Successful (re)load clears the banner
// if it was showing our own message.
let _lastLoadStatusKey = '';
function surfacePlayerLoadStatus(p) {
    if (!p || p.loadedFraction < 1) return;
    const failed = p.files.reduce((n, _, i) => n + (p._encoded[i] === null && !p.buffers[i] ? 1 : 0), 0);
    const key = `${p.loadError}::${failed}`;
    if (key === _lastLoadStatusKey) return;
    _lastLoadStatusKey = key;
    if (failed > 0) {
        const total = p.files.length;
        const detail = p.loadError ? ` — ${p.loadError}` : '';
        setStatus('error', `${failed} of ${total} track${total === 1 ? '' : 's'} failed to load${detail}`);
    }
}

// Top-of-page banner for failures and slow-path warnings. One slot — latest
// call wins. Dismiss with the × or by calling clearStatus(). On mobile this is
// the only feedback path (DevTools is impractical), so phrase messages so the
// reader can act on them.
function setStatus(level, msg) {
    const el = $('status-banner');
    if (!el) return;
    el.dataset.level = level === 'error' ? 'error' : 'info';
    el.innerHTML = `<span class="status-msg"></span><button type="button" class="status-close" aria-label="Dismiss">×</button>`;
    el.querySelector('.status-msg').textContent = msg;
    el.querySelector('.status-close').onclick = clearStatus;
    el.hidden = false;
    inspect('status', { level, msg });
}
function clearStatus() {
    const el = $('status-banner');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
}

// Auth-response dispatch helper. Returns true if `res` was a 401 (and renderAuth
// was called), so the caller can early-return. Use it instead of the 2-liner.
function handleAuth(res) {
    if (res?._appAuth) {
        const failed = _authFeedback === 'app';
        _authFeedback = null;
        renderAuth({ app: true, hint: res.hint, throttled: res.throttled, failed });
        return true;
    }
    if (res?._auth) {
        const failed = _authFeedback === 'share';
        _authFeedback = null;
        renderAuth({ app: false, hint: res.hint, throttled: res.throttled, failed });
        return true;
    }
    _authFeedback = null;
    return false;
}

let _authFeedback = null;

function renderAuth({ app, hint, throttled, failed }) {
    clearPendingNavigation(CFG.path);
    const title = app ? 'Access password' : 'Share password';
    const hintHtml = hint
        ? `<p style="margin:0 0 16px;color:var(--mut);font-size:13px;line-height:1.45">${escapeHtml(hint)}</p>`
        : '';
    if (throttled) {
        setStatus('info', 'Nextcloud is rate-limiting this IP after recent failed attempts — sign-in will be slow until it cools off.');
    }
    $('root').innerHTML = `<div class="setup"><div class="box">
        <h3 style="margin-top:0">🔒 ${title}</h3>
        ${hintHtml}
        <form onsubmit="return submitPw(event, ${app ? 'true' : 'false'})">
            <div class="grp${failed ? ' grp-shake' : ''}"><input id="pwin" type="password" autocomplete="current-password" autofocus required aria-invalid="${failed ? 'true' : 'false'}"></div>
            <button class="btn btn-p">Unlock</button>
        </form>
    </div></div>`;
    $('pwin')?.focus();
}

window.submitPw = (e, isApp) => {
    e.preventDefault();
    const val = $('pwin').value;
    _authFeedback = isApp ? 'app' : 'share';
    const key = isApp ? 'apw_' : 'spw_';
    if (isApp) CFG.appPw = val; else CFG.pw = val;
    writeStoredAuth(key + CFG.adapterId, val);
    init();
    return false;
};

// Render folders + player together. Either may be empty.
let _folderState = [];
// Last data passed to renderView — used by applyFreshData to diff SWR refreshes.
let _lastRenderData = null;

function sameFileEntries(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function renderView(data) {
    clearPendingNavigation(CFG.path);
    attachmentPreview.clear();
    _folderState = data.folders || [];
    const files = data.files || [];
    const attachments = data.attachments || [];
    const reusePlayer = !!(player && files.length && sameFileEntries(player.files, files));
    inspect('render', { folders: _folderState.length, files: files.length, attachments: attachments.length });
    inspect('render:player', {
        files: files.length,
        reusePlayer,
        hadPlayer: !!player,
        playerWasPlaying: !!player?.isPlay,
    });
    const foldersBlock = _folderState.length && !files.length ? `
        <div class="folders-wrap">
            <div class="filter">
                <div class="filter-box">
                    <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input id="ffilter" type="search" placeholder="Filter folders" autocomplete="off" spellcheck="false">
                </div>
            </div>
            <div class="filter-status" id="fstatus" hidden></div>
            <ul class="folders" id="folders">${renderFolderItems(_folderState)}</ul>
        </div>` : '';
    const playerMarkup = (files.length || attachments.length) ? playerHTML(files, attachments) : '';
    const empty = (!_folderState.length && !files.length && !attachments.length)
        ? `<div class="loading">Empty folder.</div>` : '';

    $('root').innerHTML = foldersBlock + playerMarkup + empty;
    document.body.classList.toggle('has-player', !!files.length);
    setHeader();
    bindDescriptionEditor();
    bindAttachmentCards(attachments);
    if (files.length) {
        if (!reusePlayer) {
            if (player) player.destroy();
            player = new SyncPlayer(files, onPlayerChange);
        }
        _trackEls = [...document.querySelectorAll('.track')];
        _trackEls.forEach(cacheTrackElements);
        cachePlayerUI();
        invalidateWaveformPaint();
        bindControls();
        observeWaveformLayouts();
        initStage(files);
        syncBaseToneUI();
        if (reusePlayer) {
            inspect('player:reuse', { files: files.length });
            onPlayerChange(player);
        } else {
            inspect('player:create', { files: files.length });
            player.load();
        }
    } else if (player) {
        player.destroy(); player = null;
        clearPlayerUICache();
        disconnectWaveformObserver();
    } else {
        clearPlayerUICache();
    }
    if (_folderState.length) bindFilter();
}

// One ResizeObserver per render — fires once layout for the .wf containers
// finishes (which in Firefox can be after the post-load _emit() ran with a
// 0-width canvas) and on every subsequent reflow. Cheaper than a window resize
// listener and catches more cases (font swap, container wrap, etc.).
let _wfObserver = null;
function disconnectWaveformObserver() {
    _wfObserver?.disconnect();
    _wfObserver = null;
}
function observeWaveformLayouts() {
    disconnectWaveformObserver();
    if (document.body.classList.contains('hide-wf')) return;
    if (typeof ResizeObserver !== 'function') return;
    _wfObserver = new ResizeObserver(() => {
        if (!player) return;
        invalidateWaveformPaint();
        onPlayerChange(player);
    });
    document.querySelectorAll('.track .wf').forEach(el => _wfObserver.observe(el));
}

function renderFolderItems(folders) {
    if (!folders.length) return '<li class="no-match">No matches</li>';
    return folders.map(f => {
        const offlineState = folderOfflineState(f.path);
        const pin = offlineState
            ? `<span class="folder-pin-badge${offlineState === 'contains' ? ' partial' : ''}" title="${offlineState === 'contains' ? 'Contains offline content' : 'Available offline'}"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg><span class="lbl">${offlineState === 'contains' ? 'Offline inside' : 'Offline'}</span></span>`
            : '';
        return `<li><a href="${dirHref(f.path)}" data-path="${escapeHtml(f.path)}">
            <div class="meta"><span class="nm">${escapeHtml(f.name)}</span></div>
            ${pin}<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </a></li>`;
    }).join('');
}

function rerenderFolderBadges() {
    const ul = $('folders');
    if (!ul) return;
    syncFolderFilterUI();
}


function setFilterStatus(msg) {
    const s = $('fstatus');
    if (!s) return;
    s.textContent = msg || '';
    s.hidden = !msg;
}

function filterScope() {
    return _tree
        ? [...new Map(
            Object.values(_tree).flatMap(e => e.folders || []).map(f => [f.path, f])
          ).values()]
        : _folderState;
}

function syncFolderFilterUI() {
    const ul = $('folders');
    if (!ul) return;
    const q = $('ffilter')?.value.trim().toLowerCase() || '';
    const found = q
        ? filterScope().filter(f => f.name.toLowerCase().includes(q))
        : _folderState;
    ul.innerHTML = renderFolderItems(found);
    setFilterStatus(q && !found.length ? 'No matches' : '');
}

function bindFilter() {
    const inp = $('ffilter');
    if (!inp) return;
    inp.oninput = syncFolderFilterUI;
    inp.focus({ preventScroll: true });
}

// Trailing punctuation that's almost always sentence punctuation, not part of the URL.
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;
function linkifyText(text) {
    let html = '', last = 0;
    for (const m of text.matchAll(URL_RE)) {
        html += escapeHtml(text.slice(last, m.index));
        const url = m[0];
        html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        last = m.index + url.length;
    }
    return html + escapeHtml(text.slice(last));
}

function descriptionHTML() {
    const text = metaDescription || '';
    // Two elements: a div renders the readonly view (so URLs become clickable links);
    // the textarea handles edit mode. CSS swaps which one is visible.
    return `<div class="descr-wrap">
        <div class="descr-view" id="descr-view">${linkifyText(text)}</div>
        <textarea class="descr-edit" id="descr-edit" rows="1" placeholder="Add a description for this folder…" maxlength="2000" readonly>${escapeHtml(text)}</textarea>
    </div>`;
}

function attachmentSectionHTML(files) {
    if (!files?.length) return '';
    return `<section class="attachments-wrap" aria-label="Images and PDFs">
        <div class="attachments-list">${files.map((file, i) => {
            return `
            <article class="attachment-chip">
                <button type="button" class="attachment-primary" data-attachment-primary="${i}" title="Open ${escapeHtml(file.name)}" aria-label="Open ${escapeHtml(file.name)}">
                    <div class="attachment-kind-wrap ${file.kind === 'pdf' ? 'is-pdf' : 'is-image'}" aria-hidden="true">
                        <span class="attachment-kind">${file.kind === 'pdf' ? 'PDF' : 'IMG'}</span>
                    </div>
                    <div class="attachment-name" title="${escapeHtml(file.name)}">${escapeHtml(shortAttachmentName(file.name))}</div>
                </button>
                ${attachmentMenuHTML(file, i)}
            </article>`;
        }).join('')}
        </div>
        <div class="attachment-inline-preview" id="attachment-inline-preview" hidden></div>
    </section>`;
}

function bindAttachmentCards(files) {
    if (!files?.length) return;
    files.forEach((file, i) => {
        document.querySelector(`[data-attachment-primary="${i}"]`)?.addEventListener('click', () => openAttachmentNewTab(file));
        document.querySelector(`[data-attachment-menu="${i}"]`)?.addEventListener('click', e => {
            e.stopPropagation();
            toggleAttachmentMenu(i);
        });
        document.querySelector(`[data-attachment-download="${i}"]`)?.addEventListener('click', () => {
            closeAllAttachmentMenus();
            downloadTrackFile(file);
        });
        document.querySelector(`[data-attachment-opentab="${i}"]`)?.addEventListener('click', () => {
            closeAllAttachmentMenus();
            openAttachmentNewTab(file);
        });
        document.querySelector(`[data-attachment-open="${i}"]`)?.addEventListener('click', () => {
            closeAllAttachmentMenus();
            attachmentPreview.openInline(file, i);
        });
        document.querySelector(`[data-attachment-fullscreen="${i}"]`)?.addEventListener('click', () => {
            closeAllAttachmentMenus();
            attachmentPreview.openOverlay(file, i);
        });
    });
}

function closeAllAttachmentMenus() {
    document.querySelectorAll('.attachment-menu-pop').forEach(pop => { pop.hidden = true; });
    document.querySelectorAll('[data-attachment-menu]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}

function toggleAttachmentMenu(i) {
    const pop = document.getElementById(`attachment-menu-${i}`);
    if (!pop) return;
    const wasOpen = !pop.hidden;
    closeAllAttachmentMenus();
    if (!wasOpen) {
        pop.hidden = false;
        document.querySelector(`[data-attachment-menu="${i}"]`)?.setAttribute('aria-expanded', 'true');
    }
}

// field-sizing:content is the modern way (Chrome 123+); JS fallback resizes
// the textarea to fit its content on browsers that don't support it yet (Firefox).
function autosizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function bindDescriptionEditor() {
    const descrEdit = $('descr-edit');
    if (!descrEdit) return;
    descrEdit.addEventListener('input', e => {
        setFolderDescription(e.target.value);
        if (!CSS.supports?.('field-sizing', 'content')) autosizeTextarea(e.target);
    });
    descrEdit.addEventListener('blur', () => flushMetaSave());
    syncDescriptionUI();
}

function trackMenuHTML(i) {
    const edit = CFG.canWrite ? `<button type="button" class="tmenu-edit" data-i="${i}" role="menuitem">
                <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.42l-2.33-2.33a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                <span>Edit</span>
            </button>` : '';
    return `<div class="track-menu-wrap">
        <button type="button" class="btn menu-trigger-btn" data-track-menu="${i}" aria-haspopup="menu" aria-expanded="false" title="More"><span class="menu-trigger-dots">⋮</span></button>
        <div class="track-menu-pop" id="tmenu-${i}" hidden role="menu">
            ${edit}<button type="button" class="tmenu-download" data-i="${i}" role="menuitem">
                <svg viewBox="0 0 24 24"><path d="M12 3v10.59l3.29-3.3 1.42 1.42L12 16.41l-4.71-4.7 1.42-1.42L12 13.59V3h0zm-7 16h14v2H5v-2z"/></svg>
                <span>Download</span>
            </button>
        </div>
    </div>`;
}

function playerHTML(files, attachments = []) {
    // Volume sliders are visually flagged with a speaker glyph so they're not confused with progress.
    const spkr = (tip) => `<svg class="vol-ic" viewBox="0 0 24 24"><title>${tip}</title><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`;
    const playerBlock = files.length ? `<div class="player">
        <div class="tracks">${files.map((f, i) => `
            <div class="track" data-i="${i}">
                <div class="row">
                    <div class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name.replace(/\.[^.]+$/, ''))}</div>
                    ${renderBaseToneControl(f.name)}
                    <div class="vol-wrap">${spkr('Click: mute · Shift+Click: solo')}<input type="range" class="vol tvol" min="${VOLUME_SLIDER_MIN}" max="${VOLUME_SLIDER_MAX}" step="1" value="${gainToSliderValue(DEFAULT_VOLUME)}" style="--vol-pct:${gainToSliderValue(DEFAULT_VOLUME)}%" title="Track volume · Shift+Drag: set all others"></div>
                    <span class="vol-num" aria-hidden="true">${gainToSliderValue(DEFAULT_VOLUME)}</span>
                    ${trackMenuHTML(i)}
                </div>
                <div class="wf" title="Click to seek">
                    <canvas class="wf-base"></canvas>
                    <div class="wf-played"><canvas class="wf-overlay"></canvas></div>
                </div>
            </div>`).join('')}</div>
        ${renderStage(files)}
    </div>
    <div class="master" id="master">
        <div class="seek-bar" id="seek"><i></i><b></b></div>
        <div class="master-inner">
            <button class="btn btn-play" id="play" disabled title="Space"><svg class="icon" viewBox="0 0 24 24" id="play-ic"><path d="M8 5v14l11-7z"/></svg></button>
            <button class="btn" id="back5" disabled title="←"><svg class="icon" viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>
            <button class="btn" id="fwd5" disabled title="→"><svg class="icon" viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg></button>
            <button class="btn" id="rep" title="Repeat (r)"><svg class="icon" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg></button>
            <button type="button" class="btn bt-action" id="bt-cascade" hidden>cascade</button>
            <span class="t" id="time">0:00 / 0:00</span>
            <span class="player-startup" id="player-startup" hidden aria-live="polite">Preparing audio…</span>
            <span class="player-tools-status" id="bt-status"></span>
            <div class="vol-wrap master-vol">${spkr('Mute all')}<input type="range" class="vol" id="mvol" min="${VOLUME_SLIDER_MIN}" max="${VOLUME_SLIDER_MAX}" step="1" value="${gainToSliderValue(DEFAULT_VOLUME)}" style="--vol-pct:${gainToSliderValue(DEFAULT_VOLUME)}%" title="Set all track volumes"><span class="vol-state" id="mvol-state" aria-hidden="true">avg</span></div>
        </div>
    </div>` : '';
    // .play-cols is display:contents by default — only becomes a flex row when
    // the inline preview is open AND the viewport is wide enough (see CSS).
    return `${descriptionHTML()}<div class="play-cols">${attachmentSectionHTML(attachments)}${playerBlock}</div>`;
}

function onPlayerChange(p) {
    const ui = _ui;
    if (!ui.seek) return; // user navigated away
    surfacePlayerLoadStatus(p);
    const colors = getWaveformColors();
    const starting = !!p._starting;
    const displayVolumes = [...p.volumes];
    const allMuted = displayVolumes.every(v => v === 0);
    const allSameVolume = displayVolumes.every(v => v === displayVolumes[0]);
    const averageVolume = displayVolumes.reduce((sum, v) => sum + v, 0) / displayVolumes.length;
    const masterDisplayVolume = allSameVolume ? displayVolumes[0] : averageVolume;
    const averagePct = Math.round(averageVolume * 100);
    const masterPct = Math.round(masterDisplayVolume * 100);
    const loading = p.loadedFraction < 1;
    const hasProgress = p.fetchedFraction > 0 || p.loadedFraction > 0;
    // Show fetch progress as early visual signal while decode hasn't started yet
    const fillFrac = p.loadedFraction > 0 ? p.loadedFraction : p.fetchedFraction;
    ui.loadFill.style.width = (fillFrac * 100) + '%';
    ui.loadFill.classList.toggle('indeterminate', loading && !hasProgress);
    ui.playFill.style.width = p.duration > 0
        ? (Math.min(1, p.currentTime / p.duration) * 100) + '%' : '0%';
    ui.seek.classList.toggle('done', !loading);
    ui.seek.classList.toggle('is-loading', loading);
    ui.play.disabled = p.loadedFraction < 1;
    ui.back5.disabled = ui.fwd5.disabled = p.loadedFraction < 1 || starting;
    ui.play.classList.toggle('is-loading', starting);
    ui.play.setAttribute('aria-busy', starting ? 'true' : 'false');
    if (ui.startup) ui.startup.hidden = !starting;
    const timeText = `${fmt(p.currentTime)} / ${fmt(p.duration)}`;
    if (ui.time.textContent !== timeText) ui.time.textContent = timeText;
    ui.playIc.innerHTML = starting
        ? '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="30 18" transform="rotate(-90 12 12)"/>'
        : p.isPlay
            ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
            : '<path d="M8 5v14l11-7z"/>';
    ui.playIc.classList.toggle('icon-spin', starting);
    ui.rep.classList.toggle('on', p.repeat);
    ui.masterWrap.classList.toggle('muted', allMuted);
    ui.masterWrap.classList.toggle('mixed', !allMuted && !allSameVolume);
    ui.mvol.title = allMuted
        ? 'Set all track volumes (all muted)'
        : allSameVolume
            ? 'Set all track volumes'
            : `Set all track volumes - current average ${averagePct}% - drag to unify`;
    ui.mvol.setAttribute('aria-valuetext', allMuted
        ? 'all tracks muted'
        : allSameVolume
            ? `${masterPct} percent`
            : `track volumes vary, average ${averagePct} percent`);
    setSliderVisual(ui.mvol, masterPct);
    if (document.activeElement !== ui.mvol) ui.mvol.value = gainToSliderValue(masterDisplayVolume);
    const mvolState = $('mvol-state');
    if (mvolState) mvolState.textContent = !allMuted && !allSameVolume ? 'avg' : '';

    const played01 = p.duration ? p.currentTime / p.duration : 0;
    const fullRepaint = _wfFullRepaint;
    _wfFullRepaint = false;
    const wfHidden = document.body.classList.contains('hide-wf');
    let needsRetry = false;
    _trackEls.forEach((tr, i) => {
        const raw = p.volumes[i] ?? 0;
        const pct = Math.round(raw * 100);
        const isMuted = raw === 0;
        tr.classList.toggle('muted', isMuted);
        const slider = tr._tvol;
        setSliderVisual(slider, pct);
        if (slider && document.activeElement !== slider) slider.value = gainToSliderValue(raw);
        if (tr._volNum) tr._volNum.textContent = pct;
        const stageTrack = document.querySelector(`.stage-track[data-i="${i}"]`);
        if (stageTrack) stageTrack.style.setProperty('--stage-vol', stageTrackVisualLevel(raw).toFixed(3));
        if (wfHidden) return;
        const peaks = p.peaks[i];
        if (!peaks) return;
        if (fullRepaint || tr._paintedPeaks !== peaks) {
            if (paintTrackWaveform(tr, peaks, colors)) tr._paintedPeaks = peaks;
            else needsRetry = true;
        }
        updateTrackProgress(tr, played01);
    });

    // Limit retries to prevent infinite loops if elements never get a width.
    if (needsRetry) {
        _onPlayerChangeRetries = (_onPlayerChangeRetries || 0) + 1;
        if (_onPlayerChangeRetries < 10) {
            requestAnimationFrame(() => { if (player) onPlayerChange(player); });
        }
    } else {
        _onPlayerChangeRetries = 0;
    }
}
let _onPlayerChangeRetries = 0;

function bindControls() {
    // First touch/click anywhere on the page → unlock AudioContext on iOS and
    // start decoding early so play is instant. capture:true fires before the
    // play button's own pointerdown (which calls primePlayback as a fallback).
    document.addEventListener('pointerdown', () => {
        if (player) player.primeOnGesture();
    }, { once: true, passive: true, capture: true });

    // Blur after click so a follow-up Space press goes through the body keydown
    // handler (single toggle) rather than re-activating the still-focused button
    // (which would double-toggle with the body handler).
    $('play').addEventListener('pointerdown', () => {
        if (player.loadedFraction < 1) return;
        player.primePlayback();
    }, { passive: true });
    $('play').onclick = e => { player.toggle(); e.currentTarget.blur(); };
    $('back5').onclick = () => player.seek(-5);
    $('fwd5').onclick = () => player.seek(5);
    $('rep').onclick = () => player.toggleRepeat();
    $('seek').addEventListener('click', e => {
        if (player.loadedFraction < 1) return;
        const r = e.currentTarget.getBoundingClientRect();
        player.jumpTo((e.clientX - r.left) / r.width * player.duration);
    });
    $('mvol').addEventListener('pointerdown', () => {
        if (document.activeElement?.classList?.contains('tvol')) document.activeElement.blur();
    });
    $('mvol').oninput = e => {
        const value = e.target.value;
        deactivateStageForManualVolume();
        player.setAllVolumes(sliderToGainValue(value));
        document.querySelectorAll('.tvol').forEach(slider => slider.value = value);
    };
    $('bt-cascade')?.addEventListener('click', runCascade);

    document.querySelectorAll('.track').forEach((tr, i) => {
        const name = player.files[i].name;
        const tvol = tr.querySelector('.tvol');
        // Shift-drag a track slider: pull all OTHER tracks to this value; this track stays put.
        // Hijack the gesture before the native slider grabs it — preventDefault on pointerdown stops
        // the thumb from tracking the cursor, then we drive the others ourselves from clientX.
        tvol.addEventListener('pointerdown', e => {
            if (!e.shiftKey) return;
            e.preventDefault();
            const rect = tvol.getBoundingClientRect();
            const sibSliders = [...document.querySelectorAll('.tvol')];
            const apply = cx => {
                const t = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
                const raw = Number(tvol.min) + t * (Number(tvol.max) - Number(tvol.min));
                const v = sliderToGainValue(raw);
                deactivateStageForManualVolume();
                // setVolume + force-sync visual: the activeElement guard in onPlayerChange
                // skips whichever slider held focus before this shift-drag started.
                player.volumes.forEach((_, k) => {
                    if (k !== i) { player.setVolume(k, v); sibSliders[k].value = gainToSliderValue(v); }
                });
            };
            apply(e.clientX);
            const onMove = ev => apply(ev.clientX);
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
        tvol.oninput = e => {
            deactivateStageForManualVolume();
            player.setVolume(i, sliderToGainValue(e.target.value));
        };
        tr.querySelector('.vol-wrap .vol-ic').onclick = e => {
            deactivateStageForManualVolume();
            e.shiftKey ? player.soloTrack(i) : player.toggleTrackMute(i);
        };
        tr.querySelector('.bt-badge')?.addEventListener('click', () => playTrackTone(name));
        tr.querySelector('.bt-down')?.addEventListener('click', () => setTrackTone(name, shiftHalftone(toneForFile(name)?.freq ?? 440, -1), true));
        tr.querySelector('.bt-up')?.addEventListener('click', () => setTrackTone(name, shiftHalftone(toneForFile(name)?.freq ?? 440, 1), true));
        tr.querySelector('.bt-clear')?.addEventListener('click', () => clearTrackTone(name));
        tr.querySelector('.bt-input')?.addEventListener('change', e => {
            const val = e.target.value.trim();
            if (!val) { clearTrackTone(name); return; }
            const freq = noteToFreq(val);
            if (!Number.isFinite(freq)) {
                e.target.value = toneForFile(name)?.note || '';
                setBaseToneStatus(`Invalid base tone for ${name}`, true);
                syncBaseToneUI();
                return;
            }
            setTrackTone(name, freq, true);
        });
        tr.querySelector('.wf').onclick = e => {
            const r = e.currentTarget.getBoundingClientRect();
            player.jumpTo((e.clientX - r.left) / r.width * player.duration);
        };
        tr.querySelector(`[data-track-menu="${i}"]`)?.addEventListener('click', e => {
            e.stopPropagation();
            toggleTrackMenu(i);
        });
        tr.querySelector('.tmenu-download')?.addEventListener('click', () => {
            closeAllTrackMenus();
            downloadTrackFile(player.files[i]);
        });
        tr.querySelector('.tmenu-edit')?.addEventListener('click', () => {
            closeAllTrackMenus();
            setEditMode(true);
            tr.querySelector('.bt-input')?.focus();
        });
    });
    document.querySelector('.master-inner .vol-ic').onclick = () => {
        deactivateStageForManualVolume();
        player.toggleMute();
    };

    document.body.onkeydown = e => {
        if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
        // Auto-repeat: holding a key would otherwise fire toggle/seek dozens of
        // times per second. Ignore repeats for all shortcuts here.
        if (e.repeat) return;
        if (e.key === '?')          { toggleHelp(); e.preventDefault(); return; }
        if (e.key === 'Escape')     { setHelp(false); return; }
        if (!player) return;
        // Space on a focused button triggers its native activation (click on
        // keyup). If we also toggled here, the two would cancel — leaving play
        // state unchanged. Skip Space when a button is the keydown target and
        // let the button's onclick do the single toggle.
        if (e.key === ' ' && e.target.tagName !== 'BUTTON') { player.toggle(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft')  { player.seek(e.shiftKey ? -10 : -5); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { player.seek(e.shiftKey ? 10 : 5);  e.preventDefault(); }
        else if (e.key === 'm')          { deactivateStageForManualVolume(); player.toggleMute(); }
        else if (e.key === 'r')          player.toggleRepeat();
    };

    window.addEventListener('resize', () => {
        if (!player) return;
        invalidateWaveformPaint();
        onPlayerChange(player);
    });
    syncBaseToneUI();
}

initTheme();
initShowWaveforms();
initStageEnabled();
initInspect();
bindMenu();
init();
