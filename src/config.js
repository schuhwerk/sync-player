// ## js-config — CFG, api/loadBytes dispatch, navigate, SW registration

// Populated by cache.js after it evaluates — avoids circular import at eval time
// (cache.js needs CFG/IS_MOBILE at eval time, so config.js must evaluate first).
let _listCachePut = async () => {};
let _listCacheGet = async () => null;
export function _registerListCache(put, get) { _listCachePut = put; _listCacheGet = get; }

export const CFG = window.CFG;
CFG.canWrite = !!CFG.canWrite;

export function readStoredAuth(key) {
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

export function writeStoredAuth(key, val) {
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
export const IS_MOBILE = (() => {
    try { return matchMedia('(hover: none) and (pointer: coarse)').matches; }
    catch (_) { return false; }
})();
export const MOBILE_PREDECODE_LIMIT = (() => {
    if (!IS_MOBILE) return 0;
    const mem = Number(navigator.deviceMemory || 0);
    if (mem >= 8) return 24 * 1024 * 1024;
    if (mem >= 4) return 12 * 1024 * 1024;
    if (mem > 0) return 0;
    return 8 * 1024 * 1024;
})();
export const DESKTOP_DECODE_CONCURRENCY = (() => {
    if (IS_MOBILE) return 1;
    const cores = Number(navigator.hardwareConcurrency || 0);
    if (cores >= 16) return 4;
    if (cores >= 8) return 3;
    return 2;
})();
export const VOLUME_SLIDER_MIN = 0;
export const VOLUME_SLIDER_MAX = 100;
export const DEFAULT_VOLUME = 0.5;
export const VOLUME_RAMP_SECONDS = 0.012;
export const gainToSliderValue = v => Math.max(VOLUME_SLIDER_MIN, Math.min(VOLUME_SLIDER_MAX, Math.round(v * VOLUME_SLIDER_MAX)));
export const sliderToGainValue = value => {
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

export function searchParams() {
    return new URLSearchParams(location.search);
}

export function pathFromLocation() {
    return searchParams().get('path') || '/';
}

function hasInspectQuery() {
    return searchParams().has('inspect');
}

CFG.path = pathFromLocation() || CFG.path || '/';

export const $ = id => document.getElementById(id);
export const fmt = s => { s = Math.max(0, s|0); return `${(s/60)|0}:${String(s%60).padStart(2,'0')}`; };
export const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Natural, case-insensitive name order — mirrors the PHP `strnatcasecmp($a['name'],…)`
// the list endpoints use, so filter/search results match the folder listing's order.
export const compareFolderName = (a, b) =>
    (a?.name || '').localeCompare(b?.name || '', undefined, { numeric: true, sensitivity: 'base' });

export function syncNetworkIndicator() {
    const el = $('net-ind');
    if (!el) return;
    const offline = _networkState !== 'online';
    el.hidden = !offline;
    el.title = offline ? 'Showing cached data while offline' : '';
}

export function setNetworkState(state) {
    _networkState = state === 'online' ? 'online' : 'offline';
    syncNetworkIndicator();
    inspect('network', { state: _networkState });
}

export function inspect(type, detail) {
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

export function nextInspectId(prefix) {
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

export function syncInspectUI() {
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

export function setInspectEnabled(on) {
    _inspectEnabled = !!on;
    try { localStorage.setItem(INSPECT_KEY, _inspectEnabled ? '1' : '0'); } catch(e) {}
    syncInspectUI();
    inspect('inspect', { enabled: _inspectEnabled });
}

export function initInspect() {
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
export function qs(mode, path, extra) {
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

function apiCacheKey(mode, path, extra) {
    if (mode === 'list' || mode === 'load-meta') return `${mode}::${path}`;
    if (mode === 'search') {
        const q = (extra?.q || '').trim();
        return q ? `search::${path}::${q}` : null;
    }
    return null;
}

const backendApi = window.SyncBackend?.api || null;
export const api = async (mode, path, extra) => {
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
        if (cacheKey && !data.error && !data._auth && !data._appAuth) _listCachePut(cacheKey, data);
        if (data.error && cacheKey) {
            const cached = await _listCacheGet(cacheKey);
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
            const cached = await _listCacheGet(cacheKey);
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

export async function fetchFreshList(path) {
    const reqId = nextInspectId('tree-list');
    inspect('tree:list:start', { reqId, path });
    const r = await fetch('?' + qs('list', path));
    if (r.status === 401) {
        const auth = await parseAuth(r);
        inspect('tree:list:auth', { reqId, path, throttled: !!auth.throttled, app: !!auth._appAuth });
        return auth;
    }
    const data = await r.json();
    if (!data.error && !data._auth && !data._appAuth) _listCachePut(`list::${path}`, data);
    inspect('tree:list:done', () => ({ reqId, path, status: r.status, ...inspectResultSummary(data) }));
    return data;
}

const backendApiPost = window.SyncBackend?.apiPost || null;
export const apiPost = async (mode, path, body) => {
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
export const loadBytes = async path => {
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

export function fileHref(path, download = false) {
    if (window.SyncBackend) return '#';
    return '?' + qs('fetch', path, download ? { download: '1' } : null);
}

export const dirHref = path => '?' + new URLSearchParams({ path });

export function currentCloudUrl() {
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

export function syncPendingFolderLink() {
    document.querySelectorAll('#folders a.is-pending').forEach(a => a.classList.remove('is-pending'));
    if (!_pendingNavPath) return;
    document.querySelectorAll('#folders a[data-path]').forEach(a => {
        a.classList.toggle('is-pending', a.dataset.path === _pendingNavPath);
    });
}

export function setPendingNavigation(path) {
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

export function clearPendingNavigation(path = null) {
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

if ('serviceWorker' in navigator && location.protocol !== 'file:' && window.isSecureContext) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register(new URL('sw.js', location.href)).catch(() => {});
    }, { once: true });
}
window.addEventListener('online', () => setNetworkState('online'));
window.addEventListener('offline', () => setNetworkState('offline'));
