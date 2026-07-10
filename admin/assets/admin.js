/*
 * Shared shell for DSCO admin pages: Cognito auth, API helper, header/nav,
 * login overlay. Used by the new-generation pages (overview, levers, costs,
 * crashes); the original pages (reports, users, appeals, content, audit,
 * transparency) are self-contained and predate this module.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6/dist/amazon-cognito-identity.min.js"></script>
 *   <script src="assets/admin.js"></script>
 *   <script>AdminShell.init({ active: 'levers', onReady: loadPage });</script>
 */
const AdminShell = (() => {
    const COGNITO_USER_POOL_ID = 'us-west-1_3Z2uwqvBT';
    const COGNITO_CLIENT_ID = 'p5g5ou0a6r9la6it2c92tlje5';
    const API = {
        core: 'https://api.dsco.dev/core',
        social: 'https://api.dsco.dev/social',
        map: 'https://api.dsco.dev/map',
        content: 'https://api.dsco.dev/content',
        realtime: 'https://api.dsco.dev/realtime',
    };

    const NAV_ITEMS = [
        ['index.html', 'Overview'],
        ['reports.html', 'Reports'],
        ['users.html', 'Users'],
        ['appeals.html', 'Appeals'],
        ['content.html', 'Content'],
        ['audit.html', 'Audit'],
        ['transparency.html', 'Transparency'],
        ['levers.html', 'Levers'],
        ['costs.html', 'Costs'],
        ['crashes.html', 'Crashes'],
    ];

    const userPool = new AmazonCognitoIdentity.CognitoUserPool({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
    });

    let cognitoUser = null;
    let onReadyCallback = null;

    function renderShell(active, title) {
        const nav = NAV_ITEMS.map(([href, label]) =>
            `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`
        ).join('');

        document.body.insertAdjacentHTML('afterbegin', `
            <div class="login-overlay" id="shell-login" style="display:none">
                <div class="login-box">
                    <h1>DSCO</h1>
                    <div class="sub">Admin console</div>
                    <div class="login-error" id="shell-login-error"></div>
                    <div id="shell-login-form">
                        <input type="email" id="shell-email" placeholder="Email" autocomplete="username">
                        <input type="password" id="shell-password" placeholder="Password" autocomplete="current-password">
                        <button class="btn" id="shell-login-btn">Sign in</button>
                    </div>
                    <div id="shell-newpw-form" style="display:none">
                        <div class="sub" style="margin-bottom:10px">Set a new password to continue</div>
                        <input type="password" id="shell-newpw" placeholder="New password (min 8 chars)">
                        <button class="btn" id="shell-newpw-btn">Set password &amp; sign in</button>
                    </div>
                </div>
            </div>
            <div class="header" id="shell-header" style="display:none">
                <h1>${title || 'DSCO ADMIN'}</h1>
                <div class="header-nav">${nav}</div>
                <div class="header-actions">
                    <button id="shell-signout">Sign out</button>
                </div>
            </div>
        `);

        document.getElementById('shell-login-btn').addEventListener('click', login);
        document.getElementById('shell-password').addEventListener('keydown', e => {
            if (e.key === 'Enter') login();
        });
        document.getElementById('shell-newpw-btn').addEventListener('click', completeNewPassword);
        document.getElementById('shell-signout').addEventListener('click', signOut);
    }

    function showLogin() {
        document.getElementById('shell-login').style.display = 'flex';
        document.getElementById('shell-header').style.display = 'none';
        document.querySelectorAll('.container').forEach(el => el.style.display = 'none');
    }

    function showApp() {
        document.getElementById('shell-login').style.display = 'none';
        document.getElementById('shell-header').style.display = 'flex';
        document.querySelectorAll('.container').forEach(el => el.style.display = '');
        if (onReadyCallback) onReadyCallback();
    }

    function loginError(message) {
        const el = document.getElementById('shell-login-error');
        el.textContent = message;
        el.style.display = 'block';
    }

    function login() {
        const email = document.getElementById('shell-email').value.trim();
        const password = document.getElementById('shell-password').value;
        if (!email || !password) return loginError('Enter email and password.');

        const btn = document.getElementById('shell-login-btn');
        btn.disabled = true;
        cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        cognitoUser.authenticateUser(
            new AmazonCognitoIdentity.AuthenticationDetails({ Username: email, Password: password }),
            {
                onSuccess: (session) => {
                    btn.disabled = false;
                    const role = roleFromToken(session.getIdToken().getJwtToken());
                    if (!role) {
                        const payload = decodeJwtPayload(session.getIdToken().getJwtToken()) || {};
                        const groups = payload['cognito:groups'] || [];
                        loginError(
                            'Signed in, but this account has no admin Cognito group ' +
                            `(got: ${JSON.stringify(groups) || 'none'}). ` +
                            'Ask for super_admin, then sign out and back in.'
                        );
                        // Still open the shell so Sign out is available
                    }
                    showApp();
                },
                onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Authentication failed.'); },
                newPasswordRequired: () => {
                    btn.disabled = false;
                    document.getElementById('shell-login-form').style.display = 'none';
                    document.getElementById('shell-newpw-form').style.display = 'block';
                },
            }
        );
    }

    function completeNewPassword() {
        const newPassword = document.getElementById('shell-newpw').value;
        if (!newPassword || newPassword.length < 8) return loginError('Password must be at least 8 characters.');
        const btn = document.getElementById('shell-newpw-btn');
        btn.disabled = true;
        cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
            onSuccess: () => { btn.disabled = false; showApp(); },
            onFailure: (err) => { btn.disabled = false; loginError(err.message || 'Failed to set password.'); },
        });
    }

    function signOut() {
        const user = userPool.getCurrentUser();
        if (user) user.signOut();
        window.location.reload();
    }

    /**
     * Force-refresh the Cognito session so group membership changes
     * (super_admin add/remove) land in a new ID token. getSession() alone
     * reuses a still-valid pre-group token for hours.
     */
    function refreshSession(user, session) {
        return new Promise((resolve, reject) => {
            const refreshToken = session.getRefreshToken();
            if (!refreshToken) return resolve(session);
            user.refreshSession(refreshToken, (err, newSession) => {
                if (err || !newSession) {
                    // Fall back to existing session rather than kicking to login
                    console.warn('DSCO admin: refreshSession failed, using existing session', err);
                    return resolve(session);
                }
                resolve(newSession);
            });
        });
    }

    function getValidToken() {
        return new Promise((resolve, reject) => {
            const user = userPool.getCurrentUser();
            if (!user) return reject(new Error('Not signed in'));
            user.getSession(async (err, session) => {
                if (err || !session || !session.isValid()) return reject(err || new Error('Session expired'));
                try {
                    const fresh = await refreshSession(user, session);
                    resolve(fresh.getIdToken().getJwtToken());
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    function decodeJwtPayload(token) {
        try {
            const part = token.split('.')[1];
            const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
            return JSON.parse(json);
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

    /** POST to an API service. api('realtime', '/admin/config/get', {...}) */
    async function api(service, path, body) {
        const token = await getValidToken();
        // Cognito User Pool authorizer expects the *ID* token (access token → 401).
        const response = await fetch(`${API[service]}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body || {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const msg = data.error || data.message || `${service}${path} failed (${response.status})`;
            if (/admin access required/i.test(msg)) {
                const payload = decodeJwtPayload(token) || {};
                const groups = payload['cognito:groups'] || [];
                const email = payload.email || payload['cognito:username'] || '?';
                throw new Error(
                    `${msg} (signed in as ${email}; token groups: ${JSON.stringify(groups)}. ` +
                    'Sign out and back in if you were just added to super_admin.)'
                );
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
            const role = roleFromToken(session.getIdToken().getJwtToken());
            if (!role) {
                const payload = decodeJwtPayload(session.getIdToken().getJwtToken()) || {};
                console.warn(
                    'DSCO admin: no admin group on ID token',
                    payload.email || payload['cognito:username'],
                    payload['cognito:groups']
                );
            }
            showApp();
        });
    }

    return { init, api, getValidToken, roleFromToken, API };
})();
