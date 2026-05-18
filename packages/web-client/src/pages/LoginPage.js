import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, ShieldCheck, ArrowLeft, AlertTriangle } from 'lucide-react';
import { login, verifyMfa } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { api } from '../api/client.js';
export function LoginPage() {
    const navigate = useNavigate();
    const { setTokens, setProfile } = useAuthStore();
    // Step 1: Credentials
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // Step 2: MFA
    const [step, setStep] = useState('credentials');
    const [challengeToken, setChallengeToken] = useState('');
    const [mfaMethod, setMfaMethod] = useState('totp');
    const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
    const digitRefs = useRef([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    // Wartungsmodus
    const [maintenanceMode, setMaintenanceMode] = useState(false);
    const [maintenanceMessage, setMaintenanceMessage] = useState('');
    // Wartungsstatus beim Laden abrufen (kein Auth nötig)
    useEffect(() => {
        fetch('/api/v1/maintenance')
            .then((r) => r.json())
            .then((d) => {
            setMaintenanceMode(d.maintenanceMode ?? false);
            setMaintenanceMessage(d.maintenanceMessage ?? '');
        })
            .catch(() => { });
    }, []);
    // Auto-focus first digit when entering MFA step
    useEffect(() => {
        if (step === 'mfa') {
            setTimeout(() => digitRefs.current[0]?.focus(), 50);
        }
    }, [step]);
    // ── Step 1: E-Mail + Passwort ────────────────────────────────────────────────
    const handleSubmitCredentials = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const result = await login(email, password);
            if ('mfaRequired' in result) {
                setChallengeToken(result.challengeToken);
                setMfaMethod(result.method);
                setStep('mfa');
            }
            else {
                const { accessToken, refreshToken } = result;
                await finalizeLogin(accessToken, refreshToken);
            }
        }
        catch (err) {
            // Wartungsmodus-Fehler explizit behandeln
            const msg = err instanceof Error ? err.message : '';
            if (msg.startsWith('maintenance:')) {
                setError(msg.replace('maintenance:', '').trim());
            }
            else {
                setError(msg || 'Anmeldung fehlgeschlagen');
            }
        }
        finally {
            setLoading(false);
        }
    };
    // ── Step 2: MFA-Code ─────────────────────────────────────────────────────────
    const handleSubmitMfa = async (e) => {
        e.preventDefault();
        const code = otpDigits.join('');
        if (code.length < 6) {
            setError('Bitte alle 6 Ziffern eingeben');
            return;
        }
        setError('');
        setLoading(true);
        try {
            const tokens = await verifyMfa(challengeToken, code);
            await finalizeLogin(tokens.accessToken, tokens.refreshToken);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Ungültiger Code');
            setOtpDigits(['', '', '', '', '', '']);
            setTimeout(() => digitRefs.current[0]?.focus(), 50);
        }
        finally {
            setLoading(false);
        }
    };
    const finalizeLogin = async (accessToken, refreshToken) => {
        setTokens(accessToken, refreshToken);
        const profile = await api.get('/user/profile');
        setProfile(profile.id, profile.email, profile.displayName, profile.role);
        navigate('/mail');
    };
    // ── OTP digit input helpers ──────────────────────────────────────────────────
    const handleDigitChange = (i, val) => {
        const digit = val.replace(/\D/g, '').slice(-1);
        const next = [...otpDigits];
        next[i] = digit;
        setOtpDigits(next);
        if (digit && i < 5)
            digitRefs.current[i + 1]?.focus();
    };
    const handleDigitKeyDown = (i, e) => {
        if (e.key === 'Backspace' && !otpDigits[i] && i > 0) {
            digitRefs.current[i - 1]?.focus();
        }
    };
    const handleDigitPaste = (e) => {
        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
        if (pasted.length === 6) {
            e.preventDefault();
            setOtpDigits(pasted.split(''));
            digitRefs.current[5]?.focus();
        }
    };
    return (_jsxs("div", { className: "min-h-screen flex items-center justify-center bg-gradient-to-br from-accent to-blue-800", children: [maintenanceMode && (_jsxs("div", { className: "fixed top-0 inset-x-0 z-50 bg-amber-500 text-white px-4 py-3 flex items-start gap-3 shadow-lg", children: [_jsx(AlertTriangle, { size: 18, className: "mt-0.5 shrink-0" }), _jsxs("div", { children: [_jsx("span", { className: "font-semibold", children: "Wartungsmodus aktiv \u2014 " }), _jsx("span", { className: "text-sm", children: maintenanceMessage || 'Der Server befindet sich derzeit in Wartung. Bitte versuchen Sie es später erneut.' }), _jsx("span", { className: "ml-2 text-xs opacity-80", children: "(Nur Administratoren k\u00F6nnen sich anmelden.)" })] })] })), _jsxs("div", { className: `bg-white rounded-lg shadow-2xl p-8 w-full max-w-sm${maintenanceMode ? ' mt-14' : ''}`, children: [_jsxs("div", { className: "flex items-center justify-center gap-2 mb-6", children: [_jsx("div", { className: "w-10 h-10 bg-accent rounded-lg flex items-center justify-center", children: step === 'mfa'
                                    ? _jsx(ShieldCheck, { size: 22, className: "text-white" })
                                    : _jsx(Mail, { size: 22, className: "text-white" }) }), _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-bold text-gray-900", children: "CoreMail" }), _jsx("p", { className: "text-xs text-gray-500", children: step === 'mfa' ? 'Zwei-Faktor-Authentifizierung' : 'Mail Web Access' })] })] }), step === 'credentials' && (_jsxs("form", { onSubmit: handleSubmitCredentials, className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "E-Mail-Adresse" }), _jsxs("div", { className: "relative", children: [_jsx(Mail, { size: 15, className: "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { type: "email", value: email, onChange: (e) => setEmail(e.target.value), className: "input pl-9", placeholder: "benutzer@domain.com", required: true, autoComplete: "email" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Passwort" }), _jsxs("div", { className: "relative", children: [_jsx(Lock, { size: 15, className: "absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), className: "input pl-9", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", required: true, autoComplete: "current-password" })] })] }), error && (_jsx("div", { className: "bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700", children: error })), _jsx("button", { type: "submit", disabled: loading, className: "btn-primary w-full justify-center py-2 disabled:opacity-60", children: loading ? 'Anmelden...' : 'Anmelden' })] })), step === 'mfa' && (_jsxs("form", { onSubmit: handleSubmitMfa, className: "space-y-5", children: [_jsxs("div", { className: "text-center", children: [_jsx("p", { className: "text-sm text-gray-600", children: mfaMethod === 'totp'
                                            ? 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.'
                                            : 'Verwenden Sie Ihren Hardware-Key oder Backup-Code.' }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: email })] }), _jsx("div", { className: "flex justify-center gap-2", onPaste: handleDigitPaste, children: otpDigits.map((d, i) => (_jsx("input", { ref: (el) => { digitRefs.current[i] = el; }, type: "text", inputMode: "numeric", maxLength: 1, value: d, onChange: (e) => handleDigitChange(i, e.target.value), onKeyDown: (e) => handleDigitKeyDown(i, e), className: "w-10 h-12 text-center text-xl font-bold border-2 rounded-lg focus:outline-none focus:border-accent transition-colors", style: { borderColor: d ? 'var(--color-accent)' : undefined } }, i))) }), error && (_jsx("div", { className: "bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700 text-center", children: error })), _jsx("button", { type: "submit", disabled: loading || otpDigits.join('').length < 6, className: "btn-primary w-full justify-center py-2 disabled:opacity-60", children: loading ? 'Prüfen...' : 'Bestätigen' }), _jsxs("button", { type: "button", onClick: () => { setStep('credentials'); setError(''); setOtpDigits(['', '', '', '', '', '']); }, className: "w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1", children: [_jsx(ArrowLeft, { size: 13 }), " Zur\u00FCck zur Anmeldung"] })] }))] })] }));
}
