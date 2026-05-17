const TOKEN_KEY = 'bcp-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`/api/v1${path}`, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    // Admin-Panel liegt unter /bcp — React Router basename="/bcp"
    window.location.href = '/bcp/login';
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
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST',  body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown)  => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown)  => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete:         <T>(path: string)              => request<T>(path, { method: 'DELETE' }),
  deleteWithBody: <T>(path: string, body: unknown) => request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }),
};

export type LoginResult =
  | { accessToken: string }
  | { mfaRequired: true; challengeToken: string; method: string };

export async function loginAdmin(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string };
    throw new Error(body.error);
  }
  return res.json() as Promise<LoginResult>;
}

export async function verifyMfaAdmin(
  challengeToken: string,
  code: string,
): Promise<string> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as { error: string };
    throw new Error(body.error);
  }
  const data = await res.json() as { accessToken: string };
  return data.accessToken;
}
