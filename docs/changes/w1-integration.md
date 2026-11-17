# w1-integration — changelog text (lead decisions on the integrated wave 1)

SemVer: MINOR (additive API fields, UI changes, fixes; no breaking change).

### Changed
- Webmail: the app rail no longer has an "Einstellungen" entry — settings are opened with the gear
  in the header (no rail entry is marked current on the settings page).
- Webmail: the search-operator help exists once, next to the header search; the duplicate in the
  message-list search row is gone.
- Webmail: labels and tooltips of the mail command bar, the reading-pane action bar (incl. the
  snooze menu and the junk banner buttons), the app rail and the shared command bar ("Weitere
  Befehle") come from the translation table — German and English; Spanish and Italian show the
  English texts until they are translated.

### Added
- BCP → SMTP → Geräte-Relay: a prominent warning when an allowed network overlaps a typical
  container/cluster NAT range (Docker bridge `172.17.0.0/16` / pool `172.16.0.0/12`, Kubernetes
  `10.0.0.0/8`, `100.64.0.0/10`, IPv6 ULA `fd00::/8`) — behind Docker/Kubernetes NAT every client may
  appear with the gateway address, which would open the relay to everyone reaching the host. The
  device-relay API (`GET`/`PUT /api/v1/admin/smtp-config/device-relay`) returns the new additive
  field `warnings`; the configuration is still saved.
