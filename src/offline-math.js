// ## js-offline-math — pure pin-set selection (no DOM, no IDB, no network)
// Extracted from offline.js so the "which items does pinning a folder cache?"
// logic is unit-testable without booting IDB/loadBytes. The I/O (fetchTree,
// audioCachePut, setPin) stays in offline.js.

// True if `path` is `prefix` itself or nested under it. Root ('/') matches all.
// The `prefix + '/'` boundary stops '/foo' from matching '/foobar'.
export const underPrefix = (path, prefix) =>
    prefix === '/' || path === prefix || path.startsWith(prefix + '/');

// Flatten every audio file + attachment in the tree that lives under `prefix`
// into the list of items pinning will fetch. `tree` is the flat
// `{ path: { files, attachments } }` map (or falsy before a crawl).
export function collectPinItems(tree, prefix) {
    if (!tree) return [];
    return Object.entries(tree)
        .filter(([p]) => underPrefix(p, prefix))
        .flatMap(([, e]) => [...(e.files || []), ...(e.attachments || [])]);
}

// The minimal record persisted in the pin marker — enough to re-key the audio
// cache (path+lm) and unpin (audioKey) on a later visit without re-crawling.
export const pinItemRecords = items =>
    items.map(f => ({ path: f.path, lm: f.lm, name: f.name, kind: f.kind || 'audio' }));
