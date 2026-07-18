// ## js-tree — preload full folder tree from server; flat map used by filter + pin
import { CFG, inspect, fetchFreshList } from './config.js';
import { listCachePut, listCacheGet, TREE_STORAGE_KEY, TREE_CRAWL_MAX_DEPTH } from './cache.js';
import { createStore } from './store.js';
import { logger } from './log.js';

const log = logger('tree');
log.debug('module eval start', () => ({ url: import.meta.url }));

// Observable tree slice: path → {folders, files, attachments}. A single
// subscriber (ui.js wires `subscribeTree(syncFolderFilterUI)` once) re-syncs the
// folder filter whenever the tree changes — callers just mutate and never
// hand-call syncFolderFilterUI(). Keeping the subscriber out of this module also
// breaks the old tree↔ui import cycle.
const treeStore = createStore({ tree: null });
export function getTree() { return treeStore.get().tree; }
export function subscribeTree(fn) { return treeStore.subscribe(fn); }
log.debug('module eval done; tree store initialized', () => ({ url: import.meta.url }));
let _treeRefreshPromise = null;

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

export function treeEntry(path) {
    const tree = getTree();
    return tree?.[path] ? normalizeTreeEntry(tree[path]) : null;
}

function saveTreeToLocalStorage(tree) {
    try { localStorage.setItem(TREE_STORAGE_KEY, JSON.stringify(tree)); } catch (_) {}
}

export function loadTreeFromLocalStorageSync() {
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

export function mergeTreeEntries(entries, options = {}) {
    if (!entries || typeof entries !== 'object') return getTree();
    const stalePaths = options.stalePaths || null;
    const next = { ...(getTree() || {}) };
    for (const [path, incomingRaw] of Object.entries(entries)) {
        const incoming = normalizeTreeEntry(incomingRaw);
        const existing = next[path] ? normalizeTreeEntry(next[path]) : null;
        if (stalePaths?.has(path) && existing && treeEntrySize(existing) > treeEntrySize(incoming)) {
            continue;
        }
        next[path] = incoming;
    }
    treeStore.set({ tree: next });
    return next;
}

async function loadStoredTree() {
    const fromLocalStorage = loadTreeFromLocalStorageSync();
    if (fromLocalStorage) return fromLocalStorage;
    const cached = await listCacheGet('tree::/');
    if (cached && typeof cached === 'object' && Object.keys(cached).length) return cached;
    return null;
}

export async function updateTreeEntry(path, data) {
    const next = mergeTreeEntries({ [path]: normalizeTreeEntry(data) });
    await persistTree(getTree());
    return next[path];
}

export async function fetchTree(rootPath = CFG.path || '/', maxDepth = TREE_CRAWL_MAX_DEPTH) {
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
            // Store notify drives syncFolderFilterUI via the subscriber wired in ui.js.
            mergeTreeEntries(tree, { stalePaths });
            await persistTree(getTree());
        }
        inspect('tree:refresh-done', {
            rootPath: rootPath || '/',
            maxDepth,
            fetchedPaths: Object.keys(tree).length,
            complete: isComplete,
        });
        return getTree();
    })();
    try {
        return await _treeRefreshPromise;
    } finally {
        _treeRefreshPromise = null;
    }
}

export async function loadTree() {
    if (getTree()) return;
    const cached = await loadStoredTree();
    if (cached) {
        mergeTreeEntries(cached);
        return;
    }
}
