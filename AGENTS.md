# Sync Player

Web-Audio-API player that plays all audio tracks in a folder synchronously,
with per-track + master volume, seekable waveforms, and browser-side caching.
Source is pluggable via adapters: **Nextcloud public share** or **local
filesystem**. One deployment = one source.

Two deployment shapes from one source tree:

1. **PHP server** (Nextcloud/local, YunoHost-friendly): `index.php` + `style.css` + `app.js`.
2. **Single-file** (works from `file://`): `dist/index.html`, produced by
   `php build.php`. File System Access API, with drag-drop FileSystemEntry
   fallback for Firefox/Safari.

No npm. PHP only on the server target; the dist is pure HTML.

## Run

    php -S localhost:8000              # server target, open /?path=/
    php build.php                      # → dist/index.html
    php -S localhost:8001 -t dist      # preview dist as GH Pages would

Settings flow: defaults in `index.php` → `config.php` → `SYNCPLAYER_*` env
(env wins — works with YunoHost's my_webapp_ynh admin panel without SSH).

`build.php` is CLI-only (refuses HTTP via `PHP_SAPI !== 'cli'`). Inlines
`style.css` + `app.js` + `adapters/browser-fs.js` + the html-shell region
from `index.php` into `dist/index.html` by pure string concatenation.

### GitHub Pages demo

`dist/` is tracked (not gitignored). Pages → "Branch: main, folder: /dist".
If `dist/demo/` exists at build time with audio files, `build.php` embeds a
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

JS (`app.js`):
- `js-config` — reads `window.CFG`. Defines `api()` / `loadBytes()` as
  `window.SyncBackend?.{api,loadBytes}` with HTTP fallbacks — the one
  indirection that lets the same `app.js` work for both targets.
  `navigate()` uses `pushState` when SyncBackend is present (root folder
  lives in memory; reload would lose it), `location.search =` otherwise.
- `js-cache` — IndexedDB `syncplayer.waveforms`. Key `${path}::${lm}`.
- `js-player` — `SyncPlayer` class. One `AudioContext`, one persistent
  `GainNode` per track; `AudioBufferSourceNode`s recreated on play/seek
  (they are one-shot). `onChange(state)` drives UI re-render. 120ms tick.
- `js-waveform` — `drawWaveform(canvas, peaks, played01)`, DPR-aware.
- `js-offline` — "Available offline" toggle. Eagerly fetches audio +
  attachments into IDB `audio` store (`${path}::${lm}`); `SyncPlayer.load`
  checks there first. Pin marker in IDB `pinned`. Calls
  `navigator.storage.persist()` on first pin.
- `js-ui` — `init()`, `renderView()` (folders + player; either may be
  empty), `playerHTML()`, `bindControls()`, `setHeader()`, `renderAuth()`.
  Keyboard: Space=toggle, ←/→ = seek 5s (Shift=10s), m=mute, r=repeat.

Browser adapter (`adapters/browser-fs.js`):
- Implements `api()`, `loadBytes()`, `ready()`, `renderPicker()`. Three
  possible roots, checked in order: `rootStatic` (build-time demo),
  `rootHandle` (showDirectoryPicker), `rootEntry` (drag-drop). Global
  drag-drop listener can replace any active root and dispatches
  `sync-root-changed`.

## Caching strategy

| What                | Where             | Key                         | Invalidation            |
| ------------------- | ----------------- | --------------------------- | ----------------------- |
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

Two independent server-side passwords (no effect on dist):

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
