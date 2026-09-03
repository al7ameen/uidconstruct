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

    // ============================================================
    // CONFIG — Backend endpoint
    // ============================================================
    const API_ENDPOINT = '/api/deconstruct';

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
    // REAL API CALL — uses your custom backend
    // ============================================================
    async function deconstructWebsite(url) {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url.trim() })
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
            // Progress counter: analysis takes 30-50s; show it's working, not stuck
            let elapsed = 0;
            const statusHints = ['fetching page…', 'extracting styles…', 'AI analyzing design…', 'almost done…'];
            window.__uidcTimer = setInterval(() => {
                elapsed++;
                const hint = statusHints[Math.min(Math.floor(elapsed / 12), statusHints.length - 1)];
                btnText.textContent = 'Analyzing… ' + elapsed + 's — ' + hint;
            }, 1000);
            resultStatus.textContent = 'Analyzing…';
            resultLabel.textContent = 'Generating spec';
        } else {
            clearInterval(window.__uidcTimer);
            btnText.textContent = 'Generate prompt';
            btnSpinner.style.display = 'none';
            deconstructBtn.disabled = false;
        }
    }

    function showResult(promptText) {
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
            const result = await deconstructWebsite(url);
            showResult(result.prompt);
        } catch (err) {
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
