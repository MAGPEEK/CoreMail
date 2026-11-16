/**
 * Parses CHANGELOG.md (Keep a Changelog) for GET /api/v1/changelog.
 * Heading form: `## [9.1.0] — 2026-11-15 — Optional release title`.
 */
export interface ChangelogVersion {
  version: string;
  date: string;
  title: string;
  sections: Record<string, string[]>;
}

export function parseChangelog(raw: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let current: ChangelogVersion | null = null;
  let currentSection = '';

  for (const line of raw.split(/\r?\n/)) {
    const versionMatch = /^## \[(.+?)\](?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?(?:\s*[—-]\s*(.+))?\s*$/.exec(line);
    if (versionMatch) {
      if (current) versions.push(current);
      current = { version: versionMatch[1]!, date: versionMatch[2] ?? '', title: (versionMatch[3] ?? '').trim(), sections: {} };
      currentSection = '';
      continue;
    }
    const sectionMatch = /^### (.+)/.exec(line);
    if (sectionMatch && current) {
      currentSection = sectionMatch[1]!.trim();
      current.sections[currentSection] = [];
      continue;
    }
    const itemMatch = /^[-*] (.+)/.exec(line);
    if (itemMatch && current && currentSection) {
      current.sections[currentSection]!.push(itemMatch[1]!);
    }
  }
  if (current) versions.push(current);
  return versions;
}
