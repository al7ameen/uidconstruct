// lib/cache.js — per-instance result cache + in-flight request coalescing.
//
// Why this exists (measured, not theorised): a burst of 12 concurrent
// analyses of the SAME url produced 0 successes. The ceiling was not Vercel
// concurrency — it was an upstream 429 from the free AI tier, because each
// request holds an invocation for 14-25s and every repeat re-pays the full
// fetch + AI cost. A local semaphore cannot fix an external rate limit; the
// only fix that helps is to stop making redundant calls.
//
// Two mechanisms:
//   1. TTL cache  — a repeat of a recently-analysed URL costs ~0ms and 0 AI tokens.
//   2. Coalescing — simultaneous duplicates await the FIRST caller's promise
//      instead of each firing their own AI call. This is the one that saves a
//      launch-day spike, where the duplicates arrive before anything is cached.
//
// Scope honesty: this is per warm instance. A cold start empties it, and N
// concurrent instances each hold their own copy. It is not a distributed
// cache and must not be described as one. It is deliberately in-memory: no
// secret, no user data, and every value is derived from a public URL.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 3600e3); // 6h
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 60);
const CACHE_MAX_VALUE_BYTES = 200e3; // a spec is ~4-8KB; this only guards against a pathological response

const store = new Map();    // key -> { value, exp }
const pending = new Map();  // key -> Promise<value>

// Provider and model are part of the key so a BYOK run is never served to a
// user on a different model — they would get output they did not ask for.
function cacheKey(url, byok) {
    if (!byok) return 'free|' + url;
    // 'custom' is one provider name covering thousands of hosts, so
    // provider+model alone would serve user A's OpenRouter output to a user
    // on Groq who asked for the same model string. The host is not secret and
    // never includes the key.
    let host = '';
    if (byok.provider === 'custom' && byok.baseUrl) {
        try { host = new URL(byok.baseUrl).host; } catch { host = String(byok.baseUrl).slice(0, 60); }
    }
    return [byok.provider, host, byok.model].filter(Boolean).join(':') + '|' + url;
}

function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { store.delete(key); return null; }
    // touch: Map keeps insertion order, so re-inserting makes this an LRU
    store.delete(key);
    store.set(key, hit);
    return hit.value;
}

function set(key, value) {
    let bytes = 0;
    try { bytes = JSON.stringify(value).length; } catch (_) { return; } // unserializable -> don't cache
    if (bytes > CACHE_MAX_VALUE_BYTES) return;
    store.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
    while (store.size > CACHE_MAX_ENTRIES) {
        store.delete(store.keys().next().value); // evict least recently used
    }
}

/**
 * Run `producer`, serving a cached value or a sibling's in-flight attempt when
 * either exists. Returns { value, source } where source is hit|shared|miss.
 * Failures are never cached and never shared beyond the waiters already waiting.
 */
async function remember(key, producer) {
    const hit = get(key);
    if (hit) return { value: hit, source: 'hit' };

    const inflight = pending.get(key);
    if (inflight) {
        // Await the original rather than firing a second AI call. If it fails,
        // this caller fails too — correct behaviour while the provider is
        // rate-limited: retrying in lockstep is what got us 7x HTTP 500.
        return { value: await inflight, source: 'shared' };
    }

    const p = (async () => {
        const value = await producer();
        set(key, value);
        return value;
    })();
    pending.set(key, p);
    try {
        return { value: await p, source: 'miss' };
    } finally {
        pending.delete(key);
    }
}

// Test seam. Without it, every "clear" call in the suite is a no-op and cache
// state leaks between sections -- which hides bugs whenever two sections happen
// to use the same URL.
function clear() {
    store.clear();
    pending.clear();
}

function stats() {
    return { entries: store.size, inflight: pending.size };
}

module.exports = { CACHE_MAX_ENTRIES, CACHE_TTL_MS, cacheKey, clear, get, remember, set, stats };
