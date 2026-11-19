### Security
- Relaxed domain alignment now follows DMARC (organizational domain from the Public Suffix List, including its private section) for every check that uses it: iTIP/iMIP replies, room booking requests and updates, success DSNs, local-domain anti-spoofing and sender-list allow entries. Before, any parent domain counted as aligned, so a message authenticated for `evil.co.uk` was accepted as coming from `x@co.uk`, and a domain under a public suffix could vouch for its parent. Now a public suffix never relates two registrable domains (`evil.co.uk` ≁ `victim.co.uk` ≁ `co.uk`, `alice.github.io` ≁ `bob.github.io`); IDN names are compared as punycode, a trailing dot and case are ignored, IP literals and public suffixes themselves are aligned only on an exact match, unknown TLDs use the list's default rule.
- One shared helper `@coremail/core/domain-alignment` (`organizationalDomain`, `domainsAlignedRelaxed`, `isAlignedWithAny`) replaces the two hand-written copies in `@coremail/storage` (`domainAligned`, removed) and `@coremail/security-filter` (`domainsAligned`, removed; `isDomainAuthenticated` delegates).

### Changed
- Sibling subdomains of the same organization are now aligned with each other (`bounces.example.com` ~ `mail.example.com`), as DMARC relaxed alignment defines it; before, only equal or parent/child names were.
- `@coremail/core` depends on `tldts` 7.0.30 (pinned; already in the dependency tree through mailauth, which uses it for its DMARC verdicts — no new package).

No API, schema or protocol change. The removed `domainAligned` / `domainsAligned` were internal helpers (SemVer: PATCH-level security fix, no breaking change).
