// lib/ai.js — extracted from api/deconstruct.js so the analysis pipeline can be
// required and unit-tested directly. Behaviour is unchanged.


// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
    API_KEY: process.env.OPENAI_API_KEY || '',
    BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    MODEL: process.env.OPENAI_MODEL || 'qwen3.8-flash',
    TIMEOUT_MS: 52000
};

// BYOK providers we will proxy to. Deliberately an allowlist: if we accepted
// an arbitrary base URL, any user could turn this function into an SSRF proxy
// (or point it at internal metadata endpoints) using our server as the client.

// BYOK providers we will proxy to. Deliberately an allowlist: if we accepted
// an arbitrary base URL, any user could turn this function into an SSRF proxy
// (or point it at internal metadata endpoints) using our server as the client.
const BYOK_PROVIDERS = {
    openai: {
        endpoint: 'https://api.openai.com/v1/chat/completions',
        auth: (key) => ({ 'Authorization': `Bearer ${key}` })
    },
    anthropic: {
        endpoint: 'https://api.anthropic.com/v1/messages',
        auth: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })
    }
};


function normalizeByok(raw) {
    if (!raw || typeof raw.key !== 'string') return null;
    const key = raw.key.trim();
    // OpenAI keys are ~20-120 chars; Anthropic similar. Cap to keep logs/bodies sane.
    if (key.length < 20 || key.length > 200) return null;
    const provider = BYOK_PROVIDERS[raw.provider] ? raw.provider : null;
    if (!provider) return null;
    // Model is REQUIRED. We deliberately do not guess a default: model IDs
    // change, entitlements differ per account, and a wrong default produces a
    // confusing provider error. Conservative charset = no URL/injection surface.
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!/^[\w.\-:]{1,80}$/.test(model)) return null;
    return { provider, model, key };
}

// ============================================================
// UTILITIES
// ============================================================

// Signals a caller-correctable problem (bad key / quota), so the handler can
// answer 4xx instead of 500 and the user doesn't think we are down.
class ByokAuthError extends Error {}


// ============================================================
// MAIN HANDLER
// ============================================================
async function callAI(messages, byok) {
    let url, headers, body;

    if (byok) {
        const p = BYOK_PROVIDERS[byok.provider];
        url = p.endpoint;
        headers = { 'Content-Type': 'application/json', ...p.auth(byok.key) };

        if (byok.provider === 'anthropic') {
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
            model: CONFIG.MODEL,
            messages,
            temperature: 0.3,
            reasoning_effort: 'low',
            max_tokens: 8000
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.TIMEOUT_MS)
    });

    if (!res.ok) {
        // Truncate + never echo the request headers: the provider's error body
        // can contain fragments of the request, and we must not surface a key.
        const text = (await res.text()).slice(0, 300);
        if (res.status === 401 || res.status === 403) {
            throw new ByokAuthError('Your API key was rejected by the provider. Check the key and the model name, then try again.');
        }
        if (res.status === 429) {
            throw new Error('Your provider quota is rate-limited right now. Try again shortly.');
        }
        throw new Error(`AI provider error (${res.status}). ${byok ? 'Check your key, model name, and quota.' : 'Please try again.'} ${text.replace(/<[^>]*>/g, '')}`.slice(0, 400));
    }

    const data = await res.json();
    if (byok && byok.provider === 'anthropic') {
        return data.content?.map(c => c.text || '').join('') || 'No response from AI.';
    }
    return data.choices?.[0]?.message?.content || 'No response from AI.';
}


module.exports = { BYOK_PROVIDERS, ByokAuthError, CONFIG, callAI, normalizeByok };
