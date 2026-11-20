# Setup wizard: secrets download, no DNS / certificate step; dashboard certificate card

Change note for the next release (Keep a Changelog, target 10.4.2). Version classification is up
to the release lead.

### Added

- **Secrets download in the setup wizard.** The step „Secrets sichern“ has a button
  **Secrets herunterladen** that downloads `coremail.env` as
  `coremail-secrets-<host>-<YYYY-MM-DD>.env` (`GET /api/v1/setup/secrets-download`). Admin
  session with ORGANIZATION_MANAGEMENT required; open only while the wizard has not reached its
  summary and at most 24 h after the setup was completed, otherwise `404`. Answers
  `Content-Disposition: attachment`, `Cache-Control: no-store`, `text/plain; charset=utf-8`,
  `X-Content-Type-Options: nosniff`; every download (and every refused attempt of a signed-in
  admin) is audited as `setup.secrets.download` — always, without the content. Own rate limit
  (10 per hour and client IP). Over plain HTTP the wizard shows one line: download only on a
  local network (`secureConnection` in `GET /api/v1/setup/status`, from `req.secure`, so
  `TRUST_PROXY` is honoured).
- `POST /api/v1/setup/finish` — called when the wizard reaches its summary; records
  `ServerSettings.setupWizardFinishedAt` (new optional column) and closes the download.
- The entrypoint stages a node-owned copy of a generated `coremail.env` at
  `/tmp/coremail-setup-secrets/coremail.env` inside the container
  (`COREMAIL_SECRETS_DOWNLOAD_FILE`) for the download; `coremail.env` itself stays root-only.
  The api-gateway deletes the copy when the wizard finishes, on a request outside the window and
  at every start once the window is closed.
- **BCP dashboard card „Zertifikat einrichten“.** Shown while no trusted certificate covers the
  public host name (the certificate the HTTPS server serves for it, same rule as the protocol
  overview), only to roles that may manage certificates (area servers, write). One button,
  „Let's-Encrypt-Zertifikat für &lt;host&gt; anfordern“, runs the certificates page's flow
  (suggested names — `autodiscover.` / `autoconfig.` of the primary domain only when their DNS
  points here — preflight, order with SMTP/IMAP/POP3, progress) and assigns the issued
  certificate to HTTPS as well (the lock action). Preflight problems, a failed issuance or a
  timeout are shown with a link to **Zertifikate**. „Später“ hides the card for every admin;
  otherwise it disappears once a trusted certificate covers the host name.
  `GET /api/v1/admin/setup-state` now answers `{ certificateCard, publicHostname, acmeEmail }`.

### Changed

- **Wizard order**: Token → Domain und Hostname → Admin-Konto → Secrets sichern (only when the
  secrets were generated) → Fertig. The installation is created when leaving the admin step (the
  download needs the admin session), so the secrets confirmation no longer gates
  `POST /setup/complete`; „Weiter“ on the secrets step still needs the checkbox
  „Ich habe die Datei gesichert“, which may be ticked without downloading.
- The summary drops the DNS and certificate rows and says „DNS-Einträge und Zertifikat richtest
  du im BCP unter Domains und Zertifikate ein“, linking to both pages.
- Installations whose setup flag is backfilled at start get `setupWizardFinishedAt` too (the
  download never opens for them).
- `ALWAYS_AUDIT` covers `setup.secrets.*`.
- The dashboard card replaces the 10.4 hint after „Später“ in the certificate step; an earlier
  dismissal of that hint (`setupCertificateHintDismissedAt`) also hides the new card.

### Removed

- The wizard's **DNS step** and **certificate step** (Let's Encrypt / reverse proxy / later)
  with their texts and components (`DnsStep`, `CertificateStep`).
- The shell instructions of the secrets step (`cp …`, `tar czf …`, copy buttons).
- `PUT /api/v1/admin/setup-state/certificate-choice` and the dashboard hint component
  `SetupCertificateHint`. The column `ServerSettings.setupCertificateChoice` stays (unused;
  schema changes are additive).
