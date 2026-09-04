// lib/rate.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


// ============================================================
// RATE LIMIT — per-IP, in-memory (resets on cold start; burst guard)
// ============================================================
const RATE_LIMIT = 10;          // requests

const RATE_WINDOW_MS = 3600e3;  // per hour

const hits = new Map();         // ip -> [timestamps]


function rateLimit(ip, limit) {
    const cap = limit || RATE_LIMIT;
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= cap) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
}


function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
           req.headers['x-real-ip'] || 'unknown';
}


module.exports = { RATE_LIMIT, RATE_WINDOW_MS, getClientIp, hits, rateLimit };
