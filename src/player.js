// ## js-player — SyncPlayer: one AudioContext, sample-accurate sync, soft limiter
// Web Audio sync player — patterned after chor-player/web-api-player.ts but trimmed.
// One AudioContext, one gain node per track, sources recreated on play/seek (BufferSourceNodes are one-shot).
import { IS_MOBILE, MOBILE_PREDECODE_LIMIT, DESKTOP_DECODE_CONCURRENCY,
  DEFAULT_VOLUME, VOLUME_RAMP_SECONDS, inspect, nextInspectId, CFG } from './config.js';
import { loadCachedBytes, computePeaks, cacheGet, cachePut, audioKey } from './cache.js';

export async function forEachConcurrent(items, limit, fn) {
    if (!items.length) return;
    const width = Math.max(1, Math.min(limit || items.length, items.length));
    let next = 0;
    const workers = Array.from({ length: width }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            await fn(items[i], i);
        }
    });
    await Promise.all(workers);
}

function nextTask() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class SyncPlayer {
    constructor(files, onChange) {
        this.files = files;
        this.onChange = onChange;
        this.ctx = null;
        this.buffers = [];
        this.peaks = [];
        this.gains = [];
        this.sources = [];
        this.volumes = files.map(() => DEFAULT_VOLUME);
        this.maxVolume = 1;
        this.duration = 0;
        this.isPlay = false;
        this.currentTime = 0;
        this._playbackBase = 0;
        // On mobile we postpone decodeAudioData until the user actually presses
        // play, but the play button still needs to enable after the bytes are
        // available. fetchedFraction tracks fetch completion; loadedFraction
        // tracks decode completion / play readiness. Desktop waveforms keep
        // filling in after loadedFraction hits 1.
        this.fetchedFraction = 0;
        this.loadedFraction = 0;
        this.loadError = '';
        this.repeat = true;
        this._rafId = 0;
        // Encoded bytes, kept around on mobile until the first play() resolves
        // them into AudioBuffers. Nulled after decode to release memory.
        this._encoded = [];
        this._deferDecode = IS_MOBILE;
        this._decodePromise = null;
        this._starting = false;
        this._emitRafId = 0;
        this._ctxHoldCount = 0;
        this._ctxSuspendTimer = 0;
        this._playbackEndTimer = 0;
        this._closeCtxWhenIdle = false;
        this._destroyed = false;
        this._gestureUnlocked = false; // AudioContext unlocked via a user gesture
        this._earlyDecodeWanted = false; // gesture fired before fetch completed
        this._sourceRunId = 0;
        this._waveformPromise = null;
        this.limiter = null;
    }

    _startTickLoop() {
        if (this._rafId) return;
        const loop = () => {
            if (!this.isPlay) { this._rafId = 0; return; }
            this._tick();
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }
    _stopTickLoop() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    }
    _clearCtxSuspendTimer() {
        if (!this._ctxSuspendTimer) return;
        clearTimeout(this._ctxSuspendTimer);
        this._ctxSuspendTimer = 0;
    }
    _clearPlaybackEndTimer() {
        if (!this._playbackEndTimer) return;
        clearTimeout(this._playbackEndTimer);
        this._playbackEndTimer = 0;
    }
    _closeCtxNow() {
        const ctx = this.ctx;
        this.ctx = null;
        this.gains = [];
        this.limiter = null;
        this._closeCtxWhenIdle = false;
        if (!ctx) return;
        try { ctx.close(); } catch(e) {}
    }
    _resumeCtx() {
        const ctx = this._ctx();
        this._closeCtxWhenIdle = false;
        this._clearCtxSuspendTimer();
        try { ctx.resume(); } catch(e) {}
        return ctx;
    }
    _scheduleCtxSuspend() {
        if (!this.ctx) { this._closeCtxWhenIdle = false; return; }
        this._clearCtxSuspendTimer();
        if (this.isPlay || this._ctxHoldCount > 0) return;
        // Let the current event turn finish first so transient UI sounds can chain
        // without fighting an immediate suspend/resume.
        this._ctxSuspendTimer = setTimeout(() => {
            this._ctxSuspendTimer = 0;
            const ctx = this.ctx;
            if (!ctx || this.isPlay || this._ctxHoldCount > 0) return;
            if (this._closeCtxWhenIdle) {
                this._closeCtxNow();
                return;
            }
            if (ctx.state === 'closed') return;
            try { ctx.suspend(); } catch(e) {}
        }, 0);
    }
    _schedulePlaybackEnd(runId) {
        this._clearPlaybackEndTimer();
        const schedule = delayMs => {
            this._playbackEndTimer = setTimeout(() => {
                this._playbackEndTimer = 0;
                if (!this.isPlay || runId !== this._sourceRunId) return;
                this._syncCurrentTime();
                const remainingMs = Math.max(0, (this.duration - this.currentTime) * 1000);
                if (remainingMs > 120) {
                    const ctx = this.ctx;
                    schedule((!ctx || ctx.state === 'running') ? remainingMs + 80 : Math.min(remainingMs + 80, 1000));
                    return;
                }
                this._handlePlaybackEnded(runId);
            }, Math.max(0, Math.ceil(delayMs)));
        };
        const remainingMs = Math.max(0, (this.duration - this.currentTime) * 1000);
        schedule(remainingMs + 80);
    }
    holdContext() {
        this._ctxHoldCount++;
        const ctx = this._resumeCtx();
        let released = false;
        return {
            ctx,
            release: () => {
                if (released) return;
                released = true;
                this._ctxHoldCount = Math.max(0, this._ctxHoldCount - 1);
                this._scheduleCtxSuspend();
            },
        };
    }

    _ctx() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            const ctx = this.ctx;
            // Soft limiter: stops multi-track sums from clipping at the output.
            const lim = ctx.createDynamicsCompressor();
            lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
            lim.attack.value = 0.003; lim.release.value = 0.1;
            lim.connect(ctx.destination);
            this.limiter = lim;
            // Browser can auto-suspend the context (tab backgrounding, BT device change,
            // inactivity). When it resumes and we're supposed to be playing AND lost our
            // sources, restart them — otherwise the UI shows "playing" but is silent.
            // The `sources.length === 0` guard avoids racing with our own explicit
            // resume() inside play(), which would otherwise double-start the sources.
            ctx.addEventListener('statechange', () => {
                if (this.ctx !== ctx) return;
                if (ctx.state === 'running' && this.isPlay && this.sources.length === 0) {
                    this._restartSources();
                }
            });
        }
        return this.ctx;
    }
    _syncCurrentTime() {
        if (!this.isPlay || !this.ctx || this.ctx.state === 'closed') return this.currentTime;
        this.currentTime = Math.max(0, Math.min(this.duration, this.ctx.currentTime - this._playbackBase));
        return this.currentTime;
    }
    _invalidateSourceRun() {
        this._sourceRunId++;
        this._clearPlaybackEndTimer();
    }
    _handlePlaybackEnded(runId) {
        if (!this.isPlay || runId !== this._sourceRunId) return;
        this._clearPlaybackEndTimer();
        this.currentTime = this.duration;
        this.sources = [];
        if (this.repeat) {
            this.currentTime = 0;
            this._restartSources();
        } else {
            this.isPlay = false;
            this._stopTickLoop();
            this._scheduleCtxSuspend();
        }
        this._emit();
    }
    _emit() {
        if (this._destroyed || this._emitRafId) return;
        this._emitRafId = requestAnimationFrame(() => {
            this._emitRafId = 0;
            if (this._destroyed) return;
            this.onChange?.(this);
        });
    }
    _normalizeVolume(v) {
        return Number.isFinite(v) ? Math.max(0, Math.min(this.maxVolume, v)) : 0;
    }
    trackOutputVolume(i) {
        return this._normalizeVolume(this.volumes[i]);
    }
    _trackGainTarget(i) {
        return this.trackOutputVolume(i);
    }
    _applyTrackGain(i, immediate = false) {
        const g = this.gains[i];
        if (!g) return;
        const target = this._trackGainTarget(i);
        if (immediate || !this.ctx) {
            g.gain.value = target;
            return;
        }
        const now = this.ctx.currentTime;
        if (typeof g.gain.cancelAndHoldAtTime === 'function') g.gain.cancelAndHoldAtTime(now);
        else {
            g.gain.cancelScheduledValues(now);
            g.gain.setValueAtTime(g.gain.value, now);
        }
        g.gain.linearRampToValueAtTime(target, now + VOLUME_RAMP_SECONDS);
    }

    async load() {
        const loadId = nextInspectId('player-load');
        const total = this.files.length;
        let fetched = 0;
        this.loadError = '';
        inspect('player:load-start', { loadId, tracks: total, deferDecode: this._deferDecode });
        // Mobile keeps only two encoded tracks in flight at once; desktop keeps
        // the original parallel fetch behaviour and then decodes a few tracks at once.
        const loadOne = async (f, i) => {
            try {
                const key = `${f.path}::${f.lm}`;
                const wfHidden = document.body.classList.contains('hide-wf');
                inspect('player:track-start', { loadId, index: i, path: f.path, lm: f.lm || '', waveformCached: !wfHidden });
                const cached = wfHidden ? null : await cacheGet(key);
                if (this._destroyed) return;
                if (cached?.peaks) { this.peaks[i] = cached.peaks; this._emit(); }
                const { bytes, source } = await loadCachedBytes(f);
                inspect('player:track-source', { loadId, index: i, path: f.path, source });
                if (this._destroyed) return;
                fetched++;
                this.fetchedFraction = total ? fetched / total : 1;
                this._encoded[i] = bytes;
                inspect('player:track-ready', {
                    loadId,
                    index: i,
                    path: f.path,
                    source,
                    bytes: bytes?.byteLength || 0,
                    fetchedFraction: this.fetchedFraction,
                });
            } catch (e) {
                if (this._destroyed) return;
                this.buffers[i] = null;
                this._encoded[i] = null;
                const m = e?.message || '';
                this.loadError = this.loadError || (/^HTTP /.test(m)
                    ? `Audio unavailable (${m}).`
                    : 'Audio unavailable — source is offline or unreachable.');
                inspect('audio:track-unavailable', { path: f.path, message: m || String(e) });
            }
            // Mobile gates play on bytes available; desktop on decoded buffers.
            // On desktop we'll run _decodeAll immediately after Promise.all.
            if (this._destroyed) return;
            if (this._deferDecode) this.loadedFraction = this.fetchedFraction;
            this._emit();
        };
        if (this._deferDecode) await forEachConcurrent(this.files, 2, loadOne);
        else await Promise.all(this.files.map(loadOne));
        if (this._destroyed) return;
        this.fetchedFraction = 1;
        if (!this._deferDecode) {
            await this._decodeAll();
            if (this._destroyed) return;
            this.loadedFraction = 1;
        }
        this._emit();
        this._maybePredecode();
        if (this._earlyDecodeWanted) {
            this._earlyDecodeWanted = false;
            this._tryEarlyDecode();
        }
        inspect('player:load-done', {
            loadId,
            tracks: total,
            fetched: this.files.filter((_, i) => !!this._encoded[i] || !!this.buffers[i]).length,
            decoded: this.buffers.filter(Boolean).length,
            duration: this.duration,
            loadError: this.loadError || '',
        });
    }

    _maybePredecode() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || !MOBILE_PREDECODE_LIMIT) return;
        const totalBytes = this._encoded.reduce((sum, bytes) => sum + (bytes?.byteLength || 0), 0);
        if (!totalBytes || totalBytes > MOBILE_PREDECODE_LIMIT) return;
        inspect('audio:mobile-predecode', { totalBytes, limit: MOBILE_PREDECODE_LIMIT, tracks: this.files.length });
        this._decodeAll();
    }

    _buildMissingPeaksInBackground() {
        if (this._destroyed || this._waveformPromise || document.body.classList.contains('hide-wf')) return;
        const waveforms = (async () => {
            for (let i = 0; i < this.buffers.length; i++) {
                if (this._destroyed || document.body.classList.contains('hide-wf')) return;
                const buf = this.buffers[i];
                if (!buf || this.peaks[i]) continue;
                await nextTask();
                if (this._destroyed || document.body.classList.contains('hide-wf')) return;
                this.peaks[i] = computePeaks(buf);
                const f = this.files[i];
                cachePut(`${f.path}::${f.lm}`, { peaks: this.peaks[i] });
                this._emit();
            }
        })();
        this._waveformPromise = waveforms;
        waveforms.finally(() => {
            if (this._waveformPromise === waveforms) this._waveformPromise = null;
        });
    }

    // Run decodeAudioData for every fetched track. Mobile stays sequential to
    // keep memory low; desktop decodes a few tracks in parallel, then computes
    // any missing waveforms afterward so controls unlock as soon as playback is ready.
    async _decodeAll() {
        if (this._destroyed) return;
        if (this._decodePromise) return this._decodePromise;
        this._decodePromise = (async () => {
            const total = this.files.length;
            if (this._deferDecode) {
                const wfHidden = document.body.classList.contains('hide-wf');
                // Don't update loadedFraction here — on mobile it already equals
                // fetchedFraction (= 1), so the play button must stay enabled while
                // decode runs. Updating it to decoded/total would grey the button and
                // suppress the click event before play() is ever called.
                for (let i = 0; i < total; i++) {
                    if (this._destroyed) return;
                    const bytes = this._encoded[i];
                    if (!bytes || this.buffers[i]) continue;
                    try {
                        const buf = await this._ctx().decodeAudioData(bytes);
                        if (this._destroyed) return;
                        this.buffers[i] = buf;
                        this._encoded[i] = null; // release for GC
                        if (!wfHidden) {
                            const f = this.files[i];
                            const key = `${f.path}::${f.lm}`;
                            const cached = await cacheGet(key);
                            if (this._destroyed) return;
                            if (!cached?.peaks) {
                                this.peaks[i] = computePeaks(this.buffers[i]);
                                cachePut(key, { peaks: this.peaks[i] });
                            } else if (!this.peaks[i]) {
                                this.peaks[i] = cached.peaks;
                            }
                        }
                    } catch (e) {
                        if (this._destroyed) return;
                        this.buffers[i] = null;
                        this._encoded[i] = null;
                        this.loadError = this.loadError || 'Audio could not be decoded — file may be corrupt.';
                        inspect('audio:decode-error', { path: this.files[i].path, message: e?.message || String(e) });
                    }
                    this._emit();
                }
            } else {
                let processed = 0;
                await forEachConcurrent(this.files, DESKTOP_DECODE_CONCURRENCY, async (_, i) => {
                    if (this._destroyed) return;
                    const bytes = this._encoded[i];
                    if (bytes && !this.buffers[i]) {
                        try {
                            this.buffers[i] = await this._ctx().decodeAudioData(bytes);
                        } catch (e) {
                            if (this._destroyed) return;
                            this.buffers[i] = null;
                            this.loadError = this.loadError || 'Audio could not be decoded — file may be corrupt.';
                            inspect('audio:decode-error', { path: this.files[i].path, message: e?.message || String(e) });
                        } finally {
                            this._encoded[i] = null;
                        }
                    }
                    if (this._destroyed) return;
                    processed++;
                    this.loadedFraction = total ? processed / total : 1;
                    this._emit();
                });
            }
            const readyBuffers = this.buffers.filter(Boolean);
            this.duration = readyBuffers.length ? Math.max(...readyBuffers.map(b => b.duration)) : 0;
            if (this._deferDecode) {
                this._deferDecode = false;
                this.loadedFraction = 1;
            } else {
                this.loadedFraction = 1;
                this._buildMissingPeaksInBackground();
            }
            this._emit();
        })();
        try {
            return await this._decodePromise;
        } finally {
            this._decodePromise = null;
        }
    }

    primePlayback() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || this.isPlay) return;
        const hold = this.holdContext();
        this._decodeAll().finally(() => {
            if (!this.isPlay) hold.release();
        });
    }

    // Call from any user-gesture handler (pointerdown anywhere on the page).
    // Unlocks the AudioContext on iOS and starts decoding as soon as bytes are
    // ready — so play is instant even for large sets that skip _maybePredecode.
    primeOnGesture() {
        if (this._destroyed || !this._deferDecode || this.isPlay) return;
        if (!this._gestureUnlocked) {
            // Resume within the gesture so iOS marks the context as allowed.
            // Release right after — we don't want to keep a BT connection alive.
            const hold = this.holdContext();
            this._gestureUnlocked = true;
            Promise.resolve().then(() => { if (!this.isPlay) hold.release(); });
        }
        this._tryEarlyDecode();
    }

    _tryEarlyDecode() {
        if (this._destroyed || !this._deferDecode || this._decodePromise || this.isPlay) return;
        if (this.fetchedFraction < 1) { this._earlyDecodeWanted = true; return; }
        this._decodeAll();
    }

    // Compute peaks for buffers we skipped (e.g. waveforms started hidden, user
    // toggled them on). Called from applyShowWaveforms. Cheap relative to decode.
    computeMissingPeaks() {
        this._buildMissingPeaksInBackground();
    }

    _tick() {
        if (!this.isPlay) return;
        this._syncCurrentTime();
        if (this.currentTime >= this.duration) {
            this._handlePlaybackEnded(this._sourceRunId);
            return;
        }
        this._emit();
    }

    _restartSources() {
        const ctx = this._ctx();
        const startAt = Math.max(0, Math.min(this.duration, this.currentTime));
        const runId = this._sourceRunId + 1;
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        const nextSources = this.buffers.map((buf, i) => {
            if (!buf || startAt >= buf.duration) return null;
            let g = this.gains[i];
            if (!g) {
                g = this.gains[i] = ctx.createGain();
                g.connect(this.limiter); // connect once — repeated connects stack and inflate gain
            }
            this._applyTrackGain(i, true);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(g);
            src.start(0, startAt);
            return src;
        }).filter(Boolean);
        let pending = nextSources.length;
        nextSources.forEach(src => {
            src.onended = () => {
                if (runId !== this._sourceRunId) return;
                pending = Math.max(0, pending - 1);
                if (pending === 0) this._handlePlaybackEnded(runId);
            };
        });
        this.sources = nextSources;
        this._playbackBase = ctx.currentTime - startAt;
        this._schedulePlaybackEnd(runId);
    }

    async play() {
        // Re-entrancy guard: on mobile play() awaits decode, so a second toggle
        // press before the first resolved would otherwise double-fire _restartSources.
        if (this.isPlay || this._starting) return;
        this._starting = true;
        this._emit();
        try {
            // First mobile play(): resume context within the gesture so iOS unlocks it,
            // then decode. After the await the gesture chain is broken, so we must also
            // await ctx.resume() before start() — iOS silently drops source.start() on
            // a still-suspended context.
            if (this._deferDecode) {
                this._resumeCtx();
                await this._decodeAll();
            }
            if (!this.buffers.some(Boolean)) return;
            const ctx = this._resumeCtx();
            if (ctx.state !== 'running') try { await ctx.resume(); } catch(e) {}
            this._restartSources();
            this.isPlay = true;
            this._starting = false;
            this._startTickLoop();
            this._emit();
        } finally {
            if (this._starting) {
                this._starting = false;
                this._emit();
            }
        }
    }
    pause() {
        if (!this.isPlay) return;
        this._syncCurrentTime();
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        this.sources = [];
        this.isPlay = false;
        this._stopTickLoop();
        // Release the audio hardware so Bluetooth output reverts to other apps.
        // Browsers only drop the device when the context is suspended or closed.
        // Close it on an explicit pause so the next play() recreates a clean sink.
        this._closeCtxWhenIdle = true;
        this._scheduleCtxSuspend();
        this._emit();
    }
    toggle() { this.isPlay ? this.pause() : this.play(); }
    seek(delta) { this.jumpTo(this.currentTime + delta); }
    jumpTo(sec) {
        this._syncCurrentTime();
        this.currentTime = Math.max(0, Math.min(this.duration, sec));
        if (this.isPlay) this._restartSources();
        this._emit();
    }
    setVolume(i, v, { emit = true } = {}) {
        const next = this._normalizeVolume(v);
        if (this.volumes[i] === next) return;
        this.volumes[i] = next;
        this._applyTrackGain(i);
        if (emit) this._emit();
    }
    setVolumes(nextVolumes) {
        let changed = false;
        for (let i = 0; i < this.volumes.length; i++) {
            const next = this._normalizeVolume(nextVolumes[i]);
            if (this.volumes[i] === next) continue;
            this.volumes[i] = next;
            this._applyTrackGain(i);
            changed = true;
        }
        if (changed) this._emit();
    }
    setAllVolumes(v) { this.setVolumes(this.volumes.map(() => v)); }
    toggleMute() {
        this._preMuteAll ??= [];
        const allMuted = this.volumes.every(v => v === 0);
        if (allMuted) {
            this.volumes.forEach((_, i) => this.setVolume(i, this._preMuteAll[i] ?? DEFAULT_VOLUME));
            return;
        }
        this._preMuteAll = [...this.volumes];
        this.setAllVolumes(0);
    }
    toggleTrackMute(i) {
        // Stash the pre-mute volume so unmute can restore it. Default to 50% if track was already at 0.
        this._preMute ??= [];
        if (this.volumes[i] > 0) { this._preMute[i] = this.volumes[i]; this.setVolume(i, 0); }
        else                    { this.setVolume(i, this._preMute[i] || DEFAULT_VOLUME); }
    }
    soloTrack(i) {
        // If others are already silenced and this one alone is audible, restore everyone. Otherwise solo.
        this._preMute ??= [];
        const othersAllMuted = this.volumes.every((v, k) => k === i ? v > 0 : v === 0);
        if (othersAllMuted) {
            this.volumes.forEach((_, k) => { if (k !== i) this.setVolume(k, this._preMute[k] || DEFAULT_VOLUME); });
        } else {
            this.volumes.forEach((v, k) => {
                if (k === i) { if (v === 0) this.setVolume(k, this._preMute[k] || DEFAULT_VOLUME); }
                else { if (v > 0) this._preMute[k] = v; this.setVolume(k, 0); }
            });
        }
    }
    toggleRepeat() { this.repeat = !this.repeat; this._emit(); }
    destroy() {
        inspect('player:destroy', {
            tracks: this.files.length,
            hadBuffers: this.buffers.filter(Boolean).length,
            hadEncoded: this._encoded.filter(Boolean).length,
            wasPlaying: this.isPlay,
        });
        this._destroyed = true;
        this._stopTickLoop();
        if (this._emitRafId) { cancelAnimationFrame(this._emitRafId); this._emitRafId = 0; }
        this._clearCtxSuspendTimer();
        this._clearPlaybackEndTimer();
        this._ctxHoldCount = 0;
        this._invalidateSourceRun();
        this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
        this.sources = [];
        this.isPlay = false;
        this.onChange = null;
        this._encoded = [];
        this.buffers = [];
        this.peaks = [];
        this._waveformPromise = null;
        this._closeCtxNow();
    }
}

// Shared player singleton — owned here so leaf modules (waveform, stage,
// basetones) can import it without pulling in all of ui.js.
export let player = null;
export function setPlayer(p) { player = p; }
