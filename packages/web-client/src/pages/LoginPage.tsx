import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
import { login } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
import type { UserProfile } from '../api/types.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { setTokens, setProfile } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const tokens = await login(email, password);
      setTokens(tokens.accessToken, tokens.refreshToken);
      // Fetch profile after setting token
      const profile = await api.get<UserProfile>('/user/profile');
      setProfile(profile.id, profile.email, profile.displayName, profile.role);
      navigate('/mail');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800">
      <div className="bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
            <Mail size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">CoreMail</h1>
            <p className="text-xs text-gray-500">Outlook Web Access</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail-Adresse</label>
            <div className="relative">
              <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-9"
                placeholder="benutzer@domain.com"
                required
                autoComplete="email"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Passwort</label>
            <div className="relative">
              <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-9"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
            {loading ? 'Anmelden...' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}
