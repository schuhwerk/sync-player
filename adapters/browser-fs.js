// Browser-side adapter for the single-file build. Exposes the same contract
// as the PHP adapters: api('list'|'search', path, extra) and loadBytes(path).
// Backed by File System Access API (showDirectoryPicker) if available, with a
// drag-drop FileSystemEntry fallback for Firefox/Safari. One root per session,
// kept in memory — see app.js navigate() for why we use pushState here.
(() => {
    let rootHandle = null;  // FileSystemDirectoryHandle (showDirectoryPicker)
    let rootEntry  = null;  // FileSystemEntry            (drag-drop fallback)
    // Demo manifest (set by build.php when dist/demo/ has audio in it).
    // Flat list — subfolders are not supported in this mode; the goal is a
    // zero-click demo on GitHub Pages, not arbitrary remote browsing.
    let rootStatic = null;
    const syncStaticRoot = () => {
        if (!rootHandle && !rootEntry) {
            rootStatic = window.CFG?.demo?.files?.length ? window.CFG.demo : null;
        }
        return rootStatic;
    };

    const ready = () => !!(rootHandle || rootEntry || syncStaticRoot());

    // Static mode discards visitor pushState navigation: there's nowhere to go.
    // If the visitor later drops a folder, that replaces the static root entirely.

    async function resolve(path) {
        const parts = path.split('/').filter(Boolean);
        if (rootHandle) {
            let h = rootHandle;
            for (let i = 0; i < parts.length; i++) {
                const last = i === parts.length - 1;
                try { h = await h.getDirectoryHandle(parts[i]); }
                catch {
                    if (!last) throw new Error('Not a directory: ' + parts.slice(0, i + 1).join('/'));
                    h = await h.getFileHandle(parts[i]);
                }
            }
            return h;
        }
        if (rootEntry) {
            let cur = rootEntry;
            for (const p of parts) {
                cur = await new Promise((res, rej) => {
                    cur.getDirectory(p, {}, res, () => cur.getFile(p, {}, res, rej));
                });
            }
            return cur;
        }
        throw new Error('No folder selected');
    }

    async function* iterEntries(dir) {
        if (rootHandle) {
            for await (const [name, h] of dir.entries()) yield { name, h };
            return;
        }
        // FileSystemDirectoryReader needs multiple reads to drain.
        const reader = dir.createReader();
        for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) yield { name: e.name, h: e };
        }
    }

    const isDir = h => rootHandle ? h.kind === 'directory' : h.isDirectory;

    async function entryFile(entry) {
        return new Promise((res, rej) => entry.file(res, rej));
    }

    async function lmOf(h) {
        const f = rootHandle ? await h.getFile() : await entryFile(h);
        return new Date(f.lastModified).toUTCString();
    }

    function joinPath(base, name) {
        const b = base === '/' ? '' : base.replace(/\/$/, '');
        return b + '/' + name;
    }

    function attachmentKind(name) {
        if (/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name)) return 'image';
        if (/\.pdf$/i.test(name)) return 'pdf';
        return null;
    }

    const audioRe = () => new RegExp('\\.(' + window.CFG.audioExt.join('|') + ')$', 'i');
    const natCmp  = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

    async function listDir(path) {
        const staticRoot = syncStaticRoot();
        if (staticRoot) {
            // Flat: only the root has content. Any deeper path returns empty.
            if (path !== '/' && path !== '') return { folders: [], files: [], attachments: [] };
            const files = staticRoot.files.map(f => ({ name: f.name, path: '/' + f.name, lm: f.lm || '' }));
            const attachments = (staticRoot.attachments || []).map(f => ({
                name: f.name,
                path: '/' + f.name,
                lm: f.lm || '',
                kind: f.kind || attachmentKind(f.name),
            }));
            files.sort(natCmp);
            attachments.sort(natCmp);
            return { folders: [], files, attachments };
        }
        const dir = await resolve(path);
        const re = audioRe();
        const folders = [], files = [], attachments = [];
        for await (const { name, h } of iterEntries(dir)) {
            if (name.startsWith('.')) continue;
            const childPath = joinPath(path, name);
            if (isDir(h)) {
                folders.push({ name, path: childPath, lm: '' });
            } else if (re.test(name)) {
                files.push({ name, path: childPath, lm: await lmOf(h) });
            } else {
                const kind = attachmentKind(name);
                if (kind) attachments.push({ name, path: childPath, lm: await lmOf(h), kind });
            }
        }
        folders.sort(natCmp); files.sort(natCmp); attachments.sort(natCmp);
        return { folders, files, attachments };
    }

    async function searchDir(path, q) {
        if (syncStaticRoot()) return { folders: [] }; // flat demo — nothing to search
        const dir = await resolve(path);
        const ql = q.toLowerCase();
        const out = [];
        const MAX = 200, MAX_DEPTH = 8;
        const walk = async (h, p, depth) => {
            if (out.length >= MAX || depth > MAX_DEPTH) return;
            for await (const { name, h: child } of iterEntries(h)) {
                if (out.length >= MAX) return;
                if (name.startsWith('.') || !isDir(child)) continue;
                const childPath = p + '/' + name;
                if (name.toLowerCase().includes(ql)) out.push({ name, path: childPath, lm: '' });
                await walk(child, childPath, depth + 1);
            }
        };
        await walk(dir, path === '/' ? '' : path.replace(/\/$/, ''), 0);
        out.sort((a, b) => a.path.localeCompare(b.path));
        return { folders: out };
    }

    async function loadMeta(path) {
        const staticRoot = syncStaticRoot();
        if (staticRoot) {
            const description = (path === '/' || path === '') ? (staticRoot.readme || '') : '';
            return { description, tones: {}, versions: { readme: null, sidecar: null } };
        }
        let description = '';
        try {
            const dir = await resolve(path);
            if (rootHandle) {
                const fh = await dir.getFileHandle('readme.md').catch(() => null);
                if (fh) { const f = await fh.getFile(); description = await f.text(); }
            } else if (rootEntry) {
                const entry = await new Promise(res => dir.getFile('readme.md', {}, res, () => res(null)));
                if (entry) { const f = await entryFile(entry); description = await f.text(); }
            }
        } catch (_) {}
        return { description, tones: {}, versions: { readme: null, sidecar: null } };
    }

    const api = async (mode, path, extra = {}) => {
        try {
            if (mode === 'list')      return await listDir(path);
            if (mode === 'search')    return await searchDir(path, (extra.q || '').trim());
            if (mode === 'load-meta') return await loadMeta(path);
            return { error: 'Unknown mode: ' + mode };
        } catch (e) {
            return { error: e.message || String(e) };
        }
    };

    const loadBytes = async (path) => {
        const staticRoot = syncStaticRoot();
        if (staticRoot) {
            const url = staticRoot.baseUrl + path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
            const r = await fetch(url);
            if (!r.ok) throw new Error('Failed to load ' + path + ' (HTTP ' + r.status + ')');
            return r.arrayBuffer();
        }
        const h = await resolve(path);
        const f = rootHandle ? await h.getFile() : await entryFile(h);
        return f.arrayBuffer();
    };

    const downloadFile = async (path, name) => {
        const bytes = await loadBytes(path);
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name || path.split('/').pop() || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const clearRoot = () => {
        if (!rootHandle && !rootEntry && !syncStaticRoot()) return false;
        rootHandle = null;
        rootEntry = null;
        rootStatic = { baseUrl: '', files: [] };
        window.CFG.demo = null;
        document.dispatchEvent(new CustomEvent('sync-root-changed'));
        return true;
    };

    function renderPicker(rootEl, done) {
        const supportsPicker = !!window.showDirectoryPicker;
        rootEl.innerHTML = `
            <div class="setup">
                <div class="box drop" id="dropbox">
                    <h3 style="margin:0 0 4px">Sync Player</h3>
                    <p class="mono" style="color:var(--mut);font-size:11px;margin:0 0 18px">drag a folder of audio in</p>
                    <div class="drop-zone">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--mut-2);display:block;margin:0 auto 10px">
                            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                            <path d="M12 11v6m-3-3 3-3 3 3"/>
                        </svg>
                        <div style="font-size:13px;color:var(--mut)">Drop a folder anywhere on this page</div>
                    </div>
                    ${supportsPicker ? `<button class="btn-p" id="pickbtn" style="margin-top:18px">Pick folder</button>` : ''}
                    <p class="hint" style="margin:18px 0 0;font-size:11.5px;color:var(--mut);line-height:1.5">
                        Files stay on your device. Nothing is uploaded.
                    </p>
                </div>
            </div>
            <style>
                .drop { text-align:center; transition: border-color .15s, background .15s; }
                .drop-zone {
                    border: 1.5px dashed var(--brd);
                    border-radius: var(--r-md);
                    padding: 24px 16px;
                    color: var(--mut);
                    transition: border-color .15s, background .15s, color .15s;
                }
                body.dragging .drop, body.dragging .drop-zone {
                    border-color: var(--acc);
                    background: var(--acc-soft);
                    color: var(--ink);
                }
            </style>`;

        document.getElementById('pickbtn')?.addEventListener('click', async () => {
            try {
                rootHandle = await window.showDirectoryPicker({ mode: 'read' });
                rootEntry = null; rootStatic = null;
                document.dispatchEvent(new CustomEvent('sync-root-changed'));
            } catch (_) { /* user cancelled */ }
        });
    }

    // Always-on drag-drop wiring. Lives at the document level so a dropped folder
    // can replace whatever root is active — including the demo manifest. That's
    // how the GitHub Pages demo lets visitors switch to their own folder.
    let dragDepth = 0;
    document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover',  e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('drop', e => {
        e.preventDefault();
        dragDepth = 0; document.body.classList.remove('dragging');
        for (const it of e.dataTransfer?.items || []) {
            const entry = it.webkitGetAsEntry?.();
            if (entry && entry.isDirectory) {
                rootEntry = entry; rootHandle = null; rootStatic = null;
                document.dispatchEvent(new CustomEvent('sync-root-changed'));
                return;
            }
        }
    });

    window.SyncBackend = { api, loadBytes, downloadFile, ready, renderPicker, clearRoot };
})();
