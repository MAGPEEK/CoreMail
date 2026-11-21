# Setup wizard: Let's Encrypt certificate step (target 10.6.0)

Changelog fragment for the `[10.6.0]` section (Keep a Changelog). MINOR: new wizard step and new
endpoints, nothing removed or renamed.

### Added

- **Setup wizard step „Zertifikat“** for a public host name (after the admin step and after
  „Secrets sichern“ when shown; local / private host names such as the default
  `mail.example.local` skip it): the wizard obtains a Let's Encrypt certificate for the host name
  plus `autodiscover.` / `autoconfig.` of the primary domain when their DNS points to the server.
  Fields: **Kontakt-E-Mail für Let's Encrypt** (prefilled with the admin address, validated; Let's
  Encrypt sends expiry notices there) and a required checkbox for the Let's Encrypt terms of
  service (linked from the ACME directory's `meta.termsOfService`). **„Zertifikat anfordern“** runs
  the existing pre-flight (DNS, CAA, validation file, staging test over port 80) and shows every
  check with its status, then orders the certificate, which is assigned to SMTP/IMAP/POP3 and
  HTTPS. On failure the reason is shown in plain German with **„Erneut prüfen“** and **„Später“**
  (the BCP dashboard card stays). Docs: docs/setup-wizard.md, docs/certificates.md,
  docs/deploy.md.
- **Setup-window endpoints** `GET /api/v1/setup/certificate/status`,
  `POST /api/v1/setup/certificate/preflight`, `POST /api/v1/setup/certificate/issue`
  (`{ email, termsAccepted: true }`): admin session of the wizard (ORGANIZATION_MANAGEMENT,
  organisation-wide, without the admin-MFA rule), only until the wizard is finished and at most
  24 h after the setup (`404` otherwise), `409 LOCAL_HOSTNAME` for a local host name, own rate
  limits (20 actions per hour, 300 status requests per 15 minutes), always audited as
  `setup.certificate.preflight` / `.issue` / `.https`. The admin certificate API keeps requiring
  admin MFA. The ACME contact e-mail is stored as `Certificate.acmeEmail` (account registration
  and renewals); no schema change.

### Changed

- The BCP certificate routes (`/acme-suggestions`, `/preflight`, `/letsencrypt`,
  `/:id/activate-https`) and the wizard share one implementation (`lib/acme-order.ts`); behaviour
  and responses of the admin routes are unchanged.
