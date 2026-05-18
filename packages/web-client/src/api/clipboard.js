/**
 * Kopiert Text in die Zwischenablage. Funktioniert in HTTPS-/Localhost-
 * Kontexten via Clipboard-API, fällt im HTTP-Kontext auf `execCommand('copy')`
 * zurück. Wirft, wenn beides scheitert.
 */
export async function copyToClipboard(text) {
    // 1) Moderne Clipboard-API (nur in Secure Context verfügbar)
    if (typeof navigator !== 'undefined'
        && navigator.clipboard
        && typeof navigator.clipboard.writeText === 'function'
        && (typeof window === 'undefined' || window.isSecureContext)) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        }
        catch {
            // weiter zum Fallback
        }
    }
    // 2) Fallback: verstecktes textarea + execCommand('copy')
    const ta = document.createElement('textarea');
    ta.value = text;
    // außerhalb des sichtbaren Bereichs platzieren, damit kein Scroll-Sprung
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
        ok = document.execCommand('copy');
    }
    catch {
        ok = false;
    }
    document.body.removeChild(ta);
    if (!ok)
        throw new Error('Kopieren fehlgeschlagen');
}
