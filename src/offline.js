// ## js-offline — opt-in "Available offline" pin, eager fetch + IDB audio cache
// Opt-in offline cache. Pinning a folder eagerly fetches every audio file +
// attachment via loadBytes and stores the bytes in the AUDIO_STORE, keyed by
// `${path}::${lm}`. SyncPlayer.load checks that store first, so on later
// offline visits the bytes come straight from IDB even if the SW Cache layer
// got evicted. Listings + meta are cached passively by api() — pinning just
// ensures the audio is there too.
//
// State for the current folder lives in the `pinState` observable store so the
// menu UI reflects caching progress without re-querying IDB on every tick. A
// single subscriber (syncOfflineUI) re-syncs the DOM, so callers just mutate
// via pinState.set() and never hand-call syncOfflineUI() after a flag change.
import { CFG, loadBytes, inspect } from './config.js';
import { getPin, setPin, delPin, audioCacheGet, audioCachePut, audioCacheDel, audioKey, loadPinnedPaths } from './cache.js';
import { getTree, fetchTree } from './tree.js';
import { createStore } from './store.js';
import { collectPinItems, pinItemRecords } from './offline-math.js';
import { getLastRenderData, rerenderFolderBadges } from './ui.js';

const pinState = createStore({ pinned: false, caching: false, done: 0, total: 0, error: '' });
export const getPinState = () => pinState.get();

export async function refreshPinState() {
    const pin = await getPin(CFG.path);
    pinState.set({ pinned: !!pin, caching: false, done: 0, total: 0, error: '' });
    // Button eligibility depends on render data (getLastRenderData()) that isn't
    // in the store, so re-sync explicitly on this render-time hook even when the
    // pin flags didn't change (navigating between two never-pinned folders).
    syncOfflineUI();
}

function offlineCandidates() {
    const data = getLastRenderData() || {};
    return [...(data.files || []), ...(data.attachments || [])];
}

export async function pinCurrentFolder() {
    if (window.SyncBackend) return; // single-file build: files are already local
    const directItems = offlineCandidates();
    const directFolders = getLastRenderData()?.folders || [];
    if (!directItems.length && !directFolders.length) return;
    // Ask the browser to keep our storage around — without this, IDB can be
    // evicted under storage pressure, which would defeat the point of pinning.
    try { await navigator.storage?.persist?.(); } catch (_) {}

    // fetchTree crawls all subfolders and writes each listing to IDB via api()
    // side-effects — making every folder navigable offline.
    pinState.set({ pinned: true, caching: true, done: 0, total: 0, error: '' });

    if (!getTree()) await fetchTree(CFG.path || '/', Infinity).catch(() => {});

    const tree = getTree();
    const allItems = tree
        ? collectPinItems(tree, CFG.path)
        : [...directItems]; // fetchTree failed; fall back to direct items only

    if (!allItems.length) { pinState.set({ caching: false }); return; }

    pinState.set({ total: allItems.length });
    // Persist the pin marker first, so a reload mid-caching still shows the
    // folder as pinned (resuming would happen on a future visit).
    await setPin(CFG.path, { pinnedAt: Date.now(), items: pinItemRecords(allItems) });
    for (const f of allItems) {
        const key = audioKey(f);
        try {
            let bytes = await audioCacheGet(key);
            if (!bytes) bytes = await loadBytes(f.path);
            await audioCachePut(key, bytes);
        } catch (e) {
            pinState.set({ error: e?.message || String(e) });
        }
        pinState.set(s => ({ done: s.done + 1 }));
    }
    pinState.set({ caching: false });
    await loadPinnedPaths();
    rerenderFolderBadges();
}

export async function unpinCurrentFolder() {
    const pin = await getPin(CFG.path);
    if (!pin) return;
    await delPin(CFG.path);
    for (const f of pin.items || []) {
        await audioCacheDel(audioKey(f));
    }
    pinState.set({ pinned: false, caching: false, done: 0, total: 0, error: '' });
    await loadPinnedPaths();
    rerenderFolderBadges();
}

export function syncOfflineUI() {
    const { pinned, caching, done, total, error } = pinState.get();
    const btn = document.getElementById('menu-offline');
    const info = document.getElementById('menu-offline-info');
    if (!btn) return;
    // Single-file/browser-fs build serves files from local disk — caching them
    // again would be pure overhead, so the toggle is meaningless there.
    // Show for folder-only views too: pin will recurse into sub-folders to find audio.
    const eligible = !window.SyncBackend && (offlineCandidates().length > 0 || (getLastRenderData()?.folders?.length > 0));
    btn.hidden = !eligible;
    if (info) info.hidden = !eligible;
    if (!eligible) return;
    btn.classList.toggle('on', pinned || caching);
    btn.setAttribute('aria-checked', String(pinned));
    btn.disabled = caching;
    const lbl = btn.querySelector('.lbl');
    if (lbl) {
        if (caching) {
            lbl.textContent = total > 0 ? `Caching ${done} / ${total}…` : 'Preparing…';
        } else if (pinned) {
            lbl.textContent = 'Available offline';
        } else {
            lbl.textContent = 'Make available offline';
        }
    }
    if (info) {
        if (error) info.textContent = 'Some files failed: ' + error;
        else if (pinned) info.textContent = 'Audio + waveforms stored in your browser. Tap to remove.';
        else info.textContent = 'Download all audio in this folder for offline playback.';
    }
}

// Single subscriber: every pinState mutation re-syncs the menu automatically.
pinState.subscribe(syncOfflineUI);
