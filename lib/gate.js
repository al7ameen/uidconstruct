// lib/gate.js — caps how many free-tier AI calls one instance runs at once.
//
// Why the cache is not enough. remember() collapses duplicate URLs, but a
// launch spike is a hundred people pasting a hundred DIFFERENT sites. Those
// never share a cache key, so each one fires its own call at api.b.ai — and the
// measured result of 12 simultaneous calls was 7x HTTP 500 and 5 timeouts:
// stampeding a rate limit gets you all killed, not some through.
//
// A gate cannot raise the provider's limit. What it changes is the shape of the
// failure: instead of N concurrent calls that the provider rejects wholesale,
// a couple go through and the rest either wait briefly or get an honest 429
// with a Retry-After. Fewer total successes than an unloaded system, but far
// more than zero — and nobody is told the site is broken.
//
// Scope honesty, same as the cache: this is per warm instance. Vercel may run
// several, so the real ceiling is MAX_CONCURRENT_AI x instances. It is a
// stampede dam, not a distributed scheduler.
const MAX_CONCURRENT_AI = Number(process.env.MAX_CONCURRENT_AI || 2);
const QUEUE_WAIT_MS = Number(process.env.AI_QUEUE_WAIT_MS || 12000);

// Thrown when a slot never came free. Distinct from ProviderRateLimitError:
// that means the provider said no, this means we declined to ask rather than
// join a queue we would lose. Both surface to the client as 429.
class GateFullError extends Error {
    constructor(retryAfterSec) {
        super('We are busy analyzing other sites right now. Try again in about '
            + retryAfterSec + ' seconds — or add your own API key below to skip the queue.');
        this.name = 'GateFullError';
        this.retryAfterSec = retryAfterSec;
    }
}

let active = 0;
const waiting = [];   // FIFO of { resolve, timer }

// Node is single-threaded, so there is no race between the check and the
// increment; the whole function body runs to completion before any other
// request is scheduled.
function acquire() {
    if (active < MAX_CONCURRENT_AI) {
        active++;
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
            const i = waiting.indexOf(entry);
            if (i !== -1) waiting.splice(i, 1);   // timed out: stop being served
            resolve(false);
        }, QUEUE_WAIT_MS);
        waiting.push(entry);
    });
}

// Hand the slot straight to the next waiter instead of dropping to 0 and
// letting a fresh arrival cut in line ahead of someone already waiting.
function release() {
    if (waiting.length) {
        const next = waiting.shift();
        clearTimeout(next.timer);
        next.resolve(true);   // active stays the same: slot transferred
        return;
    }
    active--;
}

/**
 * Run fn with at most MAX_CONCURRENT_AI free-tier AI calls in flight.
 * BYOK callers bypass this entirely: they hit their own provider with their own
 * quota, so making them queue behind our free key would be punishing the one
 * category of user we want to keep happy.
 */
async function withAiGate(fn, { bypass = false } = {}) {
    if (bypass) return fn();
    const got = await acquire();
    if (!got) {
        throw new GateFullError(Math.max(10, Math.round(QUEUE_WAIT_MS / 1000)));
    }
    try {
        return await fn();
    } finally {
        release();
    }
}

function stats() {
    return { active, waiting: waiting.length, max: MAX_CONCURRENT_AI };
}

module.exports = { GateFullError, MAX_CONCURRENT_AI, QUEUE_WAIT_MS, stats, withAiGate };
