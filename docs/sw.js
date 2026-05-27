const CACHE_PREFIX = 'syncplayer-offline';
const CACHE_NAME = CACHE_PREFIX + '-v1779900805';

function shellUrl() {
    return new URL('./', self.registration.scope).toString();
}

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetch(shellUrl(), { cache: 'reload' });
            if (response.ok) await cache.put(shellUrl(), response);
        } catch (_) {}
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

async function authTag(url) {
    const pw = url.searchParams.get('password') || '';
    const appPw = url.searchParams.get('app_password') || '';
    if (!pw && !appPw) return '';
    const data = new TextEncoder().encode(`${appPw}\n${pw}`);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash).slice(0, 12)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function cacheKeyFor(request) {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return null;
    url.hash = '';
    const tag = await authTag(url);
    url.searchParams.delete('password');
    url.searchParams.delete('app_password');
    if (tag) url.searchParams.set('_auth', tag);
    return url.toString();
}

function shouldHandle(request) {
    if (request.method !== 'GET') return false;
    if (request.headers.has('range')) return false;
    const url = new URL(request.url);
    return url.origin === self.location.origin && (url.protocol === 'http:' || url.protocol === 'https:');
}

self.addEventListener('fetch', event => {
    if (!shouldHandle(event.request)) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const key = await cacheKeyFor(event.request);
        try {
            const response = await fetch(event.request);
            if (response.ok) {
                // cache.put() can throw NetworkError for large streaming responses;
                // catch it so a caching failure never kills the actual fetch.
                if (key) try { await cache.put(key, response.clone()); } catch (_) {}
                if (event.request.mode === 'navigate') try { await cache.put(shellUrl(), response.clone()); } catch (_) {}
                return response;
            }
            // Upstream failure (e.g. PHP server is reachable but its curl to
            // Nextcloud failed → 500 with {error:"Error: N"}). Prefer the last
            // known-good cached response over surfacing the upstream error.
            if (response.status >= 500) {
                if (key) {
                    const cached = await cache.match(key);
                    if (cached) return cached;
                }
                if (event.request.mode === 'navigate') {
                    const fallback = await cache.match(shellUrl());
                    if (fallback) return fallback;
                }
            }
            return response;
        } catch (error) {
            if (key) {
                const cached = await cache.match(key);
                if (cached) return cached;
            }
            if (event.request.mode === 'navigate') {
                const fallback = await cache.match(shellUrl());
                if (fallback) return fallback;
            }
            throw error;
        }
    })());
});
