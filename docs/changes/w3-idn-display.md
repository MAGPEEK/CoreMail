### Changed
- BCP: sender-list entries (pattern and target) and the domains list show internationalized domains as Unicode (`müller.de`) with the stored punycode form (`xn--mller-kva.de`) as small secondary text and tooltip. The sender-list search matches both spellings. Regular-expression patterns are shown as stored.
- BCP: the trusted senders and ARC sealers fields of the spoofing settings list the Unicode reading of every international domain typed into them.
- BCP: a domain whose Unicode form mixes scripts within one label (for example Latin and Cyrillic) is shown with the punycode form prominent and a warning badge "Gemischte Schriftzeichen"; an `xn--` label that does not decode is flagged "Ungültige Kodierung".
- Documented: sender lists accept Unicode or punycode input (normalised to punycode server-side); the CSV export stays in punycode.

No API, schema or protocol change (SemVer: compatible UI change, no breaking change).
