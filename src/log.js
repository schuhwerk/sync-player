// ## js-log — leveled logger; toggle via ?log=… or localStorage('syncplayer.log')
//
// Why this exists: module-eval order, cycles, lazy state propagation, and SW
// behavior are hard to reason about from a single console.log. A namespaced
// leveled logger lets us leave instrumentation in place at debug level (silent
// in prod) and flip it on per-namespace when a regression appears.
//
// Usage:
//
//   import { logger } from './log.js';
//   const log = logger('tree');
//   log.debug('refresh start', { path });
//   log.info('loaded', () => ({ count: heavy() }));  // lazy: only invoked if level ≤ info
//
// Toggle:
//
//   ?log=debug                         all namespaces at debug
//   ?log=tree:debug                    only `tree` at debug; others at default (warn)
//   ?log=*:warn,tree:debug,ui:info     per-namespace
//   localStorage.setItem('syncplayer.log', 'debug')   persists across reloads
//   SyncLog.set('tree:debug')          from devtools, persists to localStorage
//   SyncLog.off()                      silence everything (default: warn)
//
// Output: `[LEVEL ns] message …`. Errors keep stack traces (passed as-is to
// console.error). Pass a function as any arg for lazy evaluation.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const DEFAULT_LEVEL = LEVELS.warn;

let _config = parseSpec(readStoredSpec());

function readStoredSpec() {
    try {
        const url = new URLSearchParams(location.search).get('log');
        if (url) return url;
    } catch (_) {}
    try {
        return localStorage.getItem('syncplayer.log') || '';
    } catch (_) { return ''; }
}

function parseSpec(spec) {
    const cfg = { default: DEFAULT_LEVEL, ns: Object.create(null) };
    if (!spec) return cfg;
    for (const raw of String(spec).split(',')) {
        const part = raw.trim();
        if (!part) continue;
        let ns, lvl;
        if (part.includes(':')) { [ns, lvl] = part.split(':', 2); ns = ns.trim(); lvl = lvl.trim(); }
        else { ns = '*'; lvl = part; }
        const level = LEVELS[lvl.toLowerCase()];
        if (level === undefined) continue;
        if (ns === '*') cfg.default = level;
        else cfg.ns[ns] = level;
    }
    return cfg;
}

function levelFor(ns) {
    return _config.ns[ns] ?? _config.default;
}

function emit(method, ns, levelName, args) {
    const evaluated = args.map(a => typeof a === 'function' ? safeCall(a) : a);
    // eslint-disable-next-line no-console
    console[method](`[${levelName} ${ns}]`, ...evaluated);
}
function safeCall(fn) { try { return fn(); } catch (e) { return `<log-eval-error: ${e.message}>`; } }

export function logger(ns) {
    return {
        debug: (...a) => { if (LEVELS.debug >= levelFor(ns)) emit('debug', ns, 'DEBUG', a); },
        info:  (...a) => { if (LEVELS.info  >= levelFor(ns)) emit('info',  ns, 'INFO',  a); },
        warn:  (...a) => { if (LEVELS.warn  >= levelFor(ns)) emit('warn',  ns, 'WARN',  a); },
        error: (...a) => { if (LEVELS.error >= levelFor(ns)) emit('error', ns, 'ERROR', a); },
        enabled: level => (LEVELS[level] ?? LEVELS.debug) >= levelFor(ns),
    };
}

export function setLogSpec(spec) {
    try { localStorage.setItem('syncplayer.log', spec || ''); } catch (_) {}
    _config = parseSpec(spec);
}

// Expose to devtools so users can flip levels without code changes.
try {
    window.SyncLog = {
        set: setLogSpec,
        off: () => setLogSpec(''),
        spec: () => readStoredSpec(),
        levels: { ...LEVELS },
    };
} catch (_) {}
