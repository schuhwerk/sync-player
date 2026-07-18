// ## js-ui — init/SWR, renderView, controls, keyboard
import { logger } from './log.js';
const log = logger('ui');
log.debug('module eval start', () => ({ url: import.meta.url }));
import { CFG, IS_MOBILE, $, fmt, escapeHtml, inspect, nextInspectId, api, apiPost, loadBytes,
  fileHref, dirHref, currentCloudUrl, setPendingNavigation, clearPendingNavigation,
  syncPendingFolderLink, searchParams, pathFromLocation, setInspectEnabled, initInspect,
  syncInspectUI, setNetworkState, syncNetworkIndicator, gainToSliderValue, sliderToGainValue,
  VOLUME_SLIDER_MIN, VOLUME_SLIDER_MAX, DEFAULT_VOLUME, writeStoredAuth, compareFolderName } from './config.js';
import { folderOfflineState, loadPinnedPaths, listCacheGet } from './cache.js';
import { loadTree, updateTreeEntry, treeEntry,
  fetchTree, getTree, loadTreeFromLocalStorageSync, mergeTreeEntries, subscribeTree } from './tree.js';
import { SyncPlayer, player, setPlayer } from './player.js';
import { invalidateWaveformPaint, takeWfFullRepaint, paintTrackWaveform, updateTrackProgress,
  waveformColors, getWaveformColors } from './waveform.js';
import { baseTones, metaDescription, baseToneDirty, baseToneSaving, baseToneStatus,
  baseToneStatusError, baseToneVersion, baseToneSavedVersion, metaEditMode, metaVersions,
  toneForFile, loadFolderMeta, syncBaseToneUI, serializeMeta, clearMetaSaveTimer, setEditMode,
  noteToFreq, freqToNote, shiftHalftone, playTone, runCascade, setBaseToneStatus,
  clearToneRun, renderBaseToneControl, resetMetaState, applyMetaPayload, setFolderDescription,
  playTrackTone, setTrackTone, clearTrackTone, flushMetaSave,
  setBaseToneDirty, initMeta } from './basetones.js';
import { getPinState, refreshPinState, pinCurrentFolder, unpinCurrentFolder } from './offline.js';
import { applyStageEnabled, initStage, initStageEnabled,
  deactivateStageForManualVolume, stageTrackVisualLevel, renderStage } from './stage.js';
import { attachmentPreview, attachmentSectionHTML, bindAttachmentCards,
  closeAllAttachmentMenus, downloadTrackFile } from './attachments.js';

// Keep folder navigation in-app for both builds so cached data stays usable offline
// and we don't depend on reloading the shell + app.js for each folder click.
// Fire-and-forget save so unsaved edits survive navigation.
// Called before CFG.path changes so the right path is captured.
export function flushBeforeNavigate() {
    // bt-input commits on `change` (blur), not `input` — blur it first so the
    // change event fires and marks dirty before we snapshot.
    const el = document.activeElement;
    if (el?.classList.contains('bt-input')) el.blur();
    if (!baseToneDirty || !CFG.canWrite || baseToneSaving) return;
    clearMetaSaveTimer();
    setBaseToneDirty(false);
    apiPost('save-meta', CFG.path, serializeMeta()).catch(() => {});
}

export function navigate(newPath) {
    newPath = newPath || '/';
    if (newPath === CFG.path) return;
    flushBeforeNavigate();
    inspect('navigate', { from: CFG.path, to: newPath });
    const params = searchParams();
    params.set('path', newPath);
    history.pushState(null, '', '?' + params.toString());
    CFG.path = newPath;
    setHeader();
    setPendingNavigation(newPath);
    init();
}

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
    setPlayer(null);
    clearPlayerUICache();
    disconnectWaveformObserver();
    _lastLoadStatusKey = '';
}

export function setHeader() {
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
    flushBeforeNavigate();
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
export function setSaveIndicator(state) {
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
    if (inspectBtn) inspectBtn.onclick = () => setInspectEnabled(inspectBtn.getAttribute('aria-checked') !== 'true');
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

export async function init() {
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

    if (!window.SyncBackend && !getTree()) mergeTreeEntries(loadTreeFromLocalStorageSync());

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
            setStatus('error', `Couldn't reach the server (${msg}). Showing cached data.`);
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
        if (!renderedFromCache) renderView(data);
        refreshPinState();
        return;
    }
    await updateTreeEntry(myPath, data).catch(() => {});
    if (data.files?.length || data.attachments?.length) {
        const meta = await loadFolderMeta(myPath);
        if (!stillCurrent()) return;
        if (handleAuth(meta)) return;
        if (meta.error && !renderedFromCache) { renderError(meta.error); return; }
    } else if (!renderedFromCache) {
        resetMetaState();
    }

    if (renderedFromCache) applyFreshData(data);
    else renderView(data);
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
        // Update the snapshot first so syncFolderFilterUI reads the new folders.
        _lastRenderData = data;
        inspect('fresh:patch-folders', { count: nextFolders.length, searching: !!inp?.value.trim() });
        if (ul) syncFolderFilterUI();
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
export function handleAuth(res) {
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
// Last data passed to renderView (set by renderView itself): the snapshot
// applyFreshData diffs SWR refreshes against, and the folder list that
// syncFolderFilterUI/filterScope read. No separate _folderState — folders are
// always _lastRenderData.folders.
let _lastRenderData = null;
export const getLastRenderData = () => _lastRenderData;

function sameFileEntries(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
}

export function renderView(data) {
    clearPendingNavigation(CFG.path);
    attachmentPreview.clear();
    _lastRenderData = data;
    const folders = data.folders || [];
    const files = data.files || [];
    const attachments = data.attachments || [];
    const reusePlayer = !!(player && files.length && sameFileEntries(player.files, files));
    inspect('render', { folders: folders.length, files: files.length, attachments: attachments.length });
    inspect('render:player', {
        files: files.length,
        reusePlayer,
        hadPlayer: !!player,
        playerWasPlaying: !!player?.isPlay,
    });
    const foldersBlock = folders.length && !files.length ? `
        <div class="folders-wrap">
            <div class="filter">
                <div class="filter-box">
                    <svg class="search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                    <input id="ffilter" type="search" placeholder="Filter folders" autocomplete="off" spellcheck="false">
                </div>
            </div>
            <div class="filter-status" id="fstatus" hidden></div>
            <ul class="folders" id="folders">${renderFolderItems(folders)}</ul>
        </div>` : '';
    const playerMarkup = (files.length || attachments.length) ? playerHTML(files, attachments) : '';
    const empty = (!folders.length && !files.length && !attachments.length)
        ? `<div class="loading">Empty folder.</div>` : '';

    $('root').innerHTML = foldersBlock + playerMarkup + empty;
    document.body.classList.toggle('has-player', !!files.length);
    setHeader();
    bindDescriptionEditor();
    bindAttachmentCards(attachments);
    if (files.length) {
        if (!reusePlayer) {
            if (player) player.destroy();
            setPlayer(new SyncPlayer(files, onPlayerChange));
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
        player.destroy(); setPlayer(null);
        clearPlayerUICache();
        disconnectWaveformObserver();
    } else {
        clearPlayerUICache();
    }
    if (folders.length) bindFilter();
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

export function rerenderFolderBadges() {
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
    return getTree()
        ? [...new Map(
            Object.values(getTree()).flatMap(e => e.folders || []).map(f => [f.path, f])
          ).values()]
        : (_lastRenderData?.folders || []);
}

// Lazy recursive search. We no longer crawl the subtree on navigation (it fired
// one PROPFIND per subfolder and timed out big folders). Instead the filter
// matches whatever's already in the tree — current folder + previously visited —
// instantly, and fires ONE server-side recursive search (the adapter's single
// Depth:infinity round-trip) scoped to the current path, only when the user types.
// `key` = `${path}::${q}`; results are reused while that pair is current, and api()
// caches them under the same key for offline reuse.
let _remoteSearch = { key: '', folders: [] };
let _remoteSearchTimer = 0;
let _remoteSearchToken = 0;
const remoteSearchKey = q => `${CFG.path}::${q}`;

function scheduleRemoteFolderSearch(q) {
    const key = remoteSearchKey(q);
    if (_remoteSearch.key === key) return; // results already in hand
    clearTimeout(_remoteSearchTimer);
    _remoteSearchTimer = setTimeout(() => runRemoteFolderSearch(q, key), 300);
}

async function runRemoteFolderSearch(q, key) {
    const token = ++_remoteSearchToken;
    let data;
    try { data = await api('search', CFG.path, { q }); }
    catch (_) { return; } // network error: keep the local-only matches on screen
    if (token !== _remoteSearchToken) return; // a newer query superseded this one
    // Share disabled Depth:infinity (403/405), auth, or upstream error → stay local-only.
    if (!data || data.error || data._auth || data._appAuth) return;
    _remoteSearch = { key, folders: Array.isArray(data.folders) ? data.folders : [] };
    const live = ($('ffilter')?.value.trim().toLowerCase() || '');
    if (remoteSearchKey(live) === key) syncFolderFilterUI();
}

export function syncFolderFilterUI() {
    const ul = $('folders');
    if (!ul) return;
    const q = $('ffilter')?.value.trim().toLowerCase() || '';
    if (!q) {
        ul.innerHTML = renderFolderItems(_lastRenderData?.folders || []);
        setFilterStatus('');
        return;
    }
    const local = filterScope().filter(f => f.name.toLowerCase().includes(q));
    const haveRemote = _remoteSearch.key === remoteSearchKey(q);
    if (!haveRemote) scheduleRemoteFolderSearch(q);
    // Sort the same way whether or not remote results are in yet, so folders
    // don't reshuffle when the search lands — matches the listing's name order.
    const found = [...new Map(
        [...local, ...(haveRemote ? _remoteSearch.folders : [])].map(f => [f.path, f])
    ).values()].sort(compareFolderName);
    ul.innerHTML = renderFolderItems(found);
    setFilterStatus(found.length ? '' : (haveRemote ? 'No matches' : 'Searching…'));
}

function bindFilter() {
    const inp = $('ffilter');
    if (!inp) return;
    inp.oninput = syncFolderFilterUI;
    inp.focus({ preventScroll: true });
}

// Trailing punctuation that's almost always sentence punctuation, not part of the URL.
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;
export function linkifyText(text) {
    let html = '', last = 0;
    for (const m of text.matchAll(URL_RE)) {
        html += escapeHtml(text.slice(last, m.index));
        const url = m[0];
        html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        last = m.index + url.length;
    }
    return html + escapeHtml(text.slice(last));
}

export function syncDescriptionUI() {
    const view = $('descr-view');
    const edit = $('descr-edit');
    if (!view && !edit) return;
    const text = metaDescription || '';
    if (view) view.innerHTML = linkifyText(text);
    if (edit && document.activeElement !== edit) edit.value = text;
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

// field-sizing:content is the modern way (Chrome 123+); JS fallback resizes
// the textarea to fit its content on browsers that don't support it yet (Firefox).
export function autosizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function bindDescriptionEditor() {
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

export function onPlayerChange(p) {
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
    ui.seek.classList.toggle('preparing', starting);
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
    const fullRepaint = takeWfFullRepaint();
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

function setSliderVisual(slider, pct) {
    if (!slider) return;
    const n = Number(pct);
    const clamped = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
    slider.style.setProperty('--vol-pct', `${clamped}%`);
}

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

async function toggleCurrentPin() {
    const { caching, pinned } = getPinState();
    if (caching) return;
    if (pinned) {
        const ok = window.confirm('Remove this folder\'s offline copy?\n\nThe audio files will be re-downloaded on the next visit.');
        if (!ok) return;
        await unpinCurrentFolder();
    } else {
        await pinCurrentFolder();
    }
}

export function main() {
    log.debug('main() called', () => ({ url: import.meta.url }));
    initTheme();
    initShowWaveforms();
    initStageEnabled();
    initInspect();
    // One subscriber re-syncs the folder filter whenever the tree changes
    // (e.g. the background crawl widens the searchable scope). Callers mutate
    // the tree via merge/update and never hand-call syncFolderFilterUI().
    subscribeTree(syncFolderFilterUI);
    bindMenu();
    if (CFG.buildVersion) { const el = $('menu-version'); if (el) el.textContent = 'v' + CFG.buildVersion; }
    init();
}
