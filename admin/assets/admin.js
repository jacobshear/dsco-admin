/*
 * Shared shell for every DSCO admin page: sign-in, API helper, sidebar,
 * env switch, and the UI primitives pages build with (AdminShell.ui).
 *
 * One account for both environments: the console always signs in with the
 * prod Cognito pool, and the dev/staging admin routes trust that pool too
 * (backend config/shared.yml adminCognitoArnsByStage). Switching Dev/Prod
 * only changes which API the page talks to, so it never signs you out.
 * Sign-in is email + password, or a passkey (Touch ID / Face ID) once one is
 * added from the sidebar or the offer after a password sign-in. The
 * authenticator-app (TOTP) requirement was removed 2026-10-17.
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
        region: 'us-west-1',
        // Pool WebAuthnConfiguration.RelyingPartyId: passkeys work on dsco.dev
        // and its subdomains only, never localhost.
        passkeyRpId: 'dsco.dev',
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

    function storageRemove(store, key) {
        try { window[store].removeItem(key); } catch (_) { /* private mode */ }
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
                ['instagram.html', 'Instagram events', 'pin'],
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
        'instagram.html': 'Seed a public event pin from an Instagram post.',
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
        key: '<circle cx="7.5" cy="15.5" r="5"/><path d="m11 12 9.5-9.5"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/>',
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
                        <div class="field" id="shell-password-field">
                            <label for="shell-password">Password</label>
                            <input type="password" id="shell-password" autocomplete="current-password" required>
                        </div>
                        <button class="btn primary" id="shell-login-btn" type="submit">Sign in</button>
                        <button class="btn" id="shell-passkey-btn" type="button" hidden>${icon('key')}Sign in with passkey</button>
                        <button class="btn plain block" id="shell-use-password" type="button" hidden>Use your password instead</button>
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
                    <button type="button" class="btn sm block" id="shell-passkeys"${passkeysAvailable ? '' : ' hidden'}>${icon('key')}Passkeys</button>
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
        on('shell-login-form', 'submit', (e) => {
            e.preventDefault();
            if (loginMode === 'passkey') passkeySignIn(document.getElementById('shell-login-btn'));
            else login();
        });
        on('shell-passkey-btn', 'click', (e) => passkeySignIn(e.currentTarget));
        on('shell-use-password', 'click', () => {
            setLoginMode('password');
            document.getElementById('shell-password').focus();
        });
        on('shell-passkeys', 'click', openPasskeys);
        on('shell-newpw-form', 'submit', (e) => { e.preventDefault(); completeNewPassword(); });
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

        // A browser where a passkey has signed in before leads with it.
        const saved = passkeysAvailable ? savedPasskey() : null;
        if (saved) document.getElementById('shell-email').value = saved.username;
        setLoginMode(saved ? 'passkey' : 'password');
        on('shell-email', 'input', scheduleSignInWarm);

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
        if (loginMode === 'passkey') signInChallenge.warm(document.getElementById('shell-email').value.trim());
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

    // Counts read off a single list page, so a full page means "at least this
    // many". Reports carry an exact `total` from the backend instead.
    const PAGE_CAPPED_COUNTS = { appeals: 50 };

    function badgeText(key, n) {
        const cap = PAGE_CAPPED_COUNTS[key];
        if (cap && n >= cap) return `${cap}+`;
        return n > 99 ? '99+' : String(n);
    }

    function applyCounts(counts) {
        document.querySelectorAll('.nav-count[data-count]').forEach(el => {
            const key = el.dataset.count;
            const n = counts[key];
            el.hidden = !(typeof n === 'number' && n > 0);
            el.textContent = badgeText(key, n);
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
        // `total` counts every pending report; the list itself is one page.
        if (reports.status === 'fulfilled') counts.reports = reports.value.total ?? (reports.value.reports || []).length;
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
        ['shell-login-form', 'shell-newpw-form', 'shell-forgot-form', 'shell-reset-form'].forEach(pane => {
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
                    if (finishSignIn(session)) offerPasskey();
                },
                onFailure: (err) => { done(); loginError(err.message || 'Couldn\'t sign in. Try again.'); },
                newPasswordRequired: () => { done(); showLoginPane('shell-newpw-form'); },
                // The console no longer takes MFA codes. An account that still
                // has one turned on needs it cleared in Cognito
                // (admin-set-user-mfa-preference) before it can sign in here.
                totpRequired: () => {
                    done();
                    loginError('This account still has an authenticator code turned on. Clear it in Cognito, then sign in again.');
                },
                mfaRequired: () => {
                    done();
                    loginError('This account has SMS codes turned on. Clear them in Cognito, then sign in again.');
                },
            }
        );
    }

    function completeNewPassword() {
        const newPassword = document.getElementById('shell-newpw').value;
        if (!newPassword || newPassword.length < 8) return loginError('Use at least 8 characters.');
        const btn = document.getElementById('shell-newpw-btn');
        btn.disabled = true;
        cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
            onSuccess: (session) => { btn.disabled = false; if (finishSignIn(session)) offerPasskey(); },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Couldn\'t set the password. Try again.'); },
        });
    }

    /**
     * After any sign-in: open the console, and warn (in a notice, since the
     * sign-in overlay is gone by then) when the account has no admin group.
     * Returns whether it has one.
     */
    function finishSignIn(session) {
        const isAdmin = !!roleFromToken(session.getIdToken().getJwtToken());
        showApp();
        if (!isAdmin) {
            notice('Signed in, but this account isn\'t in an admin group. Ask for super_admin, then sign out and back in.', { tone: 'bad' });
        }
        return isAdmin;
    }

    // ---- Passkeys (WebAuthn through Cognito choice-based sign-in) ----
    //
    // amazon-cognito-identity-js v6 predates USER_AUTH, so passkey calls go
    // straight to the Cognito API. A passkey sign-in hands its tokens to the
    // library's session store, so refresh, getValidToken and the role checks
    // work exactly as after a password sign-in.
    //
    // Cognito tokens don't record how you signed in, so leading with the
    // passkey here is a console preference, not enforcement: the password
    // still signs in (and stays one click away, so a lost passkey can't lock
    // anyone out).

    // { username, credentialId } of the last passkey that signed in on this
    // browser. The login form leads with it until that passkey is removed.
    const PASSKEY_KEY = 'dscoAdmin.passkey';
    // The pool's relying party is dsco.dev, so passkeys work nowhere else.
    const passkeysAvailable = typeof window.PublicKeyCredential === 'function' && !!navigator.credentials
        && (window.location.hostname === AUTH.passkeyRpId || window.location.hostname.endsWith(`.${AUTH.passkeyRpId}`));
    let loginMode = 'password';

    function savedPasskey() {
        try {
            const saved = JSON.parse(storageGet('localStorage', PASSKEY_KEY) || 'null');
            return saved && saved.username && saved.credentialId ? saved : null;
        } catch (_) {
            return null;
        }
    }

    /** Stop leading with the saved passkey, but only if it belongs to username. */
    function forgetPasskey(username) {
        const saved = savedPasskey();
        if (saved && saved.username === username) storageRemove('localStorage', PASSKEY_KEY);
    }

    function currentUsername() {
        const user = userPool.getCurrentUser();
        return user ? user.getUsername() : '';
    }

    function setLoginMode(mode) {
        loginMode = mode;
        const passkey = mode === 'passkey';
        document.getElementById('shell-password-field').hidden = passkey;
        document.getElementById('shell-password').required = !passkey;
        document.getElementById('shell-login-btn').innerHTML = passkey ? `${icon('key')}Sign in with passkey` : 'Sign in';
        document.getElementById('shell-passkey-btn').hidden = passkey || !passkeysAvailable;
        document.getElementById('shell-use-password').hidden = !passkey;
        document.getElementById('shell-forgot-link').hidden = passkey;
        loginError('');
    }

    /** Unsigned Cognito API call: public operations and ones authorized by an access token in the body. */
    async function cognito(operation, body) {
        let response;
        try {
            response = await fetch(`https://cognito-idp.${AUTH.region}.amazonaws.com/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-amz-json-1.1',
                    'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
                },
                body: JSON.stringify(body),
            });
        } catch (_) {
            throw new Error('Couldn\'t reach Cognito. Check your connection.');
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const code = String(data.__type || '').split('#').pop();
            throw Object.assign(new Error(data.message || `${operation} failed (${response.status})`), { code });
        }
        return data;
    }

    // Safari only opens the passkey sheet close to the click that asked for
    // it, so the Cognito round trip runs ahead of the click where it can: the
    // sign-in challenge once the email is known, registration options when a
    // passkey dialog opens. Cognito auth sessions last 3 minutes; anything
    // older than 2 is fetched again. Each result is used once.
    const PREFETCH_MAX_AGE_MS = 120000;

    function prefetcher(load) {
        let entry = null;
        const fresh = (key) => entry && entry.key === key && Date.now() - entry.at < PREFETCH_MAX_AGE_MS;
        return {
            warm(key) {
                if (!key || fresh(key)) return;
                entry = { key, at: Date.now(), promise: load(key) };
                entry.promise.catch(() => { /* take() refetches */ });
            },
            take(key) {
                const hit = fresh(key) ? entry.promise : null;
                entry = null;
                return hit ? hit.catch(() => load(key)) : load(key);
            },
        };
    }

    const signInChallenge = prefetcher(username => cognito('InitiateAuth', {
        AuthFlow: 'USER_AUTH',
        ClientId: AUTH.clientId,
        AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'WEB_AUTHN' },
    }));

    const registrationOptions = prefetcher(async () => {
        const { CredentialCreationOptions } = await cognito('StartWebAuthnRegistration', { AccessToken: await getAccessToken() });
        return CredentialCreationOptions;
    });

    let warmTimer = null;

    /** Prefetch the sign-in challenge once the typed email looks complete. */
    function scheduleSignInWarm() {
        if (!passkeysAvailable) return;
        clearTimeout(warmTimer);
        warmTimer = setTimeout(() => {
            const input = document.getElementById('shell-email');
            if (input.value.trim() && input.checkValidity()) signInChallenge.warm(input.value.trim());
        }, 500);
    }

    /** Request options from Cognito (base64url strings) to what the browser takes (buffers). */
    function decodeCredentialIds(list) {
        return (list || []).map(c => ({ ...c, id: fromB64url(c.id) }));
    }

    /** A PublicKeyCredential as the RegistrationResponseJSON / AuthenticationResponseJSON Cognito expects. */
    function credentialJson(credential) {
        const r = credential.response;
        const response = { clientDataJSON: toB64url(r.clientDataJSON) };
        if (r.attestationObject) {
            response.attestationObject = toB64url(r.attestationObject);
            response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
        } else {
            response.authenticatorData = toB64url(r.authenticatorData);
            response.signature = toB64url(r.signature);
            if (r.userHandle) response.userHandle = toB64url(r.userHandle);
        }
        const json = {
            id: credential.id,
            rawId: toB64url(credential.rawId),
            type: credential.type,
            response,
            clientExtensionResults: typeof credential.getClientExtensionResults === 'function'
                ? credential.getClientExtensionResults() : {},
        };
        if (credential.authenticatorAttachment) json.authenticatorAttachment = credential.authenticatorAttachment;
        return json;
    }

    function passkeyErrorMessage(err, action) {
        switch (err && err.name) {
            case 'NotAllowedError': return `${action} was cancelled or timed out.`;
            case 'SecurityError': return `Passkeys only work on ${AUTH.passkeyRpId}.`;
            case 'InvalidStateError': return 'This device already has a passkey for this account.';
            default: return (err && err.message) || `${action} didn't work. Try again.`;
        }
    }

    /** Hand tokens from a direct Cognito call to the library, as a password sign-in would. */
    function storeSession(result) {
        const C = AmazonCognitoIdentity;
        const session = new C.CognitoUserSession({
            IdToken: new C.CognitoIdToken({ IdToken: result.IdToken }),
            AccessToken: new C.CognitoAccessToken({ AccessToken: result.AccessToken }),
            RefreshToken: new C.CognitoRefreshToken({ RefreshToken: result.RefreshToken }),
        });
        const username = (decodeJwtPayload(result.AccessToken) || {}).username;
        cognitoUser = new C.CognitoUser({ Username: username, Pool: userPool });
        cognitoUser.setSignInUserSession(session);
        return session;
    }

    async function passkeySignIn(button) {
        const emailInput = document.getElementById('shell-email');
        const email = emailInput.value.trim();
        if (!email) {
            emailInput.focus();
            return loginError('Enter your email.');
        }
        loginError('');
        await busy(button, async () => {
            try {
                const start = await signInChallenge.take(email);
                if (start.ChallengeName !== 'WEB_AUTHN') {
                    forgetPasskey(email);
                    setLoginMode('password');
                    return loginError('No passkey for this email yet. Sign in with your password, then add one.');
                }
                const options = JSON.parse(start.ChallengeParameters.CREDENTIAL_REQUEST_OPTIONS);
                // The passkey this browser last used is gone: lead with the
                // password next time unless another passkey signs in now.
                const saved = savedPasskey();
                if (saved && saved.username === email && !(options.allowCredentials || []).some(c => c.id === saved.credentialId)) {
                    forgetPasskey(email);
                }
                const credential = await navigator.credentials.get({
                    publicKey: {
                        ...options,
                        challenge: fromB64url(options.challenge),
                        allowCredentials: decodeCredentialIds(options.allowCredentials),
                    },
                });
                const done = await cognito('RespondToAuthChallenge', {
                    ChallengeName: 'WEB_AUTHN',
                    ClientId: AUTH.clientId,
                    Session: start.Session,
                    ChallengeResponses: { USERNAME: email, CREDENTIAL: JSON.stringify(credentialJson(credential)) },
                });
                if (!done.AuthenticationResult) throw new Error('Cognito asked for another step this console doesn\'t support.');
                const session = storeSession(done.AuthenticationResult);
                storageSet('localStorage', PASSKEY_KEY, JSON.stringify({ username: cognitoUser.getUsername(), credentialId: credential.id }));
                finishSignIn(session);
            } catch (err) {
                loginError(passkeyErrorMessage(err, 'Passkey sign-in'));
                // The challenge is spent; have the next one ready for a retry.
                signInChallenge.warm(email);
            }
        });
    }

    /** Access token for the signed-in user (the passkey APIs take it, not the ID token). */
    function getAccessToken() {
        return new Promise((resolve, reject) => {
            const user = userPool.getCurrentUser();
            if (!user) return reject(new Error('Not signed in'));
            user.getSession((err, session) => {
                if (err || !session || !session.isValid()) return reject(err || new Error('Your session expired. Sign in again.'));
                resolve(session.getAccessToken().getJwtToken());
            });
        });
    }

    async function listPasskeys() {
        const data = await cognito('ListWebAuthnCredentials', { AccessToken: await getAccessToken(), MaxResults: 20 });
        return data.Credentials || [];
    }

    /** Register a passkey on this device. Resolves true once Cognito has it. */
    async function addPasskey() {
        try {
            const options = await registrationOptions.take(currentUsername());
            const credential = await navigator.credentials.create({
                publicKey: {
                    ...options,
                    challenge: fromB64url(options.challenge),
                    user: { ...options.user, id: fromB64url(options.user.id) },
                    excludeCredentials: decodeCredentialIds(options.excludeCredentials),
                },
            });
            await cognito('CompleteWebAuthnRegistration', { AccessToken: await getAccessToken(), Credential: credentialJson(credential) });
            notice('Passkey added. Next time you sign in, choose Sign in with passkey.', { tone: 'good', timeout: 8000 });
            return true;
        } catch (err) {
            notice(passkeyErrorMessage(err, 'Adding the passkey'), { tone: 'bad' });
            registrationOptions.warm(currentUsername()); // ready for a retry
            return false;
        }
    }

    /** After a password sign-in, offer a passkey once if the account has none. */
    async function offerPasskey() {
        if (!passkeysAvailable) return;
        let existing;
        try {
            existing = await listPasskeys();
        } catch (_) {
            return; // the offer is optional; never get in the way of the console
        }
        if (existing.length) return;
        registrationOptions.warm(currentUsername());
        dialog({
            title: 'Add a passkey?',
            body: '<p>Sign in with Touch ID or Face ID next time instead of typing your password.</p>',
            actions: [
                { label: 'Not now', onClick: (close) => close() },
                {
                    label: 'Add passkey',
                    kind: 'primary',
                    onClick: (close, b) => busy(b, async () => { if (await addPasskey()) close(); }),
                },
            ],
        });
    }

    /** Sidebar Passkeys dialog: list, add and remove this account's passkeys. */
    function openPasskeys() {
        const me = currentUsername();
        registrationOptions.warm(me);
        const body = document.createElement('div');
        dialog({
            title: 'Passkeys',
            body,
            actions: [{
                label: 'Add a passkey',
                kind: 'primary',
                onClick: (close, b) => busy(b, async () => {
                    if (!(await addPasskey())) return;
                    registrationOptions.warm(me); // for another add from this dialog
                    render();
                }),
            }],
        });

        async function remove(id, name) {
            const ok = await confirm({
                title: `Remove ${name}?`,
                body: 'It will no longer sign you in to this console.',
                confirmLabel: 'Remove',
            });
            if (!ok) return;
            try {
                await cognito('DeleteWebAuthnCredential', { AccessToken: await getAccessToken(), CredentialId: id });
            } catch (err) {
                notice(err.message || 'Couldn\'t remove the passkey.', { tone: 'bad' });
            }
            render();
        }

        async function render() {
            loading(body);
            let items;
            try {
                items = await listPasskeys();
            } catch (err) {
                return error(body, { title: 'Couldn\'t load your passkeys', error: err, onRetry: render });
            }
            const saved = savedPasskey();
            const usedHere = saved && saved.username === me ? saved.credentialId : null;
            if (usedHere && !items.some(c => c.CredentialId === usedHere)) forgetPasskey(me);
            body.innerHTML = `
                <p class="muted">Sign in with Touch ID or Face ID. Your password still works too.</p>
                ${items.length ? `<ul class="passkey-list">${items.map(c => `
                    <li>
                        <div class="passkey-name">${esc(c.FriendlyCredentialName || 'Passkey')}
                            <span class="faint">Added ${esc(time(c.CreatedAt))}${c.CredentialId === usedHere ? ' · signs in on this browser' : ''}</span></div>
                        <button type="button" class="btn sm danger" data-remove="${esc(c.CredentialId)}"
                            data-name="${esc(c.FriendlyCredentialName || 'this passkey')}">Remove</button>
                    </li>`).join('')}</ul>`
                : '<p class="passkey-empty">No passkeys yet.</p>'}`;
            body.querySelectorAll('[data-remove]').forEach(btn => {
                btn.addEventListener('click', () => remove(btn.dataset.remove, btn.dataset.name));
            });
        }

        render();
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

    function fromB64url(value) {
        const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
    }

    function toB64url(buffer) {
        let binary = '';
        new Uint8Array(buffer).forEach(b => { binary += String.fromCharCode(b); });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function decodeJwtPayload(token) {
        try {
            return JSON.parse(new TextDecoder().decode(fromB64url(token.split('.')[1])));
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
            throw Object.assign(new Error(msg), { status: response.status });
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
            showApp();
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
