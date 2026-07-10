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
                onSuccess: () => { btn.disabled = false; showApp(); },
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

    function getValidToken() {
        return new Promise((resolve, reject) => {
            const user = userPool.getCurrentUser();
            if (!user) return reject(new Error('Not signed in'));
            user.getSession((err, session) => {
                if (err || !session || !session.isValid()) return reject(err || new Error('Session expired'));
                resolve(session.getIdToken().getJwtToken());
            });
        });
    }

    /** POST to an API service. api('realtime', '/admin/config/get', {...}) */
    async function api(service, path, body) {
        const token = await getValidToken();
        const response = await fetch(`${API[service]}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': token },
            body: JSON.stringify(body || {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `${service}${path} failed (${response.status})`);
        return data;
    }

    function init({ active, title, onReady }) {
        onReadyCallback = onReady || null;
        renderShell(active, title);
        const user = userPool.getCurrentUser();
        if (!user) return showLogin();
        user.getSession((err, session) => {
            if (err || !session || !session.isValid()) return showLogin();
            showApp();
        });
    }

    return { init, api, getValidToken, API };
})();
