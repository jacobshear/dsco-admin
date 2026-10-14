/*
 * Shared shell for every DSCO admin page: sign-in, API helper, sidebar,
 * env switch, and the UI primitives pages build with (AdminShell.ui).
 *
 * One account for both environments: the console always signs in with the
 * prod Cognito pool, and the dev/staging admin routes trust that pool too
 * (backend config/shared.yml adminCognitoArnsByStage). Switching Dev/Prod
 * only changes which API the page talks to, so it never signs you out.
 * TOTP is mandatory for console accounts (enforceMfa).
 *
 * Env selection: ?env=dev|prod (sticky on nav links, so two tabs can sit on
 * different envs), else the last env you picked, else dev.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6/dist/amazon-cognito-identity.min.js"></script>
 *   <script src="assets/admin.js"></script>
 *   <script>AdminShell.init({ active: 'levers.html', title: 'Levers', onReady: loadPage });</script>
 */
const AdminShell = (() => {
    const AUTH = {
        poolId: 'us-west-1_EJOoIz82g',
        // DscoAdminDashboard app client (created 2026-07-17; no client secret)
        clientId: '7l6em5bt2hfrg5on1t8591rgrg',
    };

    const ENV_CONFIGS = {
        dev: {
            label: 'Dev',
            apiBase: 'https://api.dsco.dev',
            firebaseProjectId: 'dsco-683f6',
        },
        prod: {
            label: 'Prod',
            apiBase: 'https://api-prod.dsco.dev',
            firebaseProjectId: 'dsco-app-prod',
        },
    };

    const ENV_KEY = 'dscoAdmin.env';

    function storageGet(store, key) {
        try { return window[store].getItem(key); } catch (_) { return null; }
    }

    function storageSet(store, key, value) {
        try { window[store].setItem(key, value); } catch (_) { /* private mode */ }
    }

    function resolveEnvName() {
        try {
            const q = (new URLSearchParams(window.location.search).get('env') || '').toLowerCase();
            if (q === 'prod' || q === 'dev') {
                storageSet('localStorage', ENV_KEY, q);
                return q;
            }
        } catch (_) { /* ignore */ }
        const saved = storageGet('localStorage', ENV_KEY);
        if (saved === 'prod' || saved === 'dev') return saved;
        return 'dev';
    }

    const envName = resolveEnvName();
    const env = ENV_CONFIGS[envName];
    const isProd = envName === 'prod';

    const API = {
        core: `${env.apiBase}/core`,
        social: `${env.apiBase}/social`,
        map: `${env.apiBase}/map`,
        content: `${env.apiBase}/content`,
        realtime: `${env.apiBase}/realtime`,
    };

    // Sidebar: [href, label, icon, count key]
    const NAV = [
        { items: [['index.html', 'Overview', 'home']] },
        {
            label: 'Moderation',
            items: [
                ['reports.html', 'Reports', 'flag', 'reports'],
                ['content.html', 'Content', 'image'],
                ['appeals.html', 'Appeals', 'scale', 'appeals'],
                ['users.html', 'Users', 'users'],
            ],
        },
        {
            label: 'Monitoring',
            items: [
                ['crashes.html', 'Crashes', 'alert'],
                ['costs.html', 'Costs', 'dollar'],
                ['geocode.html', 'Geocoding', 'pin'],
            ],
        },
        { label: 'App', items: [['levers.html', 'Levers', 'sliders']] },
        {
            label: 'Records',
            items: [
                ['audit.html', 'Audit log', 'list'],
                ['transparency.html', 'Transparency', 'file'],
            ],
        },
    ];

    const PAGE_DESCRIPTIONS = {
        'index.html': 'Health and activity across the app.',
        'reports.html': 'Reports people filed, with the evidence captured when they reported.',
        'content.html': 'Reported and recent stories, pins and messages.',
        'appeals.html': 'People asking to reverse a moderation action.',
        'users.html': 'Find a person, see their history and act on their account.',
        'crashes.html': 'Crashlytics issues from the last 7 days.',
        'costs.html': 'AWS spend this month and the forecast.',
        'geocode.html': 'Mapbox geocoding calls against the monthly cap.',
        'levers.html': 'Server switches the app reads on its next bootstrap.',
        'audit.html': 'Every admin action, newest first.',
        'transparency.html': 'Moderation totals for transparency reporting.',
    };

    const ROLE_LABELS = { 3: 'Super admin', 2: 'Admin', 1: 'Moderator' };

    const userPool = new AmazonCognitoIdentity.CognitoUserPool({
        UserPoolId: AUTH.poolId,
        ClientId: AUTH.clientId,
    });

    let cognitoUser = null;
    let onReadyCallback = null;

    // ================================================================
    // Small helpers
    // ================================================================

    /** HTML-escape text and attribute values (quotes included). */
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }

    const ICON_PATHS = {
        home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
        flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
        scale: '<path d="M12 3v18"/><path d="M8 21h8"/><path d="M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0z"/><path d="m19 7-3 7a3 3 0 0 0 6 0z"/>',
        users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.5a6.5 6.5 0 0 1 3 5.5"/>',
        alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
        dollar: '<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
        sliders: '<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/>',
        list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>',
        file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
        menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.5"/><path d="M20 20v-4h-4"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        check: '<path d="m5 12 5 5L20 7"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
        inbox: '<path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
        logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H4"/>',
        external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
        download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
        play: '<path d="M7 4.5v15l12.5-7.5z"/>',
        chevron: '<path d="m9 6 6 6-6 6"/>',
    };

    /** Inline SVG icon from the console's one icon family. */
    function icon(name, extraClass = '') {
        return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
    }

    /** Date from an ISO string, epoch ms, or epoch seconds. */
    function toDate(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
            const n = Number(value);
            const d = new Date(n < 1e12 ? n * 1000 : n);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    /** "Oct 7, 12:31 PM" (year added when it isn't this year). */
    function time(value, { seconds = false } = {}) {
        const d = toDate(value);
        if (!d) return '';
        const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
        if (seconds) opts.second = '2-digit';
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleString([], opts);
    }

    /** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
    function relative(value) {
        const d = toDate(value);
        if (!d) return '';
        const s = Math.round((Date.now() - d.getTime()) / 1000);
        if (s < 45) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        if (s < 86400) return `${Math.round(s / 3600)}h ago`;
        if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString([], opts);
    }

    /** <time> element: relative label, full timestamp on hover. */
    function timeTag(value) {
        const d = toDate(value);
        if (!d) return '<span class="faint">Unknown</span>';
        return `<time datetime="${esc(d.toISOString())}" title="${esc(time(d, { seconds: true }))}">${esc(relative(d))}</time>`;
    }

    function number(n) {
        return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '–';
    }

    // ================================================================
    // States, notices, dialogs (owner primitives for every page)
    // ================================================================

    function loading(el, label = 'Loading…') {
        el.innerHTML = `<div class="state" role="status"><div class="spinner"></div><div>${esc(label)}</div></div>`;
    }

    /** Empty state with an optional next action. */
    function empty(el, { title = 'Nothing here', body = '', icon: iconName = 'inbox', actionLabel, onAction } = {}) {
        el.innerHTML = `
            <div class="state">
                ${icon(iconName)}
                <div class="state-title">${esc(title)}</div>
                ${body ? `<div class="state-body">${esc(body)}</div>` : ''}
                ${actionLabel ? `<button type="button" class="btn">${esc(actionLabel)}</button>` : ''}
            </div>`;
        if (actionLabel && onAction) el.querySelector('.state .btn').addEventListener('click', onAction);
    }

    /** Error state: "Couldn't …" title, the server's message, and Try again. */
    function error(el, { title = "Couldn't load this", error: err, onRetry } = {}) {
        const message = err && err.message ? err.message : (err ? String(err) : '');
        el.innerHTML = `
            <div class="state error" role="alert">
                ${icon('alert')}
                <div class="state-title">${esc(title)}</div>
                ${message ? `<div class="state-body">${esc(message)}</div>` : ''}
                ${onRetry ? '<button type="button" class="btn">Try again</button>' : ''}
            </div>`;
        if (onRetry) el.querySelector('.state .btn').addEventListener('click', onRetry);
    }

    /**
     * Notice for the result of something the person did. Failures stay until
     * closed; an expected success that's already visible on the page should
     * stay silent instead of calling this.
     */
    function notice(message, { tone = 'info', timeout } = {}) {
        let region = document.getElementById('shell-notices');
        if (!region) {
            region = document.createElement('div');
            region.id = 'shell-notices';
            region.className = 'notices';
            document.body.appendChild(region);
        }
        const el = document.createElement('div');
        el.className = `notice ${tone}`;
        el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
        const glyph = tone === 'good' ? 'check' : tone === 'bad' ? 'alert' : 'info';
        el.innerHTML = `${icon(glyph)}<div class="notice-text">${esc(message)}</div>
            <button type="button" class="icon-btn" aria-label="Dismiss">${icon('x')}</button>`;
        const remove = () => el.remove();
        el.querySelector('.icon-btn').addEventListener('click', remove);
        region.appendChild(el);
        const ms = timeout ?? (tone === 'bad' ? 0 : 4000);
        if (ms) setTimeout(remove, ms);
        return remove;
    }

    let dialogSeq = 0;

    /**
     * Modal dialog on the native <dialog> (focus trap, Escape, backdrop).
     * body: HTML string (escape your values) or a Node.
     * actions: [{ label, kind: 'primary'|'danger'|'', onClick(close) }]
     * Returns { el, body, close }.
     */
    function dialog({ title = '', body = '', actions = [], wide = false, media = false, onClose } = {}) {
        const id = `dlg-title-${++dialogSeq}`;
        const d = document.createElement('dialog');
        d.className = `dlg${wide ? ' wide' : ''}${media ? ' media' : ''}`;
        if (title) d.setAttribute('aria-labelledby', id);
        else d.setAttribute('aria-label', 'Viewer');
        d.innerHTML = `
            <div class="dlg-head">
                <h2 id="${id}">${esc(title)}</h2>
                <button type="button" class="icon-btn" data-dlg-close aria-label="Close">${icon('x')}</button>
            </div>
            <div class="${media ? 'dlg-media-body' : 'dlg-body'}"></div>
            ${actions.length ? '<div class="dlg-foot"></div>' : ''}`;
        const bodyEl = d.querySelector(media ? '.dlg-media-body' : '.dlg-body');
        if (body instanceof Node) bodyEl.appendChild(body);
        else bodyEl.innerHTML = body;

        let closed = false;
        const close = (value) => {
            if (closed) return;
            closed = true;
            if (d.open) d.close();
            d.remove();
            if (onClose) onClose(value);
        };

        const foot = d.querySelector('.dlg-foot');
        actions.forEach(action => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `btn${action.kind ? ` ${action.kind}` : ''}`;
            b.textContent = action.label;
            b.addEventListener('click', () => (action.onClick ? action.onClick(close, b) : close()));
            foot.appendChild(b);
        });

        d.querySelector('[data-dlg-close]').addEventListener('click', () => close(null));
        d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
        d.addEventListener('click', (e) => { if (e.target === d) close(null); });
        document.body.appendChild(d);
        d.showModal();
        return { el: d, body: bodyEl, close };
    }

    /**
     * Confirm before acting. Titles are questions; the button keeps the verb.
     * fields: [{ name, label, type: 'select'|'textarea'|'text', options: [[value, label]],
     *            required, placeholder, hint }]
     * Resolves { ...fieldValues } on confirm, null on cancel.
     */
    function confirm({ title, body = '', confirmLabel = 'Confirm', destructive = false, fields = [] } = {}) {
        return new Promise((resolve) => {
            const form = document.createElement('form');
            form.noValidate = true;
            const prodWarning = destructive && isProd
                ? '<p class="dlg-prod-warn">Production: this affects real people.</p>'
                : '';
            form.innerHTML = `${prodWarning}${body ? `<p>${body}</p>` : ''}` + fields.map((f, i) => {
                const fid = `cf-${dialogSeq + 1}-${i}`;
                const req = f.required ? ' <span class="required" aria-hidden="true">*</span>' : '';
                let control;
                if (f.type === 'select') {
                    control = `<select id="${fid}" name="${esc(f.name)}"${f.required ? ' required' : ''}>
                        <option value="">${esc(f.placeholder || 'Choose…')}</option>
                        ${(f.options || []).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
                    </select>`;
                } else if (f.type === 'textarea') {
                    control = `<textarea id="${fid}" name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}"${f.required ? ' required' : ''}></textarea>`;
                } else {
                    control = `<input type="text" id="${fid}" name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}"${f.required ? ' required' : ''}>`;
                }
                return `<div class="field" style="margin-top:12px">
                    <label for="${fid}">${esc(f.label)}${req}</label>${control}
                    ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
                </div>`;
            }).join('');

            const submit = (close) => {
                const values = {};
                let missing = null;
                fields.forEach(f => {
                    const input = form.elements[f.name];
                    values[f.name] = input ? input.value.trim() : '';
                    if (f.required && !values[f.name] && !missing) missing = input;
                });
                if (missing) {
                    missing.focus();
                    missing.setAttribute('aria-invalid', 'true');
                    return;
                }
                close(values);
            };

            const dlg = dialog({
                title,
                body: form,
                actions: [
                    { label: 'Cancel', onClick: (close) => close(null) },
                    { label: confirmLabel, kind: destructive ? 'danger' : 'primary', onClick: submit },
                ],
                onClose: (value) => resolve(value || null),
            });
            form.addEventListener('submit', (e) => { e.preventDefault(); submit(dlg.close); });
            const first = form.querySelector('select, textarea, input');
            if (first) first.focus();
        });
    }

    /** Run fn with the button in its in-place busy state. */
    async function busy(button, fn) {
        if (!button) return fn();
        button.classList.add('busy');
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        try {
            return await fn();
        } finally {
            button.classList.remove('busy');
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }

    /** Full-size media viewer. Only https URLs are ever loaded. */
    function media(url, kind = 'image') {
        if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return;
        const tag = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'img';
        const el = document.createElement(tag);
        el.src = url;
        if (tag === 'img') {
            el.alt = 'Evidence';
        } else {
            el.controls = true;
            el.autoplay = true;
            el.playsInline = true;
        }
        const wrap = document.createElement('div');
        wrap.className = 'dlg-media-body';
        wrap.style.padding = '0';
        wrap.appendChild(el);
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open in new tab';
        wrap.appendChild(link);
        dialog({ media: true, body: wrap });
    }

    // ================================================================
    // Shell
    // ================================================================

    function envAwareHref(href) {
        const sep = href.includes('?') ? '&' : '?';
        return `${href}${sep}env=${encodeURIComponent(envName)}`;
    }

    function switchEnv(name) {
        if (name === envName || !ENV_CONFIGS[name]) return;
        storageSet('localStorage', ENV_KEY, name);
        const url = new URL(window.location.href);
        url.searchParams.set('env', name);
        window.location.href = url.toString();
    }

    function navHtml(active) {
        return NAV.map(group => `
            <div class="nav-group">
                ${group.label ? `<div class="nav-group-label">${esc(group.label)}</div>` : ''}
                ${group.items.map(([href, label, iconName, countKey]) => `
                    <a class="nav-link" href="${esc(envAwareHref(href))}"${href === active ? ' aria-current="page"' : ''}>
                        ${icon(iconName)}<span>${esc(label)}</span>
                        ${countKey ? `<span class="nav-count" data-count="${countKey}" hidden></span>` : ''}
                    </a>`).join('')}
            </div>`).join('');
    }

    function renderShell(active, title) {
        const navLabel = NAV.flatMap(g => g.items).find(([h]) => h === active)?.[1];
        const pageTitle = title || navLabel || 'Admin';
        document.title = `${isProd ? 'PROD · ' : ''}${pageTitle} · DSCO admin`;
        document.body.classList.add('shell-on');
        if (isProd) document.body.classList.add('env-prod');

        const envSwitch = `
            <div class="env-switch">
                <div class="seg" role="group" aria-label="Environment">
                    ${Object.entries(ENV_CONFIGS).map(([name, cfg]) =>
                        `<button type="button" data-env="${name}" class="${name}" aria-pressed="${name === envName}">${cfg.label}</button>`
                    ).join('')}
                </div>
                <div class="env-note">${isProd ? 'Production: real people and data' : 'Development data'}</div>
            </div>`;

        document.body.insertAdjacentHTML('afterbegin', `
            <div class="login-overlay" id="shell-login" hidden>
                <div class="login-box">
                    <span class="wordmark">DSCO</span>
                    <p class="sub">Admin console</p>
                    <div class="login-error" id="shell-login-error" role="alert"></div>

                    <form id="shell-login-form">
                        <div class="field">
                            <label for="shell-email">Email</label>
                            <input type="email" id="shell-email" autocomplete="username" required>
                        </div>
                        <div class="field">
                            <label for="shell-password">Password</label>
                            <input type="password" id="shell-password" autocomplete="current-password" required>
                        </div>
                        <button class="btn primary" id="shell-login-btn" type="submit">Sign in</button>
                        <button class="btn plain block" id="shell-forgot-link" type="button">Forgot password?</button>
                    </form>

                    <form id="shell-forgot-form" hidden>
                        <p class="sub">We'll email you a code to set a new password.</p>
                        <div class="field">
                            <label for="shell-forgot-email">Email</label>
                            <input type="email" id="shell-forgot-email" autocomplete="username">
                        </div>
                        <button class="btn primary" id="shell-forgot-btn" type="submit">Send code</button>
                        <button class="btn plain block shell-back-to-login" type="button">Back to sign in</button>
                    </form>

                    <form id="shell-reset-form" hidden>
                        <p class="sub">Enter the code from your email and a new password.</p>
                        <div class="field">
                            <label for="shell-reset-code">Code</label>
                            <input type="text" id="shell-reset-code" inputmode="numeric" autocomplete="one-time-code">
                        </div>
                        <div class="field">
                            <label for="shell-reset-password">New password</label>
                            <input type="password" id="shell-reset-password" autocomplete="new-password" minlength="8">
                            <div class="hint">At least 8 characters.</div>
                        </div>
                        <button class="btn primary" id="shell-reset-btn" type="submit">Set password</button>
                        <button class="btn plain block shell-back-to-login" type="button">Back to sign in</button>
                    </form>

                    <form id="shell-newpw-form" hidden>
                        <p class="sub">Set a new password to continue.</p>
                        <div class="field">
                            <label for="shell-newpw">New password</label>
                            <input type="password" id="shell-newpw" autocomplete="new-password" minlength="8">
                            <div class="hint">At least 8 characters.</div>
                        </div>
                        <button class="btn primary" id="shell-newpw-btn" type="submit">Set password and sign in</button>
                    </form>

                    <form id="shell-totp-form" hidden>
                        <p class="sub">Enter the 6-digit code from your authenticator app.</p>
                        <div class="field">
                            <label for="shell-totp-code">Code</label>
                            <input type="text" id="shell-totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
                        </div>
                        <button class="btn primary" id="shell-totp-btn" type="submit">Verify and sign in</button>
                    </form>

                    <form id="shell-totp-setup" hidden>
                        <p class="sub">One-time setup: admin accounts need an authenticator app.</p>
                        <ol class="login-steps">
                            <li>In Apple Passwords, 1Password or Google Authenticator, add a verification code.</li>
                            <li>Scan this QR code, or type the key under it.</li>
                            <li>Enter the 6-digit code the app shows.</li>
                        </ol>
                        <div id="shell-totp-qr" class="totp-qr"></div>
                        <div class="totp-secret">Key: <code id="shell-totp-secret"></code><br>Reloading makes a new key. If you reload, delete the old entry first.</div>
                        <div class="field">
                            <label for="shell-totp-setup-code">Code</label>
                            <input type="text" id="shell-totp-setup-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
                        </div>
                        <button class="btn primary" id="shell-totp-setup-btn" type="submit">Turn on and sign in</button>
                    </form>

                </div>
            </div>

            <div class="topbar" id="shell-topbar" hidden>
                <button type="button" class="icon-btn" id="shell-menu" aria-label="Open navigation" aria-expanded="false">${icon('menu')}</button>
                <span class="wordmark">DSCO</span>
                <span class="env-chip">${esc(env.label)}</span>
            </div>

            <nav class="sidebar" id="shell-sidebar" aria-label="Admin" hidden>
                <div class="sidebar-brand"><span class="wordmark">DSCO</span><span class="sub">Admin</span></div>
                <div class="sidebar-env">${envSwitch}</div>
                <div class="sidebar-nav">${navHtml(active)}</div>
                <div class="sidebar-foot">
                    <div class="account">
                        <div class="account-avatar" id="shell-account-initial" aria-hidden="true"></div>
                        <div class="account-text">
                            <div class="account-email" id="shell-account-email"></div>
                            <div class="account-role" id="shell-account-role"></div>
                        </div>
                    </div>
                    <button type="button" class="btn sm block" id="shell-signout">${icon('logout')}Sign out</button>
                </div>
            </nav>
            <div class="sidebar-scrim" id="shell-scrim"></div>
        `);

        // Page head: every page gets a title, a one-line purpose and an actions slot.
        const container = document.querySelector('.container');
        if (container) {
            container.insertAdjacentHTML('afterbegin', `
                <header class="page-head">
                    <div>
                        <h1>${esc(pageTitle)}</h1>
                        ${PAGE_DESCRIPTIONS[active] ? `<p class="page-desc">${esc(PAGE_DESCRIPTIONS[active])}</p>` : ''}
                    </div>
                    <div class="page-actions" id="page-actions"></div>
                </header>`);
        }

        const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
        on('shell-login-form', 'submit', (e) => { e.preventDefault(); login(); });
        on('shell-newpw-form', 'submit', (e) => { e.preventDefault(); completeNewPassword(); });
        on('shell-totp-form', 'submit', (e) => { e.preventDefault(); submitTotp(); });
        on('shell-totp-setup', 'submit', (e) => { e.preventDefault(); completeTotpSetup(); });
        on('shell-forgot-form', 'submit', (e) => { e.preventDefault(); sendResetCode(); });
        on('shell-reset-form', 'submit', (e) => { e.preventDefault(); confirmReset(); });
        on('shell-forgot-link', 'click', () => {
            document.getElementById('shell-forgot-email').value = document.getElementById('shell-email').value.trim();
            showLoginPane('shell-forgot-form');
            document.getElementById('shell-forgot-email').focus();
        });
        document.querySelectorAll('.shell-back-to-login').forEach(b => b.addEventListener('click', () => showLoginPane('shell-login-form')));
        on('shell-signout', 'click', signOut);
        on('shell-menu', 'click', () => setNavOpen(!document.body.classList.contains('nav-open')));
        on('shell-scrim', 'click', () => setNavOpen(false));
        document.querySelectorAll('.env-switch button[data-env]').forEach(btn => {
            btn.addEventListener('click', () => switchEnv(btn.dataset.env));
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNavOpen(false);
        });

        // Nothing shows until the session check picks sign-in or the app.
        document.querySelectorAll('.container').forEach(el => { el.style.display = 'none'; });
    }

    function setNavOpen(open) {
        document.body.classList.toggle('nav-open', open);
        document.getElementById('shell-menu').setAttribute('aria-expanded', String(open));
    }

    function setAppVisible(visible) {
        document.getElementById('shell-login').hidden = visible;
        document.getElementById('shell-sidebar').hidden = !visible;
        document.getElementById('shell-topbar').hidden = !visible;
        document.querySelectorAll('.container').forEach(el => { el.style.display = visible ? '' : 'none'; });
    }

    function showLogin() {
        setAppVisible(false);
    }

    function showApp() {
        setAppVisible(true);
        fillAccount();
        applyBrand();
        refreshCounts();
        if (onReadyCallback) onReadyCallback();
    }

    function fillAccount() {
        const user = userPool.getCurrentUser();
        if (!user) return;
        user.getSession((err, session) => {
            if (err || !session) return;
            const token = session.getIdToken().getJwtToken();
            const payload = decodeJwtPayload(token) || {};
            const email = payload.email || payload['cognito:username'] || '';
            const role = roleFromToken(token);
            document.getElementById('shell-account-email').textContent = email;
            document.getElementById('shell-account-initial').textContent = email.charAt(0) || '?';
            document.getElementById('shell-account-role').textContent = role ? ROLE_LABELS[role.level] : 'No admin role';
        });
    }

    // Wordmark follows the naming_mode lever (dsco|borg).
    function applyBrand() {
        api('realtime', '/admin/config/get').then(data => {
            const mode = (data.levers && data.levers.naming_mode) || data.naming_mode;
            if (mode === 'borg') document.querySelectorAll('.sidebar .wordmark, .topbar .wordmark').forEach(el => { el.textContent = 'BORG'; });
        }).catch(() => { /* cosmetic; never block the shell */ });
    }

    // ---- Sidebar counts (pending work), cached a minute per env ----
    const COUNTS_KEY = `dscoAdmin.counts.${envName}`;

    function applyCounts(counts) {
        document.querySelectorAll('.nav-count[data-count]').forEach(el => {
            const n = counts[el.dataset.count];
            el.hidden = !(typeof n === 'number' && n > 0);
            el.textContent = n >= 50 ? '50+' : String(n);
            el.classList.toggle('attention', n > 0);
            el.setAttribute('aria-label', `${n} pending`);
        });
    }

    function readCounts() {
        try { return JSON.parse(storageGet('sessionStorage', COUNTS_KEY) || 'null'); } catch (_) { return null; }
    }

    /** Pages that already know a count (after loading or acting) keep the badge in sync. */
    function setCount(key, n) {
        const counts = { ...(readCounts() || {}), [key]: n, at: Date.now() };
        storageSet('sessionStorage', COUNTS_KEY, JSON.stringify(counts));
        applyCounts(counts);
    }

    let countsInFlight = null;

    /** Pending counts for the sidebar; concurrent callers share one request. */
    function refreshCounts() {
        if (!countsInFlight) {
            countsInFlight = fetchCounts().finally(() => { countsInFlight = null; });
        }
        return countsInFlight;
    }

    async function fetchCounts() {
        const cached = readCounts();
        if (cached && Date.now() - cached.at < 60000) {
            applyCounts(cached);
            return;
        }
        const [reports, appeals] = await Promise.allSettled([
            api('social', '/reports/list?status=pending', null, { method: 'GET' }),
            api('realtime', '/admin/appeals/list', { status: 'pending' }),
        ]);
        // Only a fully successful fetch is cached as fresh; a failure (expired
        // session, missing group) must not stick for the next minute.
        const ok = reports.status === 'fulfilled' && appeals.status === 'fulfilled';
        const counts = { at: ok ? Date.now() : 0 };
        if (reports.status === 'fulfilled') counts.reports = (reports.value.reports || []).length;
        if (appeals.status === 'fulfilled') counts.appeals = (appeals.value.appeals || []).length;
        storageSet('sessionStorage', COUNTS_KEY, JSON.stringify(counts));
        applyCounts(counts);
    }

    // ================================================================
    // Auth
    // ================================================================

    function loginError(message) {
        const el = document.getElementById('shell-login-error');
        el.textContent = message;
        el.style.display = message ? 'block' : 'none';
    }

    function showLoginPane(id) {
        ['shell-login-form', 'shell-newpw-form', 'shell-totp-form', 'shell-totp-setup', 'shell-forgot-form', 'shell-reset-form'].forEach(pane => {
            document.getElementById(pane).hidden = pane !== id;
        });
        loginError('');
    }

    // ---- Forgot password (code to the account's verified email) ----
    let resetUser = null;

    function sendResetCode() {
        const email = document.getElementById('shell-forgot-email').value.trim();
        if (!email) return loginError('Enter your email.');
        const btn = document.getElementById('shell-forgot-btn');
        btn.disabled = true;
        resetUser = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        resetUser.forgotPassword({
            onSuccess: () => { btn.disabled = false; },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Couldn\'t send a code. Try again.'); },
            inputVerificationCode: () => {
                btn.disabled = false;
                showLoginPane('shell-reset-form');
                document.getElementById('shell-reset-code').focus();
            },
        });
    }

    function confirmReset() {
        const code = document.getElementById('shell-reset-code').value.trim();
        const password = document.getElementById('shell-reset-password').value;
        if (!code) return loginError('Enter the code from your email.');
        if (!password || password.length < 8) return loginError('Use at least 8 characters.');
        const btn = document.getElementById('shell-reset-btn');
        btn.disabled = true;
        resetUser.confirmPassword(code, password, {
            onSuccess: () => {
                btn.disabled = false;
                document.getElementById('shell-email').value = resetUser.getUsername();
                document.getElementById('shell-password').value = '';
                showLoginPane('shell-login-form');
                document.getElementById('shell-password').focus();
            },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Couldn\'t set the password. Try again.'); },
        });
    }

    function login() {
        const email = document.getElementById('shell-email').value.trim();
        const password = document.getElementById('shell-password').value;
        if (!email || !password) return loginError('Enter your email and password.');

        const btn = document.getElementById('shell-login-btn');
        btn.classList.add('busy');
        btn.disabled = true;
        const done = () => { btn.classList.remove('busy'); btn.disabled = false; };
        cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        cognitoUser.authenticateUser(
            new AmazonCognitoIdentity.AuthenticationDetails({ Username: email, Password: password }),
            {
                onSuccess: (session) => {
                    done();
                    if (!roleFromToken(session.getIdToken().getJwtToken())) {
                        loginError('Signed in, but this account isn\'t in an admin group. Ask for super_admin, then sign out and back in.');
                    }
                    enforceMfa(cognitoUser).then(showApp);
                },
                onFailure: (err) => { done(); loginError(err.message || 'Couldn\'t sign in. Try again.'); },
                newPasswordRequired: () => { done(); showLoginPane('shell-newpw-form'); },
                totpRequired: () => {
                    done();
                    showLoginPane('shell-totp-form');
                    document.getElementById('shell-totp-code').focus();
                },
                mfaRequired: () => {
                    // SMS MFA isn't configured on the pool; only TOTP is.
                    done();
                    loginError('This account uses SMS codes, which the console doesn\'t support. Switch it to an authenticator app.');
                },
            }
        );
    }

    function submitTotp() {
        const code = document.getElementById('shell-totp-code').value.trim();
        if (!/^\d{6}$/.test(code)) return loginError('Enter the 6-digit code.');
        const btn = document.getElementById('shell-totp-btn');
        btn.disabled = true;
        cognitoUser.sendMFACode(code, {
            onSuccess: () => { btn.disabled = false; showApp(); },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'That code didn\'t work. Try the next one.'); },
        }, 'SOFTWARE_TOKEN_MFA');
    }

    /**
     * Console policy: every account that reaches the shell has TOTP as its
     * preferred MFA. The pool runs MFA OPTIONAL (app users are untouched),
     * so this gate is what makes it mandatory for admins. Resolves when the
     * account already has TOTP; otherwise shows enrollment and never resolves
     * (completeTotpSetup opens the shell itself).
     */
    function enforceMfa(user) {
        return new Promise((resolve) => {
            user.getUserData((err, data) => {
                if (err) {
                    showLogin();
                    loginError(`Couldn't read your MFA settings: ${err.message || err}`);
                    return;
                }
                if (data && data.PreferredMfaSetting === 'SOFTWARE_TOKEN_MFA') return resolve();
                showLogin();
                beginTotpSetup(user);
            }, { bypassCache: true });
        });
    }

    function beginTotpSetup(user) {
        user.associateSoftwareToken({
            associateSecretCode: (secret) => {
                const email = document.getElementById('shell-email').value.trim() || user.getUsername();
                const label = 'DSCO admin';
                const uri = `otpauth://totp/${encodeURIComponent(label)}:${encodeURIComponent(email)}` +
                    `?secret=${secret}&issuer=${encodeURIComponent(label)}&algorithm=SHA1&digits=6&period=30`;
                document.getElementById('shell-totp-secret').textContent = secret;
                renderQr(document.getElementById('shell-totp-qr'), uri);
                showLoginPane('shell-totp-setup');
                document.getElementById('shell-totp-setup-code').focus();
            },
            onFailure: (err) => loginError(err.message || 'Couldn\'t start authenticator setup. Try again.'),
        });
    }

    function completeTotpSetup() {
        const code = document.getElementById('shell-totp-setup-code').value.trim();
        if (!/^\d{6}$/.test(code)) return loginError('Enter the 6-digit code from the app.');
        const btn = document.getElementById('shell-totp-setup-btn');
        btn.disabled = true;
        cognitoUser.verifySoftwareToken(code, 'DSCO admin console', {
            onSuccess: () => {
                cognitoUser.setUserMfaPreference(null, { PreferredMfa: true, Enabled: true }, (err) => {
                    btn.disabled = false;
                    if (err) return loginError(err.message || 'Couldn\'t turn on the authenticator. Try again.');
                    showApp();
                });
            },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'That code didn\'t work. Check your phone\'s clock and try the next code.'); },
        });
    }

    /** QR via the qrcode-generator global (loaded from cdnjs on every admin page). */
    function renderQr(el, text) {
        el.innerHTML = '';
        if (typeof qrcode !== 'function') {
            el.textContent = 'QR code unavailable. Type the key below instead.';
            return;
        }
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }

    function completeNewPassword() {
        const newPassword = document.getElementById('shell-newpw').value;
        if (!newPassword || newPassword.length < 8) return loginError('Use at least 8 characters.');
        const btn = document.getElementById('shell-newpw-btn');
        btn.disabled = true;
        cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
            onSuccess: () => { btn.disabled = false; enforceMfa(cognitoUser).then(showApp); },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Couldn\'t set the password. Try again.'); },
        });
    }

    function signOut() {
        const user = userPool.getCurrentUser();
        if (user) user.signOut();
        try { window.sessionStorage.clear(); } catch (_) { /* ignore */ }
        window.location.reload();
    }

    /**
     * Force-refresh the session so Cognito group changes (super_admin
     * add/remove) land in a new ID token; getSession() alone reuses a
     * still-valid pre-group token for hours.
     */
    function refreshSession(user, session) {
        return new Promise((resolve) => {
            const refreshToken = session.getRefreshToken();
            if (!refreshToken) return resolve(session);
            user.refreshSession(refreshToken, (err, newSession) => {
                if (err || !newSession) {
                    console.warn('DSCO admin: refreshSession failed, using existing session', err);
                    return resolve(session);
                }
                resolve(newSession);
            });
        });
    }

    let tokenPromise = null;

    function getValidToken() {
        // One refresh in flight per page load, shared by parallel API calls.
        if (tokenPromise) return tokenPromise;
        tokenPromise = new Promise((resolve, reject) => {
            const user = userPool.getCurrentUser();
            if (!user) return reject(new Error('Not signed in'));
            user.getSession(async (err, session) => {
                if (err || !session || !session.isValid()) return reject(err || new Error('Your session expired. Sign in again.'));
                try {
                    const fresh = await refreshSession(user, session);
                    resolve(fresh.getIdToken().getJwtToken());
                } catch (e) {
                    reject(e);
                }
            });
        });
        const current = tokenPromise;
        current.then(
            () => setTimeout(() => { if (tokenPromise === current) tokenPromise = null; }, 30000),
            () => { if (tokenPromise === current) tokenPromise = null; }
        );
        return current;
    }

    function decodeJwtPayload(token) {
        try {
            const part = token.split('.')[1];
            return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        } catch (_) {
            return null;
        }
    }

    /** Highest admin role from cognito:groups, or null. */
    function roleFromToken(token) {
        const payload = decodeJwtPayload(token);
        if (!payload) return null;
        let groups = payload['cognito:groups'] || [];
        if (typeof groups === 'string') groups = groups.split(',').map(g => g.trim());
        const map = {
            super_admin: 3, 'super-admin': 3, superadmin: 3,
            admin: 2,
            moderator: 1, mod: 1,
        };
        let best = null;
        for (const g of groups) {
            const r = map[String(g).toLowerCase()];
            if (r && (best == null || r > best.level)) best = { name: g, level: r };
        }
        return best;
    }

    /**
     * Call an API service. Defaults to POST with a JSON body.
     *   api('realtime', '/admin/config/get')
     *   api('social', '/reports/list?status=pending', null, { method: 'GET' })
     */
    async function api(service, path, body, options = {}) {
        const token = await getValidToken();
        const method = (options.method || 'POST').toUpperCase();
        // The Cognito authorizer expects the ID token (an access token gets 401).
        const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
        const init = { method, headers };
        if (method !== 'GET' && method !== 'HEAD') {
            headers['Content-Type'] = headers['Content-Type'] || 'application/json';
            init.body = JSON.stringify(body || {});
        }
        let response;
        try {
            response = await fetch(`${API[service]}${path}`, init);
        } catch (_) {
            throw new Error(`Couldn't reach the ${env.label.toLowerCase()} API. Check your connection.`);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401) {
                throw new Error(`The ${env.label.toLowerCase()} API rejected your sign-in. If you just switched environments, its admin routes may not be deployed yet.`);
            }
            const msg = data.error || data.message || `${service}${path} failed (${response.status})`;
            if (/admin access required/i.test(msg)) {
                const payload = decodeJwtPayload(token) || {};
                throw new Error(`${msg}. Signed in as ${payload.email || '?'} with groups ${JSON.stringify(payload['cognito:groups'] || [])}. Sign out and back in if you were just added to a group.`);
            }
            throw new Error(msg);
        }
        return data;
    }

    function init({ active, title, onReady }) {
        onReadyCallback = onReady || null;
        renderShell(active, title);
        const user = userPool.getCurrentUser();
        if (!user) return showLogin();
        user.getSession(async (err, session) => {
            if (err || !session || !session.isValid()) return showLogin();
            try {
                // Always mint a fresh ID token so Cognito group changes apply.
                session = await refreshSession(user, session);
            } catch (_) { /* keep session */ }
            cognitoUser = user;
            enforceMfa(user).then(showApp);
        });
    }

    return {
        init,
        api,
        getValidToken,
        roleFromToken,
        switchEnv,
        setCount,
        refreshCounts,
        API,
        env: envName,
        isProd,
        envConfig: env,
        firebaseProjectId: env.firebaseProjectId,
        ui: {
            esc, icon, time, relative, timeTag, number, toDate,
            loading, empty, error, notice, dialog, confirm, busy, media,
        },
    };
})();
