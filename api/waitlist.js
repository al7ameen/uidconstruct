/**
 * Waitlist capture — zero external dependencies.
 *
 * Emails are written to the function log (Vercel dashboard > Logs, search
 * "waitlist:") which is the cheapest thing that actually delivers addresses
 * to us today. Swap the sink for Resend/Airtable/Postgres once there is
 * volume; the request contract stays identical.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// same in-memory pattern as the main endpoint: a burst guard, not a ledger
const hits = new Map();
const WINDOW_MS = 3600000;
const MAX_PER_IP = 20;

function rateLimit(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
    if (arr.length >= MAX_PER_IP) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

    const email = String((req.body && req.body.email) || '').trim().toLowerCase();

    if (!EMAIL_RE.test(email) || email.length > 254) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (!rateLimit(ip)) {
        return res.status(429).json({ error: 'Too many submissions. Try again later.' });
    }

    // The only durable sink we have right now. Never log IPs or any other PII.
    console.log('waitlist:', JSON.stringify({ email, ts: new Date().toISOString() }));

    return res.status(200).json({ ok: true });
};
