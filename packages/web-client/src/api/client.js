import { useAuthStore } from '../store/auth.js';
const BASE = '/api/v1';
async function request(path, init = {}, skipContentType = false) {
    const token = useAuthStore.getState().accessToken;
    const headers = {
        ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
    };
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    if (res.status === 401) {
        useAuthStore.getState().logout();
        window.location.href = '/login';
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
    postForm: (path, form) => request(path, { method: 'POST', body: form }, true),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: 'DELETE' }),
};
export async function login(email, password) {
    const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Login failed' }));
        // Wartungsmodus: message als Prefix übergeben damit LoginPage ihn erkennt
        if (body.error === 'maintenance') {
            throw new Error(`maintenance:${body.message ?? 'Wartungsmodus aktiv'}`);
        }
        throw new Error(body.error);
    }
    return res.json();
}
export async function verifyMfa(challengeToken, code) {
    const res = await fetch('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'MFA failed' }));
        throw new Error(body.error);
    }
    return res.json();
}
