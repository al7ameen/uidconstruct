// lib/ai.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


const { sanitizeUrl } = require('./net.js');


// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    // Read lazily, not snapshotted at module load. Serverless sets env before
    // the handler is required so both work in production, but a load-time
    // snapshot silently reports "key missing" to any caller that configures
    // env afterwards -- which is exactly how the integration suite tripped over
    // it. A getter removes the ordering footgun instead of working around it.
    get API_KEY() { return process.env.OPENAI_API_KEY || ''; },
    BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    MODEL: process.env.OPENAI_MODEL || 'qwen3.8-flash',
    TIMEOUT_MS: 52000
};

// Free-tier models we are willing to fall back to, in order. Each model on this
// relay has its OWN rate-limit bucket, so on a 429 the fastest relief is to
// switch buckets rather than wait: Retry-After is typically ~30s and a single
// analysis already costs 14-25s, which would blow the 60s function budget.
// Override with FREE_FALLBACK_MODELS="a,b" if the free tier changes again.
const FREE_FALLBACK_MODELS = (process.env.FREE_FALLBACK_MODELS || 'qwen3.8-flash,glm-5.3-flash')
    .split(',').map(m => m.trim()).filter(Boolean);

// BYOK providers we will proxy to.
//
// The original comment here said an arbitrary base URL must never be accepted,
// because it turns this function into an SSRF proxy. That was correct when it
// was written and it is still the reason 'custom' is NOT a free-for-all: a
// custom URL goes through sanitizeUrl() (protocol + no embedded credentials +
// isPrivateHost) and must be https. The key it carries is a secret, so http
// would send it in cleartext even when the host itself is allowed.
const BYOK_PROVIDERS = {
    openai: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        auth: (key) => ({ 'Authorization': `Bearer ${key}` }),
        style: 'openai'
    },
    anthropic: {
        endpoint: 'https://api.anthropic.com/v1/messages',
        auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
        style: 'anthropic'
    },
    // endpoint is resolved per-request from the user's base URL; see resolveCustomTarget.
    custom: {
        endpoint: null,
        auth: (key, style) => (style === 'anthropic'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { 'Authorization': `Bearer ${key}` }),
        style: null
    }
};

// Which wire format a custom host speaks. Anthropic-shaped by hostname,
// everything else OpenAI-compatible - which covers OpenRouter, Groq, Together,
// Fireworks, DeepSeek, Mistral, xAI, Cerebras and most self-hosted gateways.
function detectStyle(hostname) {
    return /anthropic/i.test(String(hostname || '')) ? 'anthropic' : 'openai';
}

// Base URL in, full endpoint out. Accepts either a base ("https://api.groq.com/openai/v1")
// or a complete endpoint, because people paste both and double-appending is the
// single most likely way this feature fails for a user.
function resolveCustomTarget(rawBaseUrl) {
    const cleaned = sanitizeUrl(String(rawBaseUrl || '').trim());
    if (!cleaned) return null;
    let u;
    try { u = new URL(cleaned); } catch { return null; }
    // https only: this request carries the user's secret key.
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;

    const style = detectStyle(u.hostname);
    let path = u.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(path)) return { endpoint: u.origin + path, style };
    if (/\/messages$/.test(path)) return { endpoint: u.origin + path, style: 'anthropic' };
    const suffix = style === 'anthropic'
        ? (/\/v\d+$/.test(path) ? '/messages' : '/v1/messages')
        : '/chat/completions';
    return { endpoint: u.origin + path + suffix, style };
}


function normalizeByok(raw) {
    if (!raw || typeof raw.key !== 'string') return null;
    const key = raw.key.trim();
    // OpenAI keys are ~20-120 chars; Anthropic similar. Cap to keep logs/bodies sane.
    if (key.length < 20 || key.length > 200) return null;
    const provider = BYOK_PROVIDERS[raw.provider] ? raw.provider : null;
    if (!provider) return null;
    // A custom base URL is the one field we cannot hard-code, so it is the one
    // field that needs its own validation. Returns null for anything that is
    // not https, resolves to a private/link-local address, or carries embedded
    // credentials - the same guard the page fetcher uses.
    let custom = null;
    if (provider === 'custom') {
        custom = resolveCustomTarget(raw.baseUrl);
        if (!custom) return null;
    }
    // Model is REQUIRED. We deliberately do not guess a default: model IDs
    // change, entitlements differ per account, and a wrong default produces a
    // confusing provider error. Conservative charset = no URL/injection surface.
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    // '/' is required, not optional: OpenRouter and Together model IDs are always
    // "org/name" (openai/gpt-4o-mini, deepseek-ai/DeepSeek-V3). Excluding it made
    // the custom-provider feature silently fall back to the free tier for most of
    // the providers it exists for. Safe to allow: the model goes only into the
    // JSON body, never into a URL, so it carries no injection surface.
    if (!/^[\w.\-:/]{1,80}$/.test(model)) return null;
    return { provider, model, key, baseUrl: custom ? custom.endpoint : undefined, style: custom ? custom.style : BYOK_PROVIDERS[provider].style };
}

// ============================================================
// UTILITIES
// ============================================================

// Signals a caller-correctable problem (bad key / quota), so the handler can
// answer 4xx instead of 500 and the user doesn't think we are down.
class ByokAuthError extends Error {}

// Our OWN free-tier key is missing or rejected. Deliberately a distinct type
// from ByokAuthError: that means "you gave us a bad key" (401, user-fixable),
// this means "we have a bad key" (503, ours to fix). Collapsing the two is what
// made every visitor read "your API key was rejected" about a key they never
// supplied -- and throwing an undeclared error class turned that into a 500.
class FreeTierUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FreeTierUnavailableError';
    }
}

// The upstream provider said "too many requests". Distinct from a generic
// failure because the caller must answer 429 + Retry-After, not 500: a 500
// reads to a user as "uidconstruct is broken", which is both false and the
// worst possible message on launch day.
class ProviderRateLimitError extends Error {
    constructor(message, retryAfterSec) {
        super(message);
        this.name = 'ProviderRateLimitError';
        this.retryAfterSec = retryAfterSec || 30;
    }
}


// ============================================================
// MAIN HANDLER
// ============================================================
async function callAI(messages, byok, opts) {
    const o = opts || {};
    let url, headers, body;

    if (byok) {
        const p = BYOK_PROVIDERS[byok.provider];
        // 'custom' has no fixed endpoint; normalizeByok already validated and
        // resolved the user's URL into byok.baseUrl.
        url = byok.baseUrl || p.endpoint;
        const style = byok.style || p.style;
        headers = { 'Content-Type': 'application/json', ...p.auth(byok.key, style) };

        if (style === 'anthropic') {
            // Anthropic takes the system prompt as a sibling field, not a message
            const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
            body = {
                model: byok.model,
                system,
                messages: messages.filter(m => m.role !== 'system'),
                temperature: 0.3,
                max_tokens: 8000
            };
        } else {
            // No reasoning_effort here: it is rejected by non-reasoning models,
            // and the user chose this model, so we send only universal params.
            body = {
                model: byok.model,
                messages,
                temperature: 0.3,
                max_tokens: 4000
            };
        }
    } else {
        url = `${CONFIG.BASE_URL}/chat/completions`;
        headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.API_KEY}`
        };
        body = {
            model: o.model || CONFIG.MODEL,
            messages,
            temperature: 0.3,
            reasoning_effort: 'low',
            max_tokens: 8000
        };
    }

    // Checked before the request, not after it: an unset key is a configuration
    // fact. Asking the provider anyway wastes a round trip and gets back a 401
    // that looks exactly like a user error.
    if (!byok && !CONFIG.API_KEY) {
        console.error('FREE_TIER_KEY_MISSING: OPENAI_API_KEY is not set in this deployment');
        throw new FreeTierUnavailableError('Our free analysis is temporarily unavailable. Add your own API key below to keep going.');
    }

    const isCustom = !!(byok && byok.provider === 'custom');
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // Per-attempt timeout, not a fixed one: with a fallback chain the sum of
        // attempts must stay inside the function's 60s wall, so the caller hands
        // down a deadline and each try gets only what is left of it.
        signal: AbortSignal.timeout(o.timeoutMs || CONFIG.TIMEOUT_MS),
        // Custom URLs are user-supplied, so we never follow their redirects.
        // sanitizeUrl() proved the URL WE were given was public and https; a
        // 302 from that host could point anywhere, and this request carries the
        // user's secret key in a header. Re-validating each hop is not enough
        // either: any public host is allowed, so a redirect would still deliver
        // the key to an attacker. Refusing to follow is the only sound answer.
        redirect: isCustom ? 'manual' : 'follow'
    });

    if (isCustom && [301, 302, 303, 307, 308].includes(res.status)) {
        throw new ByokAuthError(
            `Your custom endpoint answered with a redirect (${res.status}). We do not follow redirects for custom API URLs, because doing so could send your key to a different host. Enter the final endpoint URL directly.`
        );
    }

    if (!res.ok) {
        // Truncate + never echo the request headers: the provider's error body
        // can contain fragments of the request, and we must not surface a key.
        const text = (await res.text()).slice(0, 300);
        if (res.status === 401 || res.status === 403) {
            if (byok) {
                throw new ByokAuthError('Your API key was rejected by the provider. Check the key and the model name, then try again.');
            }
            // No BYOK means this 401 is about OUR shared key. Telling a visitor
            // "your API key was rejected" when they never supplied one is both
            // untrue and unreadable — it sends them to fix something they do not
            // have. This is a config/outage event on our side, so it gets its own
            // error type (-> 503) and a loud log line.
            console.error('FREE_TIER_KEY_REJECTED:', JSON.stringify({ model: body.model, status: res.status }));
            throw new FreeTierUnavailableError('Our free analysis is temporarily unavailable. Try again shortly, or add your own API key below to keep going.');
        }
        if (res.status === 429) {
            // Honour the provider's own Retry-After when it sends one.
            const ra = parseInt(res.headers.get('retry-after'), 10);
            const retryAfterSec = Number.isFinite(ra) && ra > 0 && ra < 600 ? ra : 30;
            // Two different situations, previously one misleading message:
            // BYOK 429 = the user's own quota; free-tier 429 = OUR shared key
            // is saturated and the user did nothing wrong.
            throw new ProviderRateLimitError(
                byok
                    ? 'Your AI provider is rate-limiting this key. Wait a moment, or lower your request rate.'
                    : 'Our free analysis queue is full right now. Try again in about ' + retryAfterSec + ' seconds, or add your own API key below for unlimited runs.',
                retryAfterSec
            );
        }
        throw new Error(`AI provider error (${res.status}). ${byok ? 'Check your key, model name, and quota.' : 'Please try again.'} ${text.replace(/<[^>]*>/g, '')}`.slice(0, 400));
    }

    const data = await res.json();
    if (byok && (byok.style === 'anthropic' || byok.provider === 'anthropic')) {
        return data.content?.map(c => c.text || '').join('') || 'No response from AI.';
    }
    return data.choices?.[0]?.message?.content || 'No response from AI.';
}


/**
 * Free tier: try the configured model, then the other free models, then give up.
 *
 * Scope is deliberately narrow.
 *  - BYOK callers get exactly the model they asked for. If their key is
 *    rate-limited we say so; quietly answering with a different model would
 *    misrepresent what produced the spec.
 *  - Only ProviderRateLimitError triggers a retry. Any other failure is a real
 *    error and re-trying it against a second model just burns the clock.
 *  - Attempts are skipped once the deadline is close, so we return an honest
 *    429 with a Retry-After instead of being killed mid-flight by the platform.
 */
async function callAIWithFallback(messages, byok, opts) {
    const o = opts || {};
    if (byok) return callAI(messages, byok, o);

    const primary = o.model || CONFIG.MODEL;
    const chain = [primary, ...FREE_FALLBACK_MODELS.filter(m => m !== primary)];
    const deadlineAt = o.deadlineAt || (Date.now() + CONFIG.TIMEOUT_MS);
    const MIN_ATTEMPT_MS = 8000;   // below this a fresh attempt is more likely to be cut off than to finish

    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
        const left = deadlineAt - Date.now();
        if (i > 0 && left < MIN_ATTEMPT_MS) break;   // no time for another model: report what we already know

        try {
            return await callAI(messages, null, { ...o, model: chain[i], timeoutMs: Math.max(1000, Math.min(CONFIG.TIMEOUT_MS, left)) });
        } catch (err) {
            if (!(err instanceof ProviderRateLimitError)) throw err;
            lastErr = err;
            console.log('ai:', JSON.stringify({ model: chain[i], result: '429', attempt: i + 1, msLeft: deadlineAt - Date.now() }));
        }
    }
    throw lastErr || new ProviderRateLimitError('Our free analysis queue is full right now. Try again in a moment, or add your own API key below for unlimited runs.', 30);
}


module.exports = { BYOK_PROVIDERS, ByokAuthError, CONFIG, FREE_FALLBACK_MODELS, FreeTierUnavailableError, ProviderRateLimitError, callAI, callAIWithFallback, detectStyle, normalizeByok, resolveCustomTarget };

// A rejected BYOK payload currently falls back to the free tier silently. That
// is right for a half-open panel and WRONG for a user who did something specific:
// measured 2026-09-04, http://api.openai.com/v1 (plain http, the most common
// paste error there is) returns HTTP 200 with a real spec built by OUR key. The
// user believes their key worked. They are rate-limited at 10/hr believing they
// bought 60. This names the rejection instead of hiding it.
// Deliberately does NOT re-implement normalizeByok's checks - it calls it first,
// so the model charset and every other rule stay in exactly one place.
function diagnoseByok(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (normalizeByok(raw)) return null;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    // No key at all = the collapsible panel was simply left open. Silent
    // fallback is the correct, expected behaviour there.
    if (!key) return null;
    if (key.length < 20 || key.length > 200) {
        return 'That API key looks too short to be real (' + key.length +
            ' characters). Check for a missing character, or leave the key fields empty to use the free tier.';
    }
    if (!BYOK_PROVIDERS[raw.provider]) {
        return 'Unknown provider "' + String(raw.provider).slice(0, 24) +
            '". Choose OpenAI, Anthropic, or Custom.';
    }
    if (raw.provider === 'custom') {
        const bu = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
        if (!bu) return 'A custom endpoint needs a base URL, e.g. https://openrouter.ai/api/v1';
        if (!/^https:/i.test(bu)) {
            return 'Your base URL must start with https:// - "' + bu.slice(0, 60) +
                '" was rejected. Your key was NOT sent anywhere.';
        }
        return 'That base URL points at a private or internal address, so it was rejected. ' +
            'Your key was NOT sent anywhere - use your provider\'s public URL.';
    }
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!model) return raw.provider + ' needs a model name, e.g. gpt-4o-mini.';
    return 'We could not accept that model name ("' + model.slice(0, 40) +
        '"). Check it against your provider, or leave the key fields empty to use the free tier.';
}

module.exports.diagnoseByok = diagnoseByok;
