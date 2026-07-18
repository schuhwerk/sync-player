// ## js-basetones — per-file base tones (note + freq), inline editor, cascade playback
import { CFG, api, apiPost, inspect, escapeHtml } from './config.js';
import { player } from './player.js';
import { handleAuth, setSaveIndicator, syncDescriptionUI, linkifyText, autosizeTextarea } from './ui.js';

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
export let baseTones = {};
export let metaDescription = '';
// Optimistic-lock tokens from the last server load/save. Null = file expected absent;
// string = expected token; false (default) = no expectation, write unconditionally.
export let metaVersions = { readme: false, sidecar: false };
export let metaEditMode = false;
export let baseToneDirty = false;
export let baseToneSaving = false;
export let baseToneStatus = '';
export let baseToneStatusError = false;
let baseToneSaveTimer = 0;
export let baseToneVersion = 0;
export let baseToneSavedVersion = 0;
let toneRunMode = '';
let toneRunTimer = 0;
let toneRunStops = [];

const roundFreq = f => Math.round(f * 1000) / 1000;

export function clearToneRun() {
    if (toneRunTimer) clearTimeout(toneRunTimer);
    toneRunTimer = 0;
    toneRunStops.splice(0).forEach(stop => stop());
    toneRunMode = '';
}

export function clearMetaSaveTimer() {
    if (baseToneSaveTimer) clearTimeout(baseToneSaveTimer);
    baseToneSaveTimer = 0;
}

// Setter for baseToneDirty — called by flushBeforeNavigate in ui.js which cannot
// write to an imported live binding directly.
export function setBaseToneDirty(val) {
    baseToneDirty = val;
}

export function setBaseToneStatus(msg = '', isError = false) {
    baseToneStatus = msg;
    baseToneStatusError = isError;
    syncBaseToneUI();
}

export function freqToNote(freq) {
    const semis = Math.round(12 * Math.log2(freq / 440));
    const midi = 69 + semis;
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
}

export function noteToFreq(value) {
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

export const shiftHalftone = (freq, steps) => freq * 2 ** (steps / 12);

function canonicalTone(freq) {
    const rounded = roundFreq(freq);
    return { note: freqToNote(rounded), freq: rounded };
}

export function toneForFile(name) {
    const tone = baseTones[name];
    return tone && Number.isFinite(tone.freq) ? tone : null;
}

export function serializeMeta() {
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

export function renderBaseToneControl(name) {
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

export function syncBaseToneUI() {
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
    const cascadeBtn = document.getElementById('bt-cascade');
    const status = document.getElementById('bt-status');
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

export function resetMetaState() {
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
    metaEditMode = false;
    document.body.classList.remove('edit-mode');
    document.getElementById('menu-edit')?.classList.remove('on');
}

// Server-supplied optimistic-lock tokens. `false` → unknown (don't send); a
// string → expected ETag/mtime; `null` → expect file absent.
function applyMetaVersions(v) {
    if (!v || typeof v !== 'object') return;
    metaVersions = { readme: v.readme ?? null, sidecar: v.sidecar ?? null };
}

// Pure: takes a meta payload (from network or IDB) and pushes it into module state.
// Returns true if the payload was applied, false if it was an auth/error envelope.
export function applyMetaPayload(res) {
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

export async function loadFolderMeta(folderPath) {
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

export async function flushMetaSave() {
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

export function setFolderDescription(text) {
    const next = String(text || '');
    if (next === metaDescription) return;
    metaDescription = next;
    markMetaDirty();
    setBaseToneStatus('');
    syncDescriptionUI();
}

export function playTone(freq, durationMs = 720) {
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

export function playTrackTone(name) {
    clearToneRun();
    syncBaseToneUI();
    const tone = toneForFile(name);
    if (!tone) return;
    playTone(tone.freq);
}

export function setTrackTone(name, freq, play = false) {
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

export function clearTrackTone(name) {
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

export function runCascade() {
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

export function setEditMode(on) {
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
    const btn = document.getElementById('menu-edit');
    if (btn) {
        btn.classList.toggle('on', metaEditMode);
        btn.setAttribute('aria-checked', String(metaEditMode));
    }
}

export function initMeta(folderPath) {
    return loadFolderMeta(folderPath);
}
