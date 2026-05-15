import { useAuthStore } from '../store/auth.js';
const BASE = '/api/v1';
async function request(path, init = {}) {
    const token = useAuthStore.getState().accessToken;
    const headers = {
        'Content-Type': 'application/json',
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
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: 'DELETE' }),
};
export async function login(email, password) {
    const res = await fetch('http://localhost:3003/auth/login', {
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
