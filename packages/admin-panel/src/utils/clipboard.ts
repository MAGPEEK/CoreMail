/**
 * Reliable clipboard copy — works in both HTTPS and
 * HTTP contexts (e.g. BCP behind a DSM reverse proxy or directly via HTTP).
 *
 * Order:
 *  1. Modern Clipboard API (navigator.clipboard) — only in secure contexts
 *  2. Fallback: textarea + document.execCommand('copy') — also works via HTTP
 */
export async function copyToClipboard(text: string): Promise<void> {
  // Modern Clipboard API — only if secure context AND API available
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for HTTP contexts (DSM Application Portal, local development)
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Position outside the visible area
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
