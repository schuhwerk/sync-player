// ## js-waveform — precomputed peaks → DPR-aware canvas with played overlay
import { player } from './player.js';
import { onPlayerChange } from './ui.js';
import { waveformBars } from './waveform-math.js';

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

export function waveformColors() {
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
export function getWaveformColors() {
    if (!_cachedWaveformColors) _cachedWaveformColors = waveformColors();
    return _cachedWaveformColors;
}
export function invalidateWaveformPaint() {
    _cachedWaveformColors = null;
    _wfFullRepaint = true;
}
// Called once per onPlayerChange — reads and resets the flag so the caller
// knows whether a full bar repaint is needed (e.g. after a resize or theme change).
export function takeWfFullRepaint() {
    const v = _wfFullRepaint;
    _wfFullRepaint = false;
    return v;
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
    ctx.fillStyle = color;
    for (const b of waveformBars(peaks, w, h)) ctx.fillRect(b.x, b.y, b.w, b.h);
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
export function paintTrackWaveform(trackEl, peaks, colors) {
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

export function updateTrackProgress(trackEl, played01) {
    const playedWrap = trackEl._wfPlayedWrap;
    if (!playedWrap) return;
    playedWrap.style.setProperty('--played', `${Math.max(0, Math.min(1, played01)) * 100}%`);
}
