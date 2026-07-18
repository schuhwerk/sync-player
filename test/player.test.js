// SyncPlayer scenario tests under `bun test` — ported from test/player.html.
// SyncPlayer takes an injectable AudioContext, so mobile/desktop/pause-play
// flows run against a MockAudioContext: millisecond runs, no Playwright.
// The setup import must come FIRST: it installs window.CFG and the browser
// shims that config.js / cache.js read at module-eval time.
import { test, expect, describe } from 'bun:test';
import { MockAudioContext, MockAudioBuffer, fakeFiles,
         playerWithMockCtx, injectEncodedBytes, injectDecodedBuffers } from './player.setup.js';
import { SyncPlayer } from '../src/player.js';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('mobile first play (deferDecode=true)', () => {
    test('loadedFraction stays 1 during and after decode', async () => {
        const ctx = new MockAudioContext();
        let resolveDecode;
        ctx.decodeAudioData = async () => {
            await new Promise(r => { resolveDecode = r; });
            return new MockAudioBuffer(1.0);
        };
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        p._deferDecode = true;
        injectEncodedBytes(p);

        const playPromise = p.play();
        // Decode in flight — button must stay enabled (bytes were fetched).
        expect(p.loadedFraction).toBe(1);

        resolveDecode?.();
        await playPromise;
        expect(p.isPlay).toBe(true);
        expect(p.loadedFraction).toBe(1);
        p.destroy();
    });

    test('ctx.resume() completes before isPlay becomes true', async () => {
        const ctx = new MockAudioContext();
        ctx.state = 'suspended';
        let resumeFinished = false;
        ctx._resumeImpl = async () => {
            await tick();
            ctx.state = 'running';
            resumeFinished = true;
        };
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        p._deferDecode = true;
        injectEncodedBytes(p);

        await p.play();
        expect(resumeFinished).toBe(true);
        expect(p.isPlay).toBe(true);
        expect(ctx._resumeCalls).toBeGreaterThanOrEqual(1);
        p.destroy();
    });

    test('isPlay true and _starting cleared after resolve', async () => {
        const ctx = new MockAudioContext();
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(2), ctx);
        p._deferDecode = true;
        injectEncodedBytes(p);

        expect(p.isPlay).toBe(false);
        await p.play();
        expect(p.isPlay).toBe(true);
        expect(p._starting).toBe(false);
        p.destroy();
    });
});

describe('desktop play (deferDecode=false)', () => {
    test('no decode when buffers already ready', async () => {
        const ctx = new MockAudioContext();
        let decodeHappened = false;
        ctx.decodeAudioData = async () => { decodeHappened = true; return new MockAudioBuffer(); };
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(2), ctx);
        injectDecodedBuffers(p);

        await p.play();
        expect(decodeHappened).toBe(false);
        expect(p.isPlay).toBe(true);
        p.destroy();
    });

    test('ctx.resume() called, isPlay true', async () => {
        const ctx = new MockAudioContext();
        ctx.state = 'suspended';
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        injectDecodedBuffers(p);

        await p.play();
        expect(ctx._resumeCalls).toBeGreaterThanOrEqual(1);
        expect(p.isPlay).toBe(true);
        p.destroy();
    });

    test('a source is created and started for each buffer', async () => {
        const ctx = new MockAudioContext();
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(3), ctx);
        injectDecodedBuffers(p);
        p.buffers = p.files.map(() => new MockAudioBuffer(1.0));

        await p.play();
        expect(p.sources).toHaveLength(3);
        expect(ctx._sources.every(s => s._started)).toBe(true);
        p.destroy();
    });
});

describe('pause → play cycle', () => {
    test('pause: isPlay false, sources stopped and cleared', async () => {
        const ctx = new MockAudioContext();
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(2), ctx);
        injectDecodedBuffers(p);

        await p.play();
        expect(p.isPlay).toBe(true);
        const before = [...p.sources];

        p.pause();
        expect(p.isPlay).toBe(false);
        expect(p.sources).toHaveLength(0);
        expect(before.every(s => s._stopped)).toBe(true);
    });

    test('pause closes context, second play restarts sources', async () => {
        const ctx = new MockAudioContext();
        ctx.state = 'running';
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        injectDecodedBuffers(p);

        await p.play();
        expect(p.isPlay).toBe(true);

        p.pause();
        expect(p.isPlay).toBe(false);
        expect(p._closeCtxWhenIdle).toBe(true);

        await new Promise(r => setTimeout(r, 20)); // let the suspend/close timer fire

        await p.play();
        expect(p.isPlay).toBe(true);
        expect(p.sources.length).toBeGreaterThan(0);
        p.destroy();
    });

    test('currentTime preserved across pause/play', async () => {
        const ctx = new MockAudioContext();
        ctx.state = 'running';
        ctx.currentTime = 0;
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        injectDecodedBuffers(p);

        await p.play();
        ctx.currentTime = 0.3;
        p._playbackBase = 0;

        p.pause();
        const saved = p.currentTime;
        expect(saved).toBeGreaterThanOrEqual(0);

        await p.play();
        const startedAt = ctx._sources[ctx._sources.length - 1]?._startOffset;
        expect(Math.abs((startedAt ?? saved) - saved)).toBeLessThan(0.05);
        p.destroy();
    });
});

describe('re-entrancy guard', () => {
    test('second play() while first in flight is ignored (single decode)', async () => {
        const ctx = new MockAudioContext();
        let decodeCount = 0;
        ctx.decodeAudioData = async () => {
            decodeCount++;
            await new Promise(r => setTimeout(r, 5));
            return new MockAudioBuffer();
        };
        const p = playerWithMockCtx(SyncPlayer, fakeFiles(1), ctx);
        p._deferDecode = true;
        injectEncodedBytes(p);

        const p1 = p.play();
        const p2 = p.play(); // ignored: this._starting === true
        await Promise.all([p1, p2]);

        expect(decodeCount).toBe(1);
        expect(p.isPlay).toBe(true);
        p.destroy();
    });
});
