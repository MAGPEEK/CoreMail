import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock } from 'lucide-react';
import { login } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
export function LoginPage() {
    const navigate = useNavigate();
    const { setTokens, setProfile } = useAuthStore();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const tokens = await login(email, password);
            setTokens(tokens.accessToken, tokens.refreshToken);
            // Fetch profile after setting token
            const profile = await api.get('/user/profile');
            setProfile(profile.id, profile.email, profile.displayName, profile.role);
            navigate('/mail');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm", children: [_jsxs("div", { className: "flex items-center justify-center gap-2 mb-6", children: [_jsx("div", { className: "w-10 h-10 bg-accent rounded-lg flex items-center justify-center", children: _jsx(Mail, { size: 22, className: "text-white" }) }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "CoreMail" }), _jsx("p", { className: "text-xs text-gray-500", children: "Outlook Web Access" })] })] }), _jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "E-Mail-Adresse" }), _jsxs("div", { className: "relative", children: [_jsx(Mail, { size: 15, className: "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "input pl-9", placeholder: "benutzer@domain.com", required: true, autoComplete: "email" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Passwort" }), _jsxs("div", { className: "relative", children: [_jsx(Lock, { size: 15, className: "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), className: "input pl-9", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "current-password" })] })] }), error && (_jsx("div", { className: "bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700", children: error })), _jsx("button", { type: "submit", disabled: loading, className: "btn-primary w-full justify-center py-2 disabled:opacity-60", children: loading ? 'Anmelden...' : 'Anmelden' })] })] }) }));
}
