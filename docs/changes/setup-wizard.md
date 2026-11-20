### Changed

- **First-run setup wizard rebuilt** (`/setup`, docs/setup-wizard.md): instead of one form it now
  walks through the whole setup — setup token (checked on the first page), mail domain + public
  host name (default `mail.<domain>`) + organisation name, administrator account (name, address
  in the domain, password strength meter; two-factor sign-in only offered), backup of generated
  secrets (only when the installation generated them; path and backup commands, never the
  values; "Weiter" only after confirming), DNS records of the new domain with a live check,
  TLS certificate (Let's Encrypt when the A and MX records are found, reverse proxy, or later)
  and a summary with links to webmail, BCP, client setup and two-factor sign-in. Progress
  indicator, keyboard and screen-reader friendly, responsive; German and English texts.
- After `POST /api/v1/setup/complete` the wizard signs in with the new administrator through the
  normal `/auth/login`; the DNS and certificate steps use the existing BCP endpoints
  (domain DNS check, Let's Encrypt pre-flight and issuance) with that session. A reload of the
  wizard tab resumes the DNS / certificate step while the session is valid.
- `POST /api/v1/setup/complete` accepts the optional fields `hostname` (public host name; the
  derived server URLs and the self-signed certificate follow it), `organizationName` and
  `displayName`, and answers with `domain` and `hostname` as well. Setup stays one atomic,
  one-time claim with the one-time token.

### Added

- `POST /api/v1/setup/verify-token`: read-only check of the setup token (same rate limit as
  the other setup requests, `409` once setup is complete, never echoes the token).
- Admin API `GET /api/v1/admin/setup-state`, `PUT /api/v1/admin/setup-state/certificate-choice`,
  `POST /api/v1/admin/setup-state/certificate-hint/dismiss` (area servers, organisation-wide;
  scope decision in docs/rbac.md).
- BCP dashboard: dismissible hint "Zertifikat noch einrichten" after the wizard's certificate
  step was answered with "Später"; it disappears by itself once a trusted certificate exists.
- Schema (additive): `ServerSettings.setupCertificateChoice`,
  `ServerSettings.setupCertificateHintDismissedAt`.
