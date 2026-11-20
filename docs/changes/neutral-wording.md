# Neutral wording (no vendor comparisons)

Changelog fragment for the next release (Keep a Changelog).

### Changed

- **Wording only, no behaviour change.** User-visible texts, documentation, the changelog,
  CLAUDE.md, the root `package.json` description, infrastructure and script comments and code
  comments no longer compare CoreMail with, or present it as modelled on, third-party groupware
  products (style comparisons, "compliant with" / "like" statements, third-party product names
  for CoreMail's own webmail and admin panel, vendor names in headings and taglines). Neutral
  terms are used instead ("desktop mail programs", "MAPI clients", MWA, BCP).
- Kept on purpose: protocol and specification names (MAPI over HTTP, ActiveSync/EAS,
  Autodiscover, NSPI, ROP, MS-OX* / MS-AS* references), XML namespaces, headers and paths the
  protocols require (`/Microsoft-Server-ActiveSync`, `schemas.microsoft.com/…`,
  `X-MICROSOFT-CDO-*`, LegacyDN), identifiers and stored keys, test fixtures that mirror real
  client traffic, third-party product names a user needs for configuration (identity provider
  and relay presets, the CalDav Synchronizer plugin) and client names inside step-by-step setup
  instructions.
- Webmail: two accent colour presets named after vendor products are now "Blau" / "Lila" (the
  stored choice is the colour value and stays as it is). Settings → Externe Clients, BCP
  certificate, DNS, legacy-TLS and MAPI hints name "Desktop-Mailprogramme" instead of a vendor
  client.
- Docs: `docs/outlook-caldav.md` is now `docs/desktop-caldav.md`.
