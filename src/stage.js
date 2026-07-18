// ## js-stage — spatial mix: tracks on a circle + draggable listener, distance sets volume
// Each track sits in a normalized [0..1] square. Distance from track to listener
// drives an equal-power falloff (cos curve). Past the per-track audibility radius
// the track is fully muted. When the stage is active it writes those values
// directly into the real per-track volumes; manual slider edits then deactivate it.
import { CFG, IS_MOBILE, inspect, DEFAULT_VOLUME, escapeHtml } from './config.js';
import { player } from './player.js';
import { createStore } from './store.js';
import {
    STAGE_AUDIBLE_R, clamp01, stageFingerprint, stageDefaults,
    stageTrackVolume, stageTrackVisualLevel,
} from './stage-math.js';

const STAGE_ENABLED_KEY = 'syncplayer.stage.enabled';
const STAGE_INFO_ACTIVE = 'Walk around the mix — drag tracks and the listener; distance sets each track\'s volume.';
const STAGE_INFO_INACTIVE = 'Stage is visible but inactive — volume sliders now drive the mix directly. Drag the stage to reactivate it.';

// View flags (on/active) live in an observable store. A single subscriber
// (syncStageUI) re-syncs the DOM, so callers just mutate state via the setters
// below and never hand-call syncStageUI() after a flag change.
const stageView = createStore({ on: false, active: true });
const isStageOn = () => stageView.get().on;
const isStageActive = () => stageView.get().active;
let _stageState = null;                  // {listener:{x,y}, tracks:{[name]:{x,y}}, fingerprint}
let _stagePersistTimer = 0;

const stageKey = () => `syncplayer.stage::${CFG.adapterId || 'default'}::${CFG.path}`;

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

function stageAffectsVolume() {
    return isStageOn() && isStageActive();
}

function setSliderVisual(slider, pct) {
    if (!slider) return;
    const n = Number(pct);
    const clamped = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
    slider.style.setProperty('--vol-pct', `${clamped}%`);
}

function syncStageUI() {
    const on = isStageOn();
    const inactive = on && !isStageActive();
    document.body.classList.toggle('stage-on', on);
    document.body.classList.toggle('stage-inactive', inactive);
    const btn = document.getElementById('menu-stage');
    if (btn) {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-checked', String(on));
        const lbl = btn.querySelector('.lbl');
        if (lbl) lbl.textContent = inactive ? 'Stage (inactive)' : 'Stage';
    }
    const info = document.getElementById('menu-stage-info');
    if (info) info.textContent = inactive ? STAGE_INFO_INACTIVE : STAGE_INFO_ACTIVE;
    const hint = document.getElementById('stage-hint');
    if (hint) hint.textContent = inactive ? STAGE_INFO_INACTIVE : 'Drag tracks and the listener. Volume rises as the listener moves closer; outside a track\'s ring is mute. Tap empty space to teleport the listener.';
}

// Single subscriber: every flag mutation re-syncs the DOM automatically.
stageView.subscribe(syncStageUI);

function activateStageForGesture() {
    if (isStageActive()) return;
    stageView.set({ active: true });
}

export function deactivateStageForManualVolume() {
    if (!isStageOn() || !isStageActive()) return;
    stageView.set({ active: false });
    applyStageAll();
}

function stageTrackLevel(i) {
    if (!player || !_stageState) return DEFAULT_VOLUME;
    const tp = _stageState.tracks[player.files[i].name];
    return tp ? stageTrackVolume(tp, _stageState.listener) : DEFAULT_VOLUME;
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
    if (!files.length || !isStageOn()) return '';
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
    const g = document.getElementById('stage-listener');
    if (g) g.setAttribute('transform', `translate(${(x * 100).toFixed(3)},${(y * 100).toFixed(3)})`);
}

// Pointer-capture drag. The SVG's bounding rect is captured at pointerdown so
// the drag doesn't tear if the page reflows mid-drag.
function bindStageDrag(el, onMove) {
    el.addEventListener('pointerdown', e => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const svg = document.getElementById('stage-svg');
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
    const svg = document.getElementById('stage-svg');
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
    const listener = document.getElementById('stage-listener');
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

    document.getElementById('stage-reset')?.addEventListener('click', () => {
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

export function initStage(files) {
    if (!files?.length) return;
    _stageState = loadStageStateFor(files);
    syncStageUI();
    // Only bind when the SVG is actually in the DOM. When off, renderStage()
    // returns '' so there's nothing to bind to.
    if (isStageOn()) bindStage(files);
}

// Build + inject the stage SVG into the current player view (used when the
// user toggles the stage on after a render where it was skipped). Returns
// false if there's no player to inject into.
function mountStage() {
    if (!player || !player.files.length) return false;
    if (document.getElementById('stage')) return true;
    const playerEl = document.querySelector('.player');
    if (!playerEl) return false;
    playerEl.insertAdjacentHTML('beforeend', renderStage(player.files));
    syncStageUI();
    if (!_stageState) _stageState = loadStageStateFor(player.files);
    bindStage(player.files);
    return true;
}

function unmountStage() {
    document.getElementById('stage')?.remove();
}

export function applyStageEnabled(on) {
    const wasOn = isStageOn();
    const next = !!on;
    // Turning on always re-activates; turning off leaves active untouched.
    stageView.set(s => ({ on: next, active: next ? true : s.active }));
    try { localStorage.setItem(STAGE_ENABLED_KEY, next ? '1' : '0'); } catch (_) {}
    syncStageUI();
    if (next && !wasOn) mountStage();
    else if (!next && wasOn) unmountStage();
    applyStageAll();
}

export function initStageEnabled() {
    const def = IS_MOBILE ? '0' : '1';
    let v = def;
    try { v = localStorage.getItem(STAGE_ENABLED_KEY) ?? def; } catch (_) {}
    applyStageEnabled(v === '1');
}

export { renderStage, stageTrackVisualLevel };
