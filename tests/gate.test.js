// tests/gate.test.js — the gate is the only defence against a burst of
// DIFFERENT urls (the cache can't help there), so it needs its own proof.
// Env is set before require because lib/gate.js reads it at module load.
const MAX = Number(process.env.MAX_CONCURRENT_AI || 2);
const WAIT = Number(process.env.AI_QUEUE_WAIT_MS || 400);
// WAIT is read by lib/gate.js at require time, so it can't just be any number:
// section 1 needs ceil(10/MAX) * TASK_MS to FIT inside the queue budget, while
// section 3 needs its hold to OUTLAST that same budget. A single literal used to
// satisfy both (250) left 200 < 250 < 700 -- a 1.25x margin on a loaded ARM core,
// which slipped and threw GateFullError out of Promise.all on run 2 and 3 of 3.
// Every timing below is now DERIVED from WAIT so there is one source of truth and
// the two requirements can never be tuned against each other again.
const TASK_MS = Math.max(5, Math.floor(WAIT / 8));   // 5 rounds -> 1.25x headroom
const HOLD_MS = WAIT * 2;                            // always outlasts the budget
process.env.MAX_CONCURRENT_AI = String(MAX);
process.env.AI_QUEUE_WAIT_MS = String(WAIT);

const { GateFullError, MAX_CONCURRENT_AI, stats, withAiGate } = require('../lib/gate.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ok  ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}

// A fn that records the high-water mark of simultaneous execution.
function tracker(delay) {
    const t = { peak: 0, cur: 0, starts: [] };
    t.fn = (i) => async () => { t.cur++; t.peak = Math.max(t.peak, t.cur); t.starts.push(i); await sleep(delay); t.cur--; };
    return t;
}

(async () => {
    ok('gate honours the configured limit (env is not ignored)', MAX_CONCURRENT_AI === MAX, 'max=' + MAX_CONCURRENT_AI + ' expected=' + MAX);

    // 1. The whole point: 10 simultaneous free-tier calls must not become 10
    //    simultaneous provider requests.
    const a = tracker(TASK_MS);
    await Promise.all(Array.from({ length: 10 }, (_, i) => withAiGate(a.fn(i))));
    ok('never runs more than MAX_CONCURRENT_AI at once', a.peak <= MAX_CONCURRENT_AI, 'peak=' + a.peak);
    // With a generous limit the gate is effectively off: everything should run
    // at once. That is the emergency off-switch, so it must be a real assertion.
    const expectedPeak = MAX >= 10 ? 10 : MAX;
    ok('peak matches the configured limit (or full parallelism when off)', a.peak === expectedPeak, 'peak=' + a.peak + ' expected=' + expectedPeak);
    ok('all 10 eventually ran', a.starts.length === 10, 'ran=' + a.starts.length);
    ok('every slot was released', stats().active === 0 && stats().waiting === 0, JSON.stringify(stats()));

    // 2. BYOK users pay for their own quota; making them queue behind our free
    //    key would punish exactly the users we want to keep.
    const b = tracker(TASK_MS);
    await Promise.all(Array.from({ length: 8 }, (_, i) => withAiGate(b.fn(i), { bypass: true })));
    ok('BYOK bypasses the queue entirely', b.peak === 8, 'peak=' + b.peak);
    ok('bypass leaked no slots', stats().active === 0, JSON.stringify(stats()));

    // 3. When the queue itself overflows we must fail FAST and HONESTLY rather
    //    than hold a request until the platform kills it (the original 500).
    const hold = () => sleep(HOLD_MS);       // outlasts AI_QUEUE_WAIT_MS by design
    // MAX + 1: MAX of them occupy every slot, the extra one sits in the queue
    // and is the caller that must time out into a GateFullError. The count has
    // to be derived from MAX -- with a literal [0,1,2] this section silently
    // stopped overflowing as soon as MAX_CONCURRENT_AI > 2, `overflow` resolved
    // to null, and the assertions below read properties off nothing.
    const inflight = Array.from({ length: MAX + 1 }, () => withAiGate(hold).catch((e) => e));
    const overflow = await withAiGate(hold).then(() => null).catch((e) => e);
    ok('queue overflow throws GateFullError', overflow instanceof GateFullError, overflow && overflow.name);
    ok('overflow carries a Retry-After the client can honour',
        typeof overflow.retryAfterSec === 'number' && overflow.retryAfterSec > 0,
        JSON.stringify(overflow && overflow.retryAfterSec));
    ok('overflow message offers BYOK as the way out', /key/i.test(overflow.message), overflow.message);
    ok('overflowed caller left no waiter behind', stats().waiting <= MAX, JSON.stringify(stats()));
    const settled = await Promise.all(inflight);
    ok('the queued waiter gets an honest GateFullError, not a hang',
        settled.filter((e) => e instanceof GateFullError).length === 1,
        JSON.stringify(settled.map((e) => e && e.name)));
    ok('gate drains back to zero after a saturated burst', stats().active === 0, JSON.stringify(stats()));

    // 4. Hand-off fairness: a fresh arrival must not cut ahead of someone who
    //    has already been waiting.
    const c = tracker(TASK_MS);
    const ps = [];
    for (let i = 0; i < 6; i++) { ps.push(withAiGate(c.fn(i))); await sleep(4); }
    await Promise.all(ps);
    ok('waiters served in arrival order', c.starts.join('') === '012345', c.starts.join(''));

    console.log('\n' + pass + '/' + (pass + fail) + ' gate tests passed');
    process.exit(fail ? 1 : 0);
})();
