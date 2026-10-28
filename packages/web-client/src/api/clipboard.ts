/**
 * Copies text to the clipboard. Works in HTTPS/localhost
 * contexts via the Clipboard API, falls back to `execCommand('copy')` in HTTP
 * contexts. Throws if both fail.
 */
export async function copyToClipboard(text: string): Promise<void> {
  // 1) Modern Clipboard API (only available in secure context)
  if (typeof navigator !== 'undefined'
      && navigator.clipboard
      && typeof navigator.clipboard.writeText === 'function'
      && (typeof window === 'undefined' || window.isSecureContext)) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // continue to fallback
    }
  }

  // 2) Fallback: hidden textarea + execCommand('copy')
  const ta = document.createElement('textarea');
  ta.value = text;
  // place outside the visible area to avoid a scroll jump
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
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (!ok) throw new Error('Kopieren fehlgeschlagen');
}
