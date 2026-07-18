// ## js-attachments — image/PDF chips, inline + fullscreen preview
import { $, escapeHtml, IS_MOBILE, fileHref, qs } from './config.js';
import { loadCachedBytes } from './cache.js';
import { setBaseToneStatus } from './basetones.js';

export function closeAllAttachmentMenus() {
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

export async function downloadTrackFile(file) {
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
export const attachmentPreview = {
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

export function attachmentSectionHTML(files) {
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

export function bindAttachmentCards(files) {
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
