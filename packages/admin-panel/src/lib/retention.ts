/**
 * BCP → Retention (9.1.x review): pure helpers of the RetentionPage.
 */

/**
 * Tag changes of a policy: removals FIRST, then additions. Run in parallel,
 * replacing the policy's DPT failed with 409 ("already has a DPT") whenever the
 * attach reached the server before the detach.
 */
export function tagChangePlan(existing: Iterable<string>, selected: Iterable<string>): { toRemove: string[]; toAdd: string[] } {
  const before = new Set(existing);
  const after = new Set(selected);
  return {
    toRemove: [...before].filter((id) => !after.has(id)),
    toAdd: [...after].filter((id) => !before.has(id)),
  };
}

/**
 * Body of PUT /compliance/retention/:id from the policy modal. The modal only
 * edits name / description / enabled; the legacy fields (retentionDays, action,
 * scope) are sent ONLY when creating — editing a legacy policy used to reset
 * them to 0/ARCHIVE/ALL_ITEMS and silently switched the policy off.
 */
export function policyBody(form: { name: string; description: string; enabled: boolean }, isEdit: boolean): Record<string, unknown> {
  const base = { name: form.name.trim(), description: form.description, enabled: form.enabled };
  return isEdit ? base : { ...base, retentionDays: 0, action: 'ARCHIVE', scope: 'ALL_ITEMS' };
}

/** Days input of the tag modal: an integer ≥ 1, else null. */
export function parseRetentionDays(raw: string): number | null {
  if (!/^\s*\d+\s*$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 1 ? n : null;
}
