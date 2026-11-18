/** 9.4: readable texts of API errors that need a computed part. Pure — unit-tested with `node --test`. */

/** Text of a 413: the limit in MB when the server names it. */
export function tooLargeText(maxBytes: unknown): string {
  const mb = typeof maxBytes === 'number' && maxBytes > 0 ? Math.max(1, Math.floor(maxBytes / (1024 * 1024))) : null;
  return `Die Nachricht ist zu groß${mb ? ` (höchstens ${mb} MB)` : ''}. Bitte Anhänge entfernen oder verkleinern.`;
}

