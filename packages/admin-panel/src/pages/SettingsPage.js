import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Mail, Shield, Wrench, Save, AlertTriangle, Info, Eye, RefreshCw, Globe, ToggleLeft, ToggleRight, } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtDate(iso) {
    return new Date(iso).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}
// ── Feldkomponenten ───────────────────────────────────────────────────────────
function FieldGroup({ label, hint, children }) {
    return (_jsxs("div", { className: "grid grid-cols-[220px_1fr] gap-4 py-4 border-b border-gray-100 last:border-0", children: [_jsxs("div", { children: [_jsx("label", { className: "text-sm font-medium text-gray-700", children: label }), hint && _jsx("p", { className: "text-xs text-gray-400 mt-0.5 leading-snug", children: hint })] }), _jsx("div", { className: "space-y-1", children: children })] }));
}
function TextInput({ value, onChange, placeholder = '', type = 'text', maxLength }) {
    return (_jsx("input", { type: type, value: value, onChange: (e) => onChange(e.target.value), placeholder: placeholder, maxLength: maxLength, className: "input" }));
}
function NumberInput({ value, onChange, min, max, unit }) {
    return (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "number", value: value, onChange: (e) => onChange(parseInt(e.target.value, 10) || min), min: min, max: max, className: "input w-28" }), unit && _jsx("span", { className: "text-sm text-gray-500", children: unit })] }));
}
function Textarea({ value, onChange, placeholder = '', rows = 3 }) {
    return (_jsx("textarea", { value: value, onChange: (e) => onChange(e.target.value), placeholder: placeholder, rows: rows, className: "input resize-none" }));
}
function Toggle({ value, onChange, label }) {
    return (_jsxs("button", { type: "button", onClick: () => onChange(!value), className: `flex items-center gap-2 text-sm transition-colors ${value ? 'text-accent' : 'text-gray-500'}`, children: [value ? _jsx(ToggleRight, { size: 26, className: "text-accent" }) : _jsx(ToggleLeft, { size: 26, className: "text-gray-400" }), label && _jsx("span", { children: label })] }));
}
function Select({ value, onChange, options }) {
    return (_jsx("select", { value: value, onChange: (e) => onChange(e.target.value), className: "input w-auto", children: options.map((o) => _jsx("option", { value: o.value, children: o.label }, o.value)) }));
}
// ── Sektion-Wrapper ───────────────────────────────────────────────────────────
function Section({ icon: Icon, title, description, children, saving, onSave, dirty }) {
    const t = useT();
    return (_jsxs("div", { className: "card", children: [_jsxs("div", { className: "flex items-start justify-between mb-1", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-0.5", children: _jsx(Icon, { size: 16, className: "text-accent" }) }), _jsxs("div", { children: [_jsx("h2", { className: "text-sm font-semibold text-gray-900", children: title }), _jsx("p", { className: "text-xs text-gray-400 mt-0.5", children: description })] })] }), onSave && (_jsxs("button", { type: "button", onClick: onSave, disabled: saving || !dirty, className: `btn-primary text-xs disabled:opacity-40 ml-4 shrink-0 ${dirty ? '' : 'opacity-40'}`, children: [saving ? _jsx(RefreshCw, { size: 13, className: "animate-spin" }) : _jsx(Save, { size: 13 }), saving ? t('action_saving') : t('action_save')] }))] }), _jsx("div", { className: "mt-4", children: children })] }));
}
// ── Hauptseite ────────────────────────────────────────────────────────────────
export function SettingsPage() {
    const t = useT();
    const qc = useQueryClient();
    const { data: cfg, isLoading } = useQuery({
        queryKey: ['admin-settings'],
        queryFn: () => api.get('/admin/settings'),
    });
    const [org, setOrg] = useState({
        orgName: '', orgDescription: '', adminEmail: '',
        language: 'de', timezone: 'Europe/Berlin',
        welcomeMessage: '', logoUrl: '',
    });
    const [mail, setMail] = useState({
        maxMessageSizeMb: 25, maxAttachmentSizeMb: 25, trashRetentionDays: 30,
    });
    const [sec, setSec] = useState({
        minPasswordLength: 8, maxLoginAttempts: 5,
        sessionTimeoutMinutes: 480,
        requireMfaForAdmins: false, allowSelfRegistration: false,
    });
    const [maint, setMaint] = useState({
        maintenanceMode: false,
        maintenanceMessage: '',
    });
    const [orgDirty, setOrgDirty] = useState(false);
    const [mailDirty, setMailDirty] = useState(false);
    const [secDirty, setSecDirty] = useState(false);
    const [maintDirty, setMaintDirty] = useState(false);
    useEffect(() => {
        if (!cfg)
            return;
        setOrg({ orgName: cfg.orgName, orgDescription: cfg.orgDescription, adminEmail: cfg.adminEmail,
            language: cfg.language, timezone: cfg.timezone, welcomeMessage: cfg.welcomeMessage, logoUrl: cfg.logoUrl });
        setMail({ maxMessageSizeMb: cfg.maxMessageSizeMb, maxAttachmentSizeMb: cfg.maxAttachmentSizeMb, trashRetentionDays: cfg.trashRetentionDays });
        setSec({ minPasswordLength: cfg.minPasswordLength, maxLoginAttempts: cfg.maxLoginAttempts,
            sessionTimeoutMinutes: cfg.sessionTimeoutMinutes, requireMfaForAdmins: cfg.requireMfaForAdmins, allowSelfRegistration: cfg.allowSelfRegistration });
        setMaint({ maintenanceMode: cfg.maintenanceMode, maintenanceMessage: cfg.maintenanceMessage });
        setOrgDirty(false);
        setMailDirty(false);
        setSecDirty(false);
        setMaintDirty(false);
    }, [cfg]);
    const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-settings'] });
    const orgMut = useMutation({
        mutationFn: () => api.put('/admin/settings/org', org),
        onSuccess: () => { toast.success(t('settings_org_saved')); setOrgDirty(false); void invalidate(); },
        onError: (e) => toast.error(e.message),
    });
    const mailMut = useMutation({
        mutationFn: () => api.put('/admin/settings/mail', mail),
        onSuccess: () => { toast.success(t('settings_mail_saved')); setMailDirty(false); void invalidate(); },
        onError: (e) => toast.error(e.message),
    });
    const secMut = useMutation({
        mutationFn: () => api.put('/admin/settings/security', sec),
        onSuccess: () => { toast.success(t('settings_sec_saved')); setSecDirty(false); void invalidate(); },
        onError: (e) => toast.error(e.message),
    });
    const maintMut = useMutation({
        mutationFn: () => api.put('/admin/settings/maintenance', maint),
        onSuccess: () => { toast.success(t('settings_maint_saved')); setMaintDirty(false); void invalidate(); },
        onError: (e) => toast.error(e.message),
    });
    function updOrg(k, v) { setOrg(p => ({ ...p, [k]: v })); setOrgDirty(true); }
    function updMail(k, v) { setMail(p => ({ ...p, [k]: v })); setMailDirty(true); }
    function updSec(k, v) { setSec(p => ({ ...p, [k]: v })); setSecDirty(true); }
    function updMaint(k, v) { setMaint(p => ({ ...p, [k]: v })); setMaintDirty(true); }
    if (isLoading) {
        return (_jsx("div", { className: "flex items-center justify-center h-64", children: _jsxs("div", { className: "flex items-center gap-2 text-gray-400", children: [_jsx(RefreshCw, { size: 16, className: "animate-spin" }), _jsx("span", { className: "text-sm", children: t('settings_loading') })] }) }));
    }
    // ── Zeiten formatieren ──────────────────────────────────────────────────────
    function fmtTrash(days) {
        if (days === 1)
            return `1 ${t('unit_day')}`;
        if (days <= 7)
            return `${days} ${t('unit_days')}`;
        if (days <= 30)
            return `${days} ${t('unit_days')} (${Math.round(days / 7)} ${t('unit_weeks')})`;
        return `${days} ${t('unit_days')} (ca. ${Math.round(days / 30)} ${t('unit_months')})`;
    }
    function fmtSession(min) {
        if (min < 60)
            return `${min} ${t('unit_minutes')}`;
        if (min < 1440)
            return `${Math.round(min / 60 * 10) / 10} ${t('unit_hours')}`;
        return `${Math.round(min / 1440 * 10) / 10} ${t('unit_days')}`;
    }
    return (_jsxs("div", { className: "p-6 space-y-5 max-w-[860px]", children: [_jsx("div", { className: "flex items-center justify-between", children: _jsxs("div", { children: [_jsx("h1", { className: "text-xl font-semibold text-gray-900", children: t('settings_page_title') }), _jsxs("p", { className: "text-xs text-gray-400 mt-0.5", children: [t('settings_page_saved'), " ", cfg ? fmtDate(cfg.updatedAt) : '—', cfg?.publicHostname && (_jsxs("span", { className: "ml-3 inline-flex items-center gap-1", children: [_jsx(Globe, { size: 11 }), cfg.publicHostname] }))] })] }) }), maint.maintenanceMode && (_jsxs("div", { className: "flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-800", children: [_jsx(AlertTriangle, { size: 16, className: "shrink-0 text-amber-500" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold", children: t('settings_maint_banner_hd') }), _jsx("p", { className: "text-xs mt-0.5", children: t('settings_maint_banner_body') })] })] })), _jsxs(Section, { icon: Building2, title: t('settings_org_title'), description: t('settings_org_desc'), saving: orgMut.isPending, dirty: orgDirty, onSave: () => orgMut.mutate(), children: [_jsx(FieldGroup, { label: t('settings_org_name'), hint: t('settings_org_name_hint'), children: _jsx(TextInput, { value: org.orgName, onChange: (v) => updOrg('orgName', v), placeholder: "z.B. Musterfirma Mail", maxLength: 100 }) }), _jsx(FieldGroup, { label: t('settings_org_desc_field'), hint: t('settings_org_desc_hint'), children: _jsx(Textarea, { value: org.orgDescription, onChange: (v) => updOrg('orgDescription', v), rows: 2 }) }), _jsx(FieldGroup, { label: t('settings_org_admin_email'), hint: t('settings_org_admin_hint'), children: _jsx(TextInput, { value: org.adminEmail, onChange: (v) => updOrg('adminEmail', v), type: "email", placeholder: "admin@example.com" }) }), _jsxs(FieldGroup, { label: t('settings_org_logo'), hint: t('settings_org_logo_hint'), children: [_jsx(TextInput, { value: org.logoUrl, onChange: (v) => updOrg('logoUrl', v), placeholder: "https://example.com/logo.png" }), org.logoUrl && (_jsx("img", { src: org.logoUrl, alt: "Logo", className: "h-10 mt-1 object-contain border border-gray-100 rounded p-1", onError: (e) => { e.target.hidden = true; } }))] }), _jsx(FieldGroup, { label: t('settings_org_lang'), hint: t('settings_org_lang_hint'), children: _jsx(Select, { value: org.language, onChange: (v) => updOrg('language', v), options: [{ value: 'de', label: '🇩🇪 Deutsch' }, { value: 'en', label: '🇬🇧 English' }] }) }), _jsx(FieldGroup, { label: t('settings_org_tz'), hint: t('settings_org_tz_hint'), children: _jsx(Select, { value: org.timezone, onChange: (v) => updOrg('timezone', v), options: [
                                { value: 'Europe/Berlin', label: 'Europe/Berlin (CET/CEST)' },
                                { value: 'Europe/Vienna', label: 'Europe/Vienna (CET/CEST)' },
                                { value: 'Europe/Zurich', label: 'Europe/Zurich (CET/CEST)' },
                                { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
                                { value: 'America/New_York', label: 'America/New_York (EST/EDT)' },
                                { value: 'UTC', label: 'UTC' },
                            ] }) }), _jsx(FieldGroup, { label: t('settings_org_welcome'), hint: t('settings_org_welcome_hint'), children: _jsx(Textarea, { value: org.welcomeMessage, onChange: (v) => updOrg('welcomeMessage', v), rows: 2 }) })] }), _jsxs(Section, { icon: Mail, title: t('settings_mail_title'), description: t('settings_mail_desc'), saving: mailMut.isPending, dirty: mailDirty, onSave: () => mailMut.mutate(), children: [_jsx(FieldGroup, { label: t('settings_mail_max_msg'), hint: t('settings_mail_max_msg_hint'), children: _jsx(NumberInput, { value: mail.maxMessageSizeMb, onChange: (v) => updMail('maxMessageSizeMb', v), min: 1, max: 500, unit: t('unit_mb') }) }), _jsx(FieldGroup, { label: t('settings_mail_max_att'), hint: t('settings_mail_max_att_hint'), children: _jsx(NumberInput, { value: mail.maxAttachmentSizeMb, onChange: (v) => updMail('maxAttachmentSizeMb', v), min: 1, max: 500, unit: t('unit_mb') }) }), _jsxs(FieldGroup, { label: t('settings_mail_trash'), hint: t('settings_mail_trash_hint'), children: [_jsx(NumberInput, { value: mail.trashRetentionDays, onChange: (v) => updMail('trashRetentionDays', v), min: 1, max: 3650, unit: t('unit_days') }), _jsx("p", { className: "text-xs text-gray-400", children: fmtTrash(mail.trashRetentionDays) })] })] }), _jsxs(Section, { icon: Shield, title: t('settings_sec_title'), description: t('settings_sec_desc'), saving: secMut.isPending, dirty: secDirty, onSave: () => secMut.mutate(), children: [_jsxs(FieldGroup, { label: t('settings_sec_pw_len'), hint: t('settings_sec_pw_len_hint'), children: [_jsx(NumberInput, { value: sec.minPasswordLength, onChange: (v) => updSec('minPasswordLength', v), min: 4, max: 64, unit: t('unit_chars') }), _jsx("div", { className: "flex gap-1 mt-1", children: [4, 6, 8, 10, 12, 16].map((n) => (_jsx("button", { type: "button", onClick: () => updSec('minPasswordLength', n), className: `text-xs px-2 py-0.5 rounded border transition-colors ${sec.minPasswordLength === n ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`, children: n }, n))) })] }), _jsx(FieldGroup, { label: t('settings_sec_max_login'), hint: t('settings_sec_max_login_hint'), children: _jsx(NumberInput, { value: sec.maxLoginAttempts, onChange: (v) => updSec('maxLoginAttempts', v), min: 1, max: 100, unit: t('unit_attempts') }) }), _jsxs(FieldGroup, { label: t('settings_sec_session'), hint: t('settings_sec_session_hint'), children: [_jsx(NumberInput, { value: sec.sessionTimeoutMinutes, onChange: (v) => updSec('sessionTimeoutMinutes', v), min: 5, max: 10080, unit: t('unit_minutes') }), _jsx("p", { className: "text-xs text-gray-400 mt-1", children: fmtSession(sec.sessionTimeoutMinutes) })] }), _jsxs(FieldGroup, { label: t('settings_sec_mfa'), hint: t('settings_sec_mfa_hint'), children: [_jsx(Toggle, { value: sec.requireMfaForAdmins, onChange: (v) => updSec('requireMfaForAdmins', v), label: sec.requireMfaForAdmins ? t('settings_sec_mfa_on') : t('status_disabled') }), sec.requireMfaForAdmins && (_jsxs("div", { className: "flex items-center gap-2 mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2", children: [_jsx(AlertTriangle, { size: 12 }), t('settings_sec_mfa_warn')] }))] }), _jsxs(FieldGroup, { label: t('settings_sec_selfreg'), hint: t('settings_sec_selfreg_hint'), children: [_jsx(Toggle, { value: sec.allowSelfRegistration, onChange: (v) => updSec('allowSelfRegistration', v), label: sec.allowSelfRegistration ? t('settings_sec_selfreg_on') : t('settings_sec_selfreg_off') }), sec.allowSelfRegistration && (_jsxs("div", { className: "flex items-center gap-2 mt-2 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2", children: [_jsx(Info, { size: 12 }), t('settings_sec_selfreg_info')] }))] })] }), _jsxs(Section, { icon: Wrench, title: t('settings_maint_title'), description: t('settings_maint_desc'), saving: maintMut.isPending, dirty: maintDirty, onSave: () => maintMut.mutate(), children: [_jsxs(FieldGroup, { label: t('settings_maint_field'), hint: t('settings_maint_field_hint'), children: [_jsx(Toggle, { value: maint.maintenanceMode, onChange: (v) => updMaint('maintenanceMode', v), label: maint.maintenanceMode ? t('settings_maint_on') : t('settings_maint_off') }), maint.maintenanceMode && (_jsxs("div", { className: "flex items-center gap-2 mt-2 px-3 py-2 bg-red-50 border border-red-100 rounded text-xs text-red-700", children: [_jsx(AlertTriangle, { size: 12, className: "shrink-0" }), _jsx("strong", { children: "Achtung:" }), "\u00A0", t('settings_maint_warn')] }))] }), _jsxs(FieldGroup, { label: t('settings_maint_msg'), hint: t('settings_maint_msg_hint'), children: [_jsx(Textarea, { value: maint.maintenanceMessage, onChange: (v) => updMaint('maintenanceMessage', v), rows: 3 }), _jsx("p", { className: "text-xs text-gray-400", children: t('settings_maint_msg_chars') })] }), maint.maintenanceMessage && (_jsxs("div", { className: "mt-3 border border-dashed border-amber-200 rounded-lg p-4 bg-amber-50", children: [_jsxs("p", { className: "text-xs font-medium text-amber-700 mb-2 flex items-center gap-1", children: [_jsx(Eye, { size: 12 }), " ", t('settings_maint_preview')] }), _jsxs("div", { className: "bg-white rounded p-3 border border-amber-100 text-sm text-gray-700 text-center", children: [_jsx(Wrench, { size: 28, className: "mx-auto mb-2 text-amber-400" }), _jsx("p", { className: "font-semibold text-gray-800 mb-1", children: t('settings_maint_preview_hd') }), _jsx("p", { className: "text-gray-600 text-xs", children: maint.maintenanceMessage })] })] }))] }), _jsxs("div", { className: "flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-blue-700", children: [_jsx(Info, { size: 15, className: "shrink-0" }), _jsx("p", { className: "text-xs", children: t('settings_urls_info') })] })] }));
}
