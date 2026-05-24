/**
 * Zuverlässige Clipboard-Kopie — funktioniert sowohl in HTTPS- als auch
 * HTTP-Kontexten (z. B. BCP hinter DSM-Reverseproxy oder direkt via HTTP).
 *
 * Reihenfolge:
 *  1. Moderne Clipboard API (navigator.clipboard) — nur in Secure Contexts
 *  2. Fallback: textarea + document.execCommand('copy') — funktioniert auch via HTTP
 */
export async function copyToClipboard(text: string): Promise<void> {
  // Moderne Clipboard API — nur wenn Secure Context UND API verfügbar
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback für HTTP-Kontexte (DSM Application Portal, lokale Entwicklung)
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Außerhalb des sichtbaren Bereichs positionieren
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand copy fehlgeschlagen');
  } finally {
    document.body.removeChild(textarea);
  }
}
