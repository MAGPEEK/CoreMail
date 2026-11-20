# Setup wizard: local domain first (target 10.5.0)

Changelog fragment for the `[10.5.0]` section (Keep a Changelog).

### Changed

- **The first-run setup wizard starts with a local domain**: the domain step is prefilled with
  `example.local` (host name `mail.example.local`, following the domain until edited; organisation
  empty) and explains that CoreMail starts with a local domain and a self-signed certificate and
  that the real domain is added afterwards in the BCP under Domains and made primary. The admin
  step suggests `admin@example.local` and notes that mail from outside cannot reach a local
  address. A real domain can still be typed in; private suffixes (`.local`, `.lan`, `.internal`,
  `.home.arpa`, `.test`, `.localdomain`) pass the same checks. Docs: docs/setup-wizard.md,
  docs/deploy.md.
- `POST /api/v1/setup/complete`: the self-signed certificate created for the host name (also a
  local one; assigned to SMTP/IMAP/POP3) is now served by the integrated HTTPS server right away —
  the setup publishes `coremail:tls:reload`. The domain still gets its DKIM key; nothing in the
  setup needs public DNS.
- **BCP dashboard card**: for a local / private public host name (private suffixes, `.localhost`,
  single labels, bare IP addresses) the card offers no Let's Encrypt order; it shows
  **„Eigene Domain hinzufügen“** with three steps (Domain anlegen → als primär festlegen →
  Zertifikat anfordern) and a link to Domains. `GET /api/v1/admin/setup-state` answers an
  additional `hostname` (the configured name the card is about); `publicHostname` stays the name a
  Let's Encrypt order may use (null for a local name).
- **Make primary** (`POST /api/v1/admin/domains/:id/make-primary`, also renaming the primary
  domain): a local public host name (e.g. `mail.example.local`) is replaced with
  `mail.<new domain>` when the new primary domain is public; the client URLs are re-derived and
  "Später" of the dashboard card is cleared, so the card then offers Let's Encrypt for the new
  host name. An explicitly configured public host name is kept as before.
