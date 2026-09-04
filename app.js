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
    // The build-prompt card. These currently ALSO resolve via the browser's
    // named-access-on-window rule (id="buildPromptCard" -> window.buildPromptCard),
    // so the page works today either way. Declaring them explicitly means renaming
    // an id in the HTML fails loudly here instead of silently at call time.
    const buildPromptCard = document.getElementById('buildPromptCard');
    const buildPromptText = document.getElementById('buildPromptText');
    const copyPromptBtn = document.getElementById('copyPromptBtn');

    // ============================================================
    // CONFIG — Backend endpoint
    // ============================================================
    const API_ENDPOINT = '/api/deconstruct';
    // The panel's resting state is a genuine spec we generated, not a mock-up,
    // so the caption has to survive the init call to hideResult().
    const IDLE_LABEL = 'Real output · tailwindcss.com';

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

    // Everyone pastes "linear.app" and expects it to work. Rejecting that with
    // "please include http://" is a needless wall in front of the one action
    // the product exists to perform, so we add the scheme instead of nagging.
    // Only bare hosts get the treatment — "not a url" must still fail, and we
    // default to https because that is what a modern site serves.
    function normalizeURL(raw) {
        const url = String(raw || '').trim();
        if (!url) return url;
        if (URL_PATTERN.test(url)) return url;
        // host[/path][?query] with no spaces and at least one dot
        if (/^[^\s/]+\.[^\s/.]+(:\d+)?([/?#]\S*)?$/.test(url)) return 'https://' + url;
        return url;
    }

    function validateURL(url) {
        return URL_PATTERN.test(String(url || '').trim());
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
        lastSpecText = promptText;
        lastBuildPrompt = extractBuildPrompt(promptText);
        if (buildPromptCard) {
            if (lastBuildPrompt) {
                buildPromptText.textContent = lastBuildPrompt;
                buildPromptCard.hidden = false;
            } else {
                buildPromptCard.hidden = true;
            }
        }
        // If it does not look like markdown at all, keep the plain-text path so
        // a terse one-line answer is never mangled by the renderer.
        if (/^\s*#\s|\n\s*#{1,6}\s|BUILD PROMPT/i.test(promptText)) {
            promptBox.innerHTML = renderMarkdown(promptText);
            promptBox.classList.add('is-rendered');
        } else {
            promptBox.textContent = promptText;
            promptBox.classList.remove('is-rendered');
        }
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
        lastSpecText = '';
        lastBuildPrompt = '';
        if (buildPromptCard) buildPromptCard.hidden = true;
        resultPanel.classList.remove('visible');
        resultLabel.textContent = IDLE_LABEL;
        resultStatus.textContent = 'Ready';
    }

    // ============================================================
    // MARKDOWN RENDERING
    // The model returns a markdown spec (headings, tables, bullet lists).
    // Dumping that into a <pre> shows the reader literal "#" and "|" pipes,
    // which makes a good spec look like a raw dump. Render it instead — but
    // keep the original text for copying, because the copy target is another
    // AI editor that wants markdown, not HTML.
    // ============================================================
    let lastSpecText = '';
    let lastBuildPrompt = '';

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function inlineMd(str) {
        return escapeHtml(str)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    }

    // First line of the spec is a single-imperative instruction to an AI
    // editor. Pull it out so it can sit above the spec with its own copy
    // button — the user pastes the prompt to start the build, then references
    // the spec below as their design source.
    function extractBuildPrompt(spec) {
        if (!spec) return '';
        // The model is told to write "BUILD PROMPT" first. If it doesn't follow
        // the convention we return nothing and the prompt box hides, so a
        // missing header is not a 500 to the user.
        // Stop at the first BLANK LINE as well as at a heading. Without the blank-line
        // stop, a model that writes the prompt then a bullet list (and no heading
        // after it) makes the card swallow the entire rest of the spec.
        const m = String(spec).match(/BUILD PROMPT\s*\n([\s\S]*?)(?=\n\s*\n|\n#{1,6}\s|$)/i);
        if (!m) return '';
        let line = m[1].trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
        if (line.length > 600) line = line.slice(0, 600).replace(/\s+\S*$/, '') + '…';
        return line;
    }

    function renderMarkdown(src) {
        const lines = String(src).replace(/\r/g, '').split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];

            if (!line.trim()) { i++; continue; }

            // GFM table: header row, then |---|---|
            if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
                const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
                const head = cells(line);
                i += 2;
                const rows = [];
                while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
                out.push('<div class="md-table-wrap"><table><thead><tr>' + head.map(h => '<th>' + inlineMd(h) + '</th>').join('') +
                    '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('') +
                    '</tbody></table></div>');
                continue;
            }

            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                const lvl = Math.min(h[1].length, 6);
                out.push('<h' + lvl + '>' + inlineMd(h[2]) + '</h' + lvl + '>');
                i++; continue;
            }

            if (/^\s*[-*]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
                out.push('<ul>' + items.map(t => '<li>' + inlineMd(t) + '</li>').join('') + '</ul>');
                continue;
            }

            if (/^\s*\d+[.)]\s+/.test(line)) {
                const items = [];
                while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
                out.push('<ol>' + items.map(t => '<li>' + inlineMd(t) + '</li>').join('') + '</ol>');
                continue;
            }

            const para = [];
            while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
                   !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
                para.push(lines[i].trim()); i++;
            }
            if (para.length) out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
        }
        return out.join('\n');
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
        const url = normalizeURL(urlInput.value);
        clearError();

        if (!validateURL(url)) {
            showError('That does not look like a website address. Try something like example.com');
            urlInput.focus();
            return;
        }
        // Reflect the normalisation so the field is never silently different
        // from what we actually sent.
        if (url !== urlInput.value.trim()) urlInput.value = url;

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

    if (copyPromptBtn) copyPromptBtn.addEventListener('click', () => {
        if (lastBuildPrompt) copyPrompt(lastBuildPrompt);
    });

    copyBtn.addEventListener('click', () => {
        // Copy the markdown the model produced, not the rendered DOM text —
        // the destination is v0/Cursor, which reads markdown.
        const text = lastSpecText || promptBox.textContent;
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
