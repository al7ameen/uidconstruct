/**
 * uidconstruct v2.2
 * Frontend logic — handles UI, state, and API calls
 */

(function() {
    'use strict';

    // ============================================================
    // DOM REFS
    // ============================================================
    const html = document.documentElement;
    const navbar = document.getElementById('navbar');
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const themeLabel = document.getElementById('themeLabel');
    const navToggle = document.getElementById('navToggle');
    const navLinks = document.getElementById('navLinks');
    const urlInput = document.getElementById('urlInput');
    const deconstructBtn = document.getElementById('deconstructBtn');
    const btnText = document.getElementById('btnText');
    const btnSpinner = document.getElementById('btnSpinner');
    const errorEl = document.getElementById('url-error');
    const resultPanel = document.getElementById('resultPanel');
    const promptBox = document.getElementById('promptContent');
    const copyBtn = document.getElementById('copyBtn');
    const reconstructBtn = document.getElementById('reconstructBtn');
    const resultStatus = document.getElementById('resultStatus');
    const resultLabel = document.getElementById('resultLabel');
    const ctaBtn = document.getElementById('ctaBtn');
    const byokToggle = document.getElementById('byokToggle');
    const byokPanel = document.getElementById('byokPanel');
    const byokProvider = document.getElementById('byokProvider');
    const byokModel = document.getElementById('byokModel');
    const byokKey = document.getElementById('byokKey');
    const byokRemember = document.getElementById('byokRemember');

    // ============================================================
    // CONFIG — Backend endpoint
    // ============================================================
    const API_ENDPOINT = '/api/deconstruct';

    // ============================================================
    // ANALYTICS — fire-and-forget custom events (Plausible)
    // No-op if Plausible isn't loaded yet, so it can never break the UI.
    // ============================================================
    function track(event, props) {
        try {
            if (window.plausible) window.plausible(event, { props: props || {} });
        } catch (_) { /* analytics must never break the product */ }
    }

    // ============================================================
    // THEME MANAGEMENT
    // ============================================================
    const STORAGE_KEY = 'uid-theme';

    function getStoredTheme() {
        try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
    }
    function getSystemTheme() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function setTheme(theme) {
        html.setAttribute('data-theme', theme);
        const isDark = theme === 'dark';
        themeLabel.textContent = isDark ? 'Light' : 'Dark';
        themeIcon.textContent = isDark ? '☀️' : '🌙';
        try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
        themeToggle.setAttribute('aria-label', 'Switch to ' + (isDark ? 'light' : 'dark') + ' theme');
    }
    function getInitialTheme() {
        const stored = getStoredTheme();
        if (stored === 'dark' || stored === 'light') return stored;
        return getSystemTheme();
    }

    setTheme(getInitialTheme());

    themeToggle.addEventListener('click', () => {
        const current = html.getAttribute('data-theme');
        setTheme(current === 'dark' ? 'light' : 'dark');
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!getStoredTheme()) setTheme(e.matches ? 'dark' : 'light');
    });

    // ============================================================
    // NAVBAR SCROLL EFFECT
    // ============================================================
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
                navbar.classList.toggle('scrolled', currentScroll > 20);
                ticking = false;
            });
            ticking = true;
        }
    });
    if (window.pageYOffset > 20) navbar.classList.add('scrolled');

    // ============================================================
    // MOBILE NAV TOGGLE
    // ============================================================
    function closeMobileNav() {
        navLinks.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
        navToggle.innerHTML = '<span aria-hidden="true">☰</span>';
    }

    navToggle.addEventListener('click', () => {
        const isOpen = navLinks.classList.toggle('open');
        navToggle.setAttribute('aria-expanded', isOpen);
        navToggle.innerHTML = isOpen
            ? '<span aria-hidden="true">✕</span>'
            : '<span aria-hidden="true">☰</span>';
    });

    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeMobileNav);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && navLinks.classList.contains('open')) {
            closeMobileNav();
            navToggle.focus();
        }
    });

    // ============================================================
    // URL VALIDATION
    // ============================================================
    const URL_PATTERN = /^https?:\/\/.+/i;

    function validateURL(url) {
        return URL_PATTERN.test(url.trim());
    }

    function extractDomain(url) {
        try {
            const parsed = new URL(url);
            return parsed.hostname.replace(/^www\./, '');
        } catch (_) {
            return url.trim();
        }
    }

    function showError(message) {
        errorEl.textContent = '⚠️ ' + message;
        urlInput.classList.add('error');
        urlInput.setAttribute('aria-invalid', 'true');
    }

    function clearError() {
        errorEl.textContent = '';
        urlInput.classList.remove('error');
        urlInput.removeAttribute('aria-invalid');
    }


    // ============================================================
    // BRING-YOUR-OWN-KEY
    // The key is held in memory by default. It is only persisted if the
    // user ticks "Remember", and then only in this browser's localStorage.
    // It is never logged and never stored server-side.
    // ============================================================
    const BYOK_STORE = 'uid-byok';
    let byok = { provider: 'openai', model: '', key: '' };

    function loadByok() {
        try {
            const raw = localStorage.getItem(BYOK_STORE);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved && typeof saved.key === 'string' && saved.key) {
                byok = { provider: saved.provider || 'openai', model: saved.model || '', key: saved.key };
                if (byokKey) byokKey.value = byok.key;
                if (byokModel) byokModel.value = byok.model;
                if (byokProvider) byokProvider.value = byok.provider;
                if (byokRemember) byokRemember.checked = true;
            }
        } catch (_) {}
    }

    function saveByok() {
        try {
            if (byokRemember && byokRemember.checked && byok.key) {
                localStorage.setItem(BYOK_STORE, JSON.stringify(byok));
            } else {
                localStorage.removeItem(BYOK_STORE);
            }
        } catch (_) {}
    }

    function readByokFromForm() {
        byok.key = (byokKey && byokKey.value || '').trim();
        byok.model = (byokModel && byokModel.value || '').trim();
        byok.provider = (byokProvider && byokProvider.value) || 'openai';
        saveByok();
        updateByokBadge();
    }

    // A key without a model is a half-filled form. Treat it as "not using BYOK"
    // rather than sending a request the provider will reject.
    function byokReady() {
        return Boolean(byok.key && byok.model);
    }

    function updateByokBadge() {
        const free = document.querySelector('.usage-stats .stat .num');
        if (!free) return;
        if (byokReady()) {
            free.textContent = '∞';
            free.parentElement.innerHTML = '<span class="num">∞</span> with your own key';
        } else {
            free.textContent = '10';
            free.parentElement.innerHTML = '<span class="num">10</span> free analyses / hour';
        }
    }

    if (byokToggle && byokPanel) {
        byokToggle.addEventListener('click', () => {
            const open = byokPanel.hasAttribute('hidden');
            if (open) byokPanel.removeAttribute('hidden');
            else byokPanel.setAttribute('hidden', '');
            byokToggle.setAttribute('aria-expanded', String(open));
            if (open && byokKey) byokKey.focus();
            track('BYOK opened');
        });
        [byokProvider, byokModel, byokKey, byokRemember].forEach(el => {
            if (el) el.addEventListener('change', readByokFromForm);
        });
        if (byokKey) byokKey.addEventListener('blur', readByokFromForm);
    }
    loadByok();

    // ============================================================
    // WAITLIST — posts to Formspree-free fallback: mailto is the honest
    // zero-backend option until we pick a list provider.
    // ============================================================
    const wlForm = document.getElementById('wlForm');
    if (wlForm) {
        wlForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailEl = document.getElementById('wlEmail');
            const email = (emailEl.value || '').trim();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
                emailEl.classList.add('error');
                return;
            }
            emailEl.classList.remove('error');
            const btn = document.getElementById('wlBtn');
            btn.disabled = true;
            try {
                const r = await fetch('/api/waitlist', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });
                if (!r.ok) throw new Error('rejected');
                document.getElementById('wlPrompt').textContent =
                    'Saved — ' + email + '. We will email once before launch.';
                wlForm.style.display = 'none';
                track('Waitlist join');
            } catch (_) {
                btn.disabled = false;
                document.getElementById('wlPrompt').textContent =
                    'Could not save that. Email alameensathar1751@gmail.com and we will add you by hand.';
            }
        });
    }

    // ============================================================
    // REAL API CALL — uses your custom backend
    // ============================================================
    async function deconstructWebsite(url) {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url.trim(),
                byok: byokReady() ? { provider: byok.provider, model: byok.model, key: byok.key } : undefined
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error || 'Failed to analyze website');
        }

        return await response.json();
    }

    // ============================================================
    // UI STATE
    // ============================================================
    function setLoading(isLoading) {
        if (isLoading) {
            btnText.textContent = 'Analyzing…';
            btnSpinner.style.display = 'inline-block';
            deconstructBtn.disabled = true;
            // Neutral status text only — no elapsed-seconds counter
            btnText.textContent = 'Analyzing…';
            resultStatus.textContent = 'Analyzing…';
            resultLabel.textContent = 'Generating spec';
        } else {
            btnText.textContent = 'Generate prompt';
            btnSpinner.style.display = 'none';
            deconstructBtn.disabled = false;
        }
    }

    function showResult(promptText, timings) {
        promptBox.textContent = promptText;
        resultPanel.classList.add('visible');
        copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy prompt`;
        copyBtn.classList.remove('copied');
        resultStatus.textContent = 'Generated';
        resultLabel.textContent = 'Generated spec';
        if (window.innerWidth < 768) {
            resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function hideResult() {
        resultPanel.classList.remove('visible');
        resultLabel.textContent = 'Sample output';
        resultStatus.textContent = 'Ready';
    }

    // ============================================================
    // COPY TO CLIPBOARD
    // ============================================================
    async function copyPrompt(text) {
        const success = () => {
            copyBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Copied!`;
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy prompt`;
                copyBtn.classList.remove('copied');
            }, 2000);
        };

        try {
            await navigator.clipboard.writeText(text);
            success();
        } catch (_) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                ta.style.top = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                success();
            } catch (err) {
                const range = document.createRange();
                range.selectNodeContents(promptBox);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }

    // ============================================================
    // MAIN FLOW
    // ============================================================
    async function handleDeconstruct() {
        const url = urlInput.value.trim();
        clearError();

        if (!validateURL(url)) {
            showError('Please include http:// or https://');
            urlInput.focus();
            return;
        }

        setLoading(true);

        try {
            track('Analysis started', { domain: extractDomain(url) });
            const t0 = Date.now();
            const result = await deconstructWebsite(url);
            showResult(result.prompt, result.timings);
            track('Analysis success', { domain: extractDomain(url), ms: String(Date.now() - t0) });
            if (byokReady()) track('BYOK used');
        } catch (err) {
            track('Analysis failed', { domain: extractDomain(url), status: String(err.status || '') });
            showError(err.message || 'Something went wrong. Please try again.');
            resultStatus.textContent = 'Error';
            resultLabel.textContent = 'Error';
        } finally {
            setLoading(false);
        }
    }

    // ============================================================
    // EVENT BINDING
    // ============================================================
    deconstructBtn.addEventListener('click', handleDeconstruct);
    track('Tool viewed');

    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            deconstructBtn.click();
        }
    });

    urlInput.addEventListener('input', () => {
        if (errorEl.textContent) clearError();
    });

    copyBtn.addEventListener('click', () => {
        const text = promptBox.textContent;
        if (text) copyPrompt(text);
    });

    if (reconstructBtn) {
        reconstructBtn.addEventListener('click', () => {
            hideResult();
            urlInput.focus();
        });
    }

    if (ctaBtn) {
        ctaBtn.addEventListener('click', () => {
            document.getElementById('main').scrollIntoView({ behavior: 'smooth' });
            setTimeout(() => urlInput.focus(), 500);
        });
    }

    // ============================================================
    // INIT
    // ============================================================
    hideResult();

    console.log('uidconstruct v2.2 ready');
})();
