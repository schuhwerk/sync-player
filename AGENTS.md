# Sync Player

Web-Audio-API player that plays all audio tracks in a folder synchronously,
with per-track + master volume, seekable waveforms, and browser-side caching.
Source is pluggable via adapters: **Nextcloud public share** or **local
filesystem**. One deployment = one source.

Two deployment shapes from one source tree:

1. **PHP server** (Nextcloud/local, YunoHost-friendly): `index.php` + `style.css` + `app.js`
   (serves the bun-bundled `app.js` as a single ES module script).
2. **Single-file** (works from `file://`): `docs/index.html`, produced by
   `php build.php`. File System Access API, with drag-drop FileSystemEntry
   fallback for Firefox/Safari.

No npm. PHP only on the server target; the built artifact is pure HTML.

## Run

    php -S localhost:8000              # server target, open /?path=/
    php build.php                      # → app.js (bun) + docs/index.html
    php -S localhost:8001 -t docs      # preview docs as GH Pages would

Dev watch (rebuilds `app.js` in ~10ms on every `src/*.js` save, no `php build.php` needed):

    bun build src/main.js --bundle --format=esm --target=browser --outfile=app.js --watch

Settings flow: defaults in `index.php` → `config.php` → `SYNCPLAYER_*` env
(env wins — works with YunoHost's my_webapp_ynh admin panel without SSH).
`SYNCPLAYER_CONFIG` relocates the config file (point it at `/dev/null` for
pure defaults + env — the browser suite does this); `SYNCPLAYER_LOCAL_ROOT`
overrides the local adapter's root folder.

`build.php` is CLI-only (refuses HTTP via `PHP_SAPI !== 'cli'`). Shells out to
`bun build src/main.js --bundle --format=esm --target=browser --outfile=app.js`
to produce the flat `app.js`, then inlines `style.css` + that bundle +
`adapters/browser-fs.js` + the html-shell region from `index.php` into
`docs/index.html`.

**Never edit `docs/index.html`, `docs/sw.js`, `docs/manifest.webmanifest`,
or `app.js` directly — they are build outputs.** `app.js` is bun-bundled from
the entry point `src/main.js`. Edit the sources (`index.php`, `style.css`,
`src/*.js`, `adapters/browser-fs.js`, `sw.js`) and run `php build.php` to
regenerate. The IDE may open `docs/index.html` for inspection; treat it as
read-only.

### GitHub Pages demo

`docs/` is tracked (not gitignored). Pages → "Branch: main, folder: /docs".
If `docs/demo/` exists at build time with audio files, `build.php` embeds a
static manifest at `CFG.demo = { baseUrl: 'demo/', files: [...] }`. The
browser-fs adapter sees this, sets `rootStatic`, skips the picker. Drag-drop
remains live: dropping a folder dispatches `sync-root-changed`, which
replaces the static root.

## Source map (grep regions)

Code is split into `// ## name — description` heading comments (no closing
marker — each section runs until the next `// ##` line). **Grep the headings
instead of citing line numbers.** The `css` and `html-shell` blocks in
`index.php` use `<!-- #region X -->` / `<!-- #endregion X -->` because
`build.php` splices them by name.

PHP (`index.php`):
- `php-config` — config layering, audio extensions, request validation.
  Settings land in `$ADAPTER`, `$NEXTCLOUD`, `$LOCAL`.
- `php-adapter` — `Adapter` abstract class + `NextcloudAdapter` /
  `LocalAdapter`. Both expose `id()`, `cloudUrl($path)` (null for local),
  `list($path, $password)`, `fetch($path, $password)`.
- `php-list` — `?mode=list` → `{folders, files: [{name, path, lm}]}`.
- `php-fetch` — `?mode=fetch` streams with Range + cache-validator passthrough.
  Serves only what `list()` exposes: audio + attachment extensions; paths with
  dot-leading segments (and `..`) are rejected in `php-config` for all modes.

JS modules (`src/*.js`) — load order is resolved by the bundler from the
`src/main.js` entry point graph. Remaining circular deps (e.g.
`waveform` → `ui` → `waveform`) are safe under bundling because the
cross-module calls happen inside function bodies, not at eval time.

- `src/config.js` (`js-config`) — reads `window.CFG`. Defines `api()` /
  `loadBytes()` as `window.SyncBackend?.{api,loadBytes}` with HTTP fallbacks —
  the one indirection that lets the same code work for both targets.
- `src/cache.js` (`js-cache`) — IndexedDB `syncplayer.waveforms` + a
  tab-scoped RAM LRU for raw bytes. Keys stay `${path}::${lm}`.
- `src/tree.js` (`js-tree`) — folder tree built from visited + cached
  listings (no eager subtree crawl on navigation); flat map feeds the
  folder filter. `fetchTree(path, Infinity)` does a full recursive crawl,
  used only by the offline pin. The filter additionally fires one on-demand
  server-side recursive search (`?mode=search`) when the user types.
- `src/player.js` (`js-player`) — `SyncPlayer` class + the shared `player`
  singleton (`export let player`) + `setPlayer()`. One `AudioContext`, one
  persistent `GainNode` per track; `AudioBufferSourceNode`s recreated on
  play/seek (they are one-shot). `onChange(state)` drives UI re-render.
- `src/waveform.js` (`js-waveform`) — DPR-aware canvas waveform rendering.
  `takeWfFullRepaint()` consumed once per `onPlayerChange` tick.
- `src/basetones.js` (`js-basetones`) — per-track base-tone tuning + folder
  description/metadata. `setBaseToneDirty(v)` setter used by `flushBeforeNavigate`.
- `src/offline.js` (`js-offline`) — "Available offline" toggle. Eagerly
  fetches audio into IDB; calls `navigator.storage.persist()` on first pin.
- `src/stage.js` (`js-stage`) — spatial mix: tracks on a circle + draggable
  listener; distance drives volume.
- `src/main.js` — bundle entry point. Imports `main` from `ui.js` and calls it.
- `src/ui.js` (`js-ui`) — `main()` (startup), `init()`, `renderView()`, `navigate()`,
  `flushBeforeNavigate()`, `bindControls()`, `setHeader()`, `renderAuth()`.
  Keyboard: Space=toggle, ←/→=seek 5s (Shift=10s), m=mute, r=repeat.

`app.js` is a **generated file** (bun-bundled from `src/main.js` by `build.php`).
Never edit it directly.

## Tests

`bun test` — pure-logic + player suites under `test/*.test.js` (no DOM, no
build). `test/player.test.js` exercises `SyncPlayer` against a
`MockAudioContext` (mobile first-play, desktop play, pause→play, re-entrancy);
its browser shims + mocks live in `test/player.setup.js`, imported first so
`config.js`/`cache.js` find `window.CFG` at eval time. `stage-math`,
`offline-math`, `waveform-math`, and `store` cover the extracted pure logic.

`bash test/run.sh` — browser suite (headless Chromium via Playwright) for
what `bun test` can't cover: the real module graph + real
`decodeAudioData`/playback end-to-end. `test/run.mjs` spawns its own PHP
servers (fixture-backed local adapter via `SYNCPLAYER_LOCAL_ROOT` +
`SYNCPLAYER_CONFIG=/dev/null`, an app-password-gated twin, and `docs/` for
the single-file build) over WAV fixtures generated by `test/fixtures.mjs`
into a temp dir. Checks: folder listing, navigation → tracks, decode →
play/pause (seek fill moves), keyboard (Space/r/m), attachments (IMG/PDF
chips, ⋮ menu, inline "Show here" toggle, fullscreen + Esc), `?mode=fetch`
Range semantics (explicit, suffix `-N`, unsatisfiable → 416), the app-password
gate (reject + accept), and that the docs build boots, renders all four
Salmo 150 demo tracks, decodes, and playback advances.
First run installs Playwright into `test/node_modules` (gitignored).

Browser adapter (`adapters/browser-fs.js`):
- Implements `api()`, `loadBytes()`, `ready()`, `renderPicker()`. Three
  possible roots, checked in order: `rootStatic` (build-time demo),
  `rootHandle` (showDirectoryPicker), `rootEntry` (drag-drop). Global
  drag-drop listener can replace any active root and dispatches
  `sync-root-changed`.

## Caching strategy

| What                | Where             | Key                         | Invalidation            |
| ------------------- | ----------------- | --------------------------- | ----------------------- |
| Encoded audio bytes (session) | RAM LRU | `${path}::${lm}` | tab close / LRU eviction |
| Encoded audio bytes | Browser HTTP cache | request URL                 | PHP forwards Last-Modified / ETag → 304 |
| Encoded audio bytes (pinned) | IndexedDB `audio` | `${path}::${lm}`     | unpin evicts; new `lm` writes new entry |
| Waveform peaks      | IndexedDB          | `${path}::${lm}`            | `lm` changes → new key  |
| Folder listings + search + meta | IndexedDB `listings` | `list::${path}` / `search::${path}::${q}` / `load-meta::${path}` | overwritten on next successful fetch; served as `_stale: true` on failure |
| Offline pin marker  | IndexedDB `pinned` | folder path                 | manual unpin            |
| Static shell + recent HTTP | SW Cache    | URL + auth tag (sw.js)      | SW falls back on 5xx / throw |
| Decoded AudioBuffer | RAM only           | —                           | tab close               |
| Share password      | sessionStorage     | `spw_<adapterId>`           | tab close               |
| App password        | sessionStorage     | `apw_<adapterId>`           | tab close               |

`lm` (Last-Modified) comes from the adapter — WebDAV PROPFIND for Nextcloud,
`filemtime()` (RFC-7231) for local. No ETag client-side — WebDAV ETags can
change for non-content reasons.

## Auth model

Two independent server-side passwords (no effect on the built artifact):

- **App password** (`app_password`) — gates `?mode=list|search|fetch`. Empty
  = no gate. Sent as `app_password=…`. 401 → `{error:'app_password_required',
  hint}`. HTML shell is intentionally not gated; first list call triggers
  the 401 and `renderAuth({app:true})`.
- **Nextcloud share password** (`nextcloud.password`) — *default* for
  `NextcloudAdapter`. A visitor's `password=…` param overrides it (lets
  visitors recover from a stale configured pw). 401 → `{error:
  'password_required', hint}`.

Both share `renderAuth({app, hint})`. Hints are config-supplied free text,
`escapeHtml`'d. `hash_equals` for time-safe compare.

## Sync model

All tracks share one `AudioContext`. Play creates fresh `BufferSource`s and
starts each with `start(0, currentTime)` — same audio clock tick, no drift.
`currentTime` is tracked in JS (perf-clock delta) because
`AudioBufferSourceNode` doesn't expose elapsed time. Seek = stop + recreate.

## Conventions

- Vanilla JS, ES2020. PHP 8+. `build.php` is the only build step.
- Region headings (`// ## name`) survive edits; grep them, don't cite lines.
- Keep regions narrow. Add a new region rather than growing one past a screen.
- Both backends speak the same shapes (`{folders, files}`, `{error}`,
  `{_auth: true}`). Shared helpers (`api()`, `loadBytes()`, `escapeHtml()`,
  `fmt()`) live in `js-config`, not duplicated.
- Comments only for non-obvious *why* (e.g. the slider `overflow:hidden +
  thumb box-shadow` fill trick, the source-recreation requirement).

## Reference projects

- `../../2023/230315-chor-player/` — original sync player
  (`src/wap/web-api-player.ts`, `src/wap/lit-test.tsx`). UX modelled after it.
- `../../../Local-Work/doll/spaces.kisd/spaces-kisd/web/app/plugins/nextcloud-viewer/viewer.php`
  — Nextcloud public-share proxy (PROPFIND, Range fetch). PHP regions in
  `index.php` follow the same pattern.
