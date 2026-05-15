import { useAuthStore } from '../store/auth.js';

const BASE = '/api/v1';

async function request<T>(path: string, init: RequestInit = {}, skipContentType = false): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    useAuthStore.getState().logout();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:      <T>(path: string)                   => request<T>(path),
  post:     <T>(path: string, body: unknown)    => request<T>(path, { method: 'POST',  body: JSON.stringify(body) }),
  postForm: <T>(path: string, form: FormData)   => request<T>(path, { method: 'POST',  body: form }, true),
  put:      <T>(path: string, body: unknown)    => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:    <T>(path: string, body: unknown)    => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete:   <T>(path: string)                   => request<T>(path, { method: 'DELETE' }),
};

export async function login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string };
    throw new Error(body.error);
  }
  return res.json() as Promise<{ accessToken: string; refreshToken: string }>;
}
