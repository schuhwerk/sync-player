#!/usr/bin/env node
// Browser suite in headless Chromium via Playwright. SyncPlayer unit scenarios
// live in test/player.test.js (`bun test`); this covers what bun can't:
// the real ES-module graph + real AudioContext decode/playback in a browser,
// end-to-end against the PHP server (LocalAdapter over generated WAV fixtures),
// plus the app-password gate and the single-file docs build.
//
//   bash test/run.sh     # installs Playwright on first run, then runs this
//   node test/run.mjs    # if test/node_modules is already installed
//
// Spawns its own PHP servers (base port SYNC_TEST_PORT, default 8765) and a
// temp fixture tree; cleans both up on exit. Exit 0 = all checks passed.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeFixtures, FIXTURE_DURATION } from './fixtures.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE_PORT = Number(process.env.SYNC_TEST_PORT || 8765);
const APP_PW = 'sesame-open';

const RED   = s => `\x1b[31m${s}\x1b[0m`;
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const DIM   = s => `\x1b[2m${s}\x1b[0m`;

// ## servers — PHP spawn + readiness

const phpProcs = [];

function startPhp(port, { env = {}, docroot = null } = {}) {
    const args = ['-S', `localhost:${port}`, ...(docroot ? ['-t', docroot] : [])];
    const proc = spawn('php', args, {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: 'ignore',
    });
    phpProcs.push(proc);
    return proc;
}

async function waitForHttp(url, tries = 50) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url);
            if (r.status < 500) return;
        } catch (_) {}
        await new Promise(res => setTimeout(res, 100));
    }
    throw new Error(`server not reachable: ${url}`);
}

// ## harness — per-test page with console-error tracking

let browser;
let passed = 0;
let failed = 0;

async function check(name, fn) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    // 401s are part of the auth flow (gate test), not defects — skip that noise.
    page.on('console', m => {
        if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    try {
        await fn(page);
        if (errors.length) throw new Error('console errors:\n  ' + errors.join('\n  '));
        passed++;
        console.log(GREEN('  ✓ ') + name);
    } catch (e) {
        failed++;
        console.log(RED('  ✗ ') + name);
        console.log(RED('    ' + String(e.message || e).split('\n').join('\n    ')));
    } finally {
        await ctx.close();
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

// ## suite

const fixtureRoot = await mkdtemp(join(tmpdir(), 'sync-player-fixtures-'));
await makeFixtures(fixtureRoot);

const MAIN   = `http://localhost:${BASE_PORT}`;
const GATED  = `http://localhost:${BASE_PORT + 1}`;
const DOCS   = `http://localhost:${BASE_PORT + 2}`;
const DEMOFS = `http://localhost:${BASE_PORT + 3}`; // local adapter over docs/demo — real multi-MB files for Range checks

// SYNCPLAYER_CONFIG=/dev/null shields the suite from a developer's local
// config.php (which may set its own adapter/app password).
const baseEnv = { SYNCPLAYER_CONFIG: '/dev/null', SYNCPLAYER_ADAPTER: 'local', SYNCPLAYER_LOCAL_ROOT: fixtureRoot };
startPhp(BASE_PORT, { env: baseEnv });
startPhp(BASE_PORT + 1, { env: { ...baseEnv, SYNCPLAYER_APP_PASSWORD: APP_PW } });
startPhp(BASE_PORT + 2, { docroot: 'docs' });
startPhp(BASE_PORT + 3, { env: { ...baseEnv, SYNCPLAYER_LOCAL_ROOT: join(ROOT, 'docs', 'demo') } });

let exitCode = 0;
try {
    await Promise.all([MAIN, GATED, DOCS, DEMOFS].map(o => waitForHttp(`${o}/`)));

    browser = await chromium.launch({
        args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });

    console.log(DIM(`fixtures: ${fixtureRoot}`));
    console.log(DIM(`servers:  ${MAIN} (main) · ${GATED} (app-pw) · ${DOCS} (docs build) · ${DEMOFS} (demo root)`));

    await check('root loads clean and lists fixture folders', async page => {
        await page.goto(`${MAIN}/?path=/`, { waitUntil: 'load' });
        await page.waitForSelector('#folders a[data-path]', { timeout: 10000 });
        const names = await page.$$eval('#folders a[data-path] .nm', els => els.map(e => e.textContent));
        assert(names.includes('Alpha Band') && names.includes('Beta'),
            `expected folders [Alpha Band, Beta], got [${names}]`);
    });

    await check('navigating into a folder renders its tracks', async page => {
        await page.goto(`${MAIN}/?path=/`, { waitUntil: 'load' });
        await page.waitForSelector('#folders a[data-path]', { timeout: 10000 });
        await page.click('#folders a[data-path="/Alpha Band"]');
        await page.waitForSelector('.track', { timeout: 10000 });
        const names = await page.$$eval('.track .nm', els => els.map(e => e.textContent));
        assert(names.length === 3, `expected 3 tracks, got ${names.length}`);
        for (const n of ['bass', 'drums', 'vox']) {
            assert(names.includes(n), `missing track "${n}" in [${names}]`);
        }
    });

    await check('audio decodes; play advances time; space pauses', async page => {
        await page.goto(`${MAIN}/?path=${encodeURIComponent('/Alpha Band')}`, { waitUntil: 'load' });
        await page.waitForSelector('#play:not([disabled])', { timeout: 20000 });
        const t0 = await page.textContent('#time');
        assert(t0.includes(`/ 0:0${FIXTURE_DURATION}`), `duration wrong: "${t0}"`);
        await page.click('#play');
        // pause glyph = playing; then the seek fill must actually move
        await page.waitForFunction(() =>
            document.querySelector('#play-ic path')?.getAttribute('d')?.startsWith('M6 19'),
            { timeout: 5000 });
        await page.waitForFunction(() =>
            parseFloat(document.querySelector('#seek b')?.style.width || '0') > 5,
            { timeout: 5000 });
        await page.keyboard.press('Space');
        await page.waitForFunction(() =>
            document.querySelector('#play-ic path')?.getAttribute('d')?.startsWith('M8 5'),
            { timeout: 5000 });
    });

    await check('keyboard: r toggles repeat, m mutes all tracks', async page => {
        await page.goto(`${MAIN}/?path=${encodeURIComponent('/Alpha Band')}`, { waitUntil: 'load' });
        await page.waitForSelector('#play:not([disabled])', { timeout: 20000 });
        // repeat defaults to on (player.js) — r turns it off, second r back on
        assert(await page.$eval('#rep', el => el.classList.contains('on')), 'repeat should default to on');
        await page.keyboard.press('r');
        await page.waitForFunction(() => !document.querySelector('#rep')?.classList.contains('on'),
            { timeout: 5000 }).catch(() => { throw new Error('repeat not off after r'); });
        await page.keyboard.press('r');
        await page.waitForFunction(() => document.querySelector('#rep')?.classList.contains('on'),
            { timeout: 5000 }).catch(() => { throw new Error('repeat not back on after second r'); });
        await page.keyboard.press('m');
        await page.waitForFunction(() =>
            [...document.querySelectorAll('.track')].every(el => el.classList.contains('muted')),
            { timeout: 5000 }).catch(() => { throw new Error('tracks not muted after m'); });
    });

    await check('attachments: chips render, menu opens, inline + fullscreen preview', async page => {
        await page.goto(`${MAIN}/?path=${encodeURIComponent('/Alpha Band')}`, { waitUntil: 'load' });
        await page.waitForSelector('.attachment-chip', { timeout: 10000 });
        const kinds = await page.$$eval('.attachment-chip .attachment-kind', els => els.map(e => e.textContent));
        assert(kinds.length === 2 && kinds.includes('IMG') && kinds.includes('PDF'),
            `expected chips [IMG, PDF], got [${kinds}]`);
        // ⋮ menu on the image chip (index 0: attachments sort by name, cover.png first)
        await page.click('[data-attachment-menu="0"]');
        await page.waitForSelector('#attachment-menu-0:not([hidden])', { timeout: 5000 });
        // "Show here" — inline preview loads the PNG through ?mode=fetch
        await page.click('[data-attachment-open="0"]');
        await page.waitForFunction(() => {
            const img = document.querySelector('#attachment-inline-preview:not([hidden]) img');
            return img && img.complete && img.naturalWidth > 0;
        }, { timeout: 10000 });
        assert(await page.$eval('[data-attachment-open="0"]', el => el.classList.contains('on')),
            '"Show here" button not marked on');
        // second click toggles the inline preview off
        await page.click('[data-attachment-menu="0"]');
        await page.click('[data-attachment-open="0"]');
        await page.waitForFunction(() => document.querySelector('#attachment-inline-preview')?.hidden,
            { timeout: 5000 });
        // "Open large" overlay, Esc closes it
        await page.click('[data-attachment-menu="0"]');
        await page.click('[data-attachment-fullscreen="0"]');
        await page.waitForSelector('.attachment-fs-stage img', { timeout: 10000 });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.attachment-fs-stage'),
            { timeout: 5000 });
    });

    await check('fetch Range: byte-exact explicit/suffix/open-ended on a demo file, 416s', async () => {
        // real multi-MB file, byte-compared against the copy on disk
        const name = 'Salmo 150 Alto.webm';
        const disk = await readFile(join(ROOT, 'docs', 'demo', name));
        const size = disk.length;
        const url = `${DEMOFS}/?mode=fetch&path=${encodeURIComponent('/' + name)}`;

        const ranged = async range => {
            const r = await fetch(url, { headers: { Range: range } });
            assert(r.status === 206, `${range}: expected 206, got ${r.status}`);
            return { body: Buffer.from(await r.arrayBuffer()), cr: r.headers.get('content-range') };
        };
        const expectBytes = (range, got, want) =>
            assert(got.length === want.length && Buffer.compare(got, want) === 0,
                `${range}: body does not match disk bytes (got ${got.length}, want ${want.length})`);

        const head = await ranged('bytes=0-499');
        expectBytes('bytes=0-499', head.body, disk.subarray(0, 500));

        const mid = await ranged('bytes=100000-100999');
        expectBytes('bytes=100000-100999', mid.body, disk.subarray(100000, 101000));

        // suffix form means "last N bytes", not 0..N (RFC 7233 §2.1)
        const suffix = await ranged('bytes=-4096');
        assert(suffix.cr === `bytes ${size - 4096}-${size - 1}/${size}`,
            `bytes=-4096: wrong Content-Range "${suffix.cr}" for size ${size}`);
        expectBytes('bytes=-4096', suffix.body, disk.subarray(size - 4096));

        const tail = await ranged(`bytes=${size - 1000}-`);
        expectBytes(`bytes=${size - 1000}-`, tail.body, disk.subarray(size - 1000));

        for (const range of ['bytes=-0', `bytes=${size}-`]) {
            const r = await fetch(url, { headers: { Range: range } });
            assert(r.status === 416, `${range}: expected 416, got ${r.status}`);
        }
    });

    await check('app-password gate: prompt, reject wrong, accept right', async page => {
        await page.goto(`${GATED}/?path=/`, { waitUntil: 'load' });
        await page.waitForSelector('#pwin', { timeout: 10000 });
        await page.fill('#pwin', 'wrong-password');
        await page.click('.setup form button');
        await page.waitForSelector('#pwin[aria-invalid="true"]', { timeout: 10000 });
        await page.fill('#pwin', APP_PW);
        await page.click('.setup form button');
        await page.waitForSelector('#folders a[data-path]', { timeout: 10000 });
    });

    await check('single-file docs build loads clean and plays the demo', async page => {
        await page.goto(`${DOCS}/`, { waitUntil: 'load' });
        await page.waitForSelector('.track', { timeout: 20000 });
        // the committed demo is the Salmo 150 choir set — all four voices must render
        const names = await page.$$eval('.track .nm', els => els.map(e => e.textContent));
        for (const voice of ['Alto', 'Bass', 'Soprano', 'Tenor']) {
            assert(names.includes(`Salmo 150 ${voice}`),
                `missing demo track "Salmo 150 ${voice}" in [${names}]`);
        }
        assert(names.length === 4, `expected 4 demo tracks, got ${names.length}`);
        // decode finished → play enabled, duration is real (not 0:00)
        await page.waitForSelector('#play:not([disabled])', { timeout: 30000 });
        const t0 = await page.textContent('#time');
        assert(!/\/\s*0:00\s*$/.test(t0), `demo duration missing: "${t0}"`);
        // playback actually advances the seek fill
        await page.click('#play');
        await page.waitForFunction(() =>
            parseFloat(document.querySelector('#seek b')?.style.width || '0') > 1,
            { timeout: 10000 });
    });
} catch (e) {
    console.log(RED(`suite error: ${e.message || e}`));
    exitCode = 1;
} finally {
    if (browser) await browser.close();
    for (const p of phpProcs) p.kill();
    await rm(fixtureRoot, { recursive: true, force: true });
}

if (failed) exitCode = 1;
console.log(exitCode === 0
    ? GREEN(`\nAll ${passed} browser checks passed`)
    : RED(`\nFAILED — ${failed} of ${passed + failed} checks`));
process.exit(exitCode);
