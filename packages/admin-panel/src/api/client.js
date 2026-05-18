const TOKEN_KEY = 'bcp-token';
export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}
async function request(path, init = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
    };
    const res = await fetch(`/api/v1${path}`, { ...init, headers });
    if (res.status === 401) {
        clearToken();
        // Admin-Panel liegt unter /bcp — React Router basename="/bcp"
        window.location.href = '/bcp/login';
        throw new Error('Unauthorized');
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    if (res.status === 204)
        return undefined;
    return res.json();
}
export const api = {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: 'DELETE' }),
    deleteWithBody: (path, body) => request(path, { method: 'DELETE', body: JSON.stringify(body) }),
};
export async function loginAdmin(email, password) {
    const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Login failed' }));
        throw new Error(body.error);
    }
    return res.json();
}
export async function verifyMfaAdmin(challengeToken, code) {
    const res = await fetch('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' }));
        throw new Error(body.error);
    }
    const data = await res.json();
    return data.accessToken;
}
