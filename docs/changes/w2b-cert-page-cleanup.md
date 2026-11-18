# w2b-cert-page-cleanup — changelog text (Keep a Changelog)

SemVer: MINOR (additive API field, BCP presentation change). No endpoint, field or setting is
removed or changes meaning.

### Added
- `GET /api/v1/admin/certificates/served` also probes the integrated HTTPS server (implicit TLS on
  `HTTPS_PORT`, handshake only) and reports it as `https` (same shape as a port entry, `null`
  while the HTTPS server does not listen). The top-level `problem` flag keeps covering the mail
  ports only.

### Changed
- BCP → SSL/TLS: the separate section „Tatsächlich ausgeliefert“ is gone. The certificate list
  shows, in the row of the certificate that holds them, a status chip per service (SMTP, IMAP,
  POP3, HTTPS) derived from what the ports really serve — OK, or a warning whose tooltip lists the
  ports that serve another, self-signed, name-mismatched or expired certificate (HTTPS: also when
  the integrated HTTPS server does not run), with „Jetzt zuweisen“ next to a mail-protocol
  warning. Chips show an icon and the service name (not colour alone); the tooltip opens on hover,
  focus and click and closes with Escape.
- The warning banners on the SSL/TLS page and the dashboard are unchanged and appear only when a
  mail port serves a wrong certificate or a private key in use cannot be read.
- The two switches per certificate say what they do: „HTTPS (Port 443): Dieses Zertifikat für
  Webmail/BCP/ActiveSync/Autodiscover über den integrierten HTTPS-Server verwenden“ (on/off state
  exposed as pressed/not pressed) and „Mail-Protokolle (SMTP · IMAP · POP3)“; the details view, the
  edit dialog, the delete confirmation and the messages use the same names (the port follows
  `HTTPS_PORT`).
