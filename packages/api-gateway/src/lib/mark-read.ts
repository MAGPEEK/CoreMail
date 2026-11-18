/**
 * 9.4: GET …/messages/:id marks the message read (\Seen) unless the caller asks
 * not to with `?markRead=false`. The webmail always passes it and sets the flag
 * itself (immediately, after a delay or manually — user setting); other REST
 * clients keep the pre-9.4 behaviour.
 */
export function markReadRequested(query: Record<string, unknown>): boolean {
  const v = query['markRead'];
  return !(v === 'false' || v === '0');
}
