/**
 * Search field helpers shared by the header search and the message-list search.
 * No imports; appendSearchToken is unit-tested with `node --test`.
 */

/**
 * Field value after inserting a search operator from the operators help, and where
 * the caret goes: inside the quotes for the phrase operator, else at the end.
 */
export function appendSearchToken(text: string, token: string): { value: string; caret: number } {
  const base = text.trim();
  const value = base ? `${base} ${token}` : token;
  return { value, caret: token === '""' ? value.length - 1 : value.length };
}

/**
 * Inserts an operator into a search field and keeps typing there (caret inside ""
 * for the phrase operator). Used as the onInsert of SearchOperatorsHelp.
 */
export function insertSearchToken(
  current: string,
  token: string,
  setValue: (value: string) => void,
  input: () => HTMLInputElement | null,
): void {
  const next = appendSearchToken(current, token);
  setValue(next.value);
  requestAnimationFrame(() => {
    const el = input();
    if (!el) return;
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
  });
}
