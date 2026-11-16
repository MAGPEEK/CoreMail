# Antivirus (ClamAV)

CoreMail scans inbound mail with ClamAV. The `security-filter` service sends each
message to `clamd` in the `clamav` container over TCP (`INSTREAM`, port 3310) after the
SPF/DKIM/DMARC, block-list and attachment checks and before rspamd.

There are two kinds of settings:

| Kind | Where | Applied |
|---|---|---|
| **CoreMail policy** — what happens with a finding, a failure or a large message | BCP → Protection → Antivirus (`/api/v1/admin/security/clamav`) | immediately (settings reload over Redis, no restart) |
| **Engine limits** — what clamd scans and reports | `clamd.conf` / `freshclam.conf` in the clamav container | container restart |

The BCP cannot change the engine limits. clamd reads `clamd.conf` only at start, and
restarting a sibling container from the app container would need the Docker socket, which
CoreMail does not get. The BCP shows the recommended values below as read-only information.

## CoreMail policy (BCP)

Stored in `SecuritySettings`; the defaults keep the pre-9.2 behaviour.

| Setting | Field | Default | Effect |
|---|---|---|---|
| Virus scan on | `clamavEnabled` | on | `CLAMAV_ENABLED=false` in the environment overrides it (minimal compose). |
| Action on a virus | `clamavAction` | `quarantine` | `quarantine` (accept, store in the quarantine), `reject` (550 at end of DATA), `pass` (deliver, tagged `infected` — for troubleshooting only). |
| Scanner failure | `clamavBlockOnFailure` | off | Off: deliver unscanned, tagged `unscanned; reason=scanner-error`. On: answer `451 4.7.1`, the sending server retries. Covers clamd unreachable, a clamd error and the scan timeout. A permanent reject on a scanner outage is deliberately not offered: it would bounce legitimate mail during every clamd restart or signature reload. |
| Scan timeout | `clamavTimeoutSec` | 20 s (5–25) | Stays below the smtp-server → security-filter request timeout (30 s), so a hanging clamd is handled by the failure policy instead of an aborted request. |
| Scan limit | `clamavScanLimitMb` | 50 MB (1–50) | Larger messages are not sent to clamd. The content filter accepts at most 52 MB. |
| Over the scan limit | `clamavOversizeAction` | `accept` | `accept`: deliver unscanned, tagged `unscanned; reason=too-large`. `reject`: refuse the message. clamd's own answer `INSTREAM size limit exceeded` (its `StreamMaxLength` is smaller than the message) is handled the same way. |
| Heuristic findings count as a virus | `clamavHeuristicsAsVirus` | on | `Heuristics.*` (phishing heuristics, `Heuristics.OLE2.ContainsMacros`, `Heuristics.Limits.Exceeded`, …) and `Broken.Executable`. |
| PUA findings count as a virus | `clamavPuaAsVirus` | on | `PUA.*`; clamd reports them only with `DetectPUA yes`. |
| Encrypted archives count as a virus | `clamavEncryptedAsVirus` | on | `Heuristics.Encrypted.*`; clamd reports them only with `AlertEncrypted*`. |

A finding in a category that does not count as a virus is delivered (subject to rspamd)
and tagged `suspicious`. Real signatures always count as a virus.

clamd host and port are deployment settings: `CLAMAV_HOST` (default `clamav`) and
`CLAMAV_PORT` (default `3310`) in the app container. The BCP shows them read-only;
making them editable would let an admin point the filter at an arbitrary host.

Changes are written to the audit log as `settings.clamav.update` with a field diff.

### `X-CoreMail-Virus-Scan` header

Mail that is delivered or quarantined without a clean scan carries one header line:

```
X-CoreMail-Virus-Scan: infected; signature="Win.Test.EICAR_HDB-1"; host=mail.example.com
X-CoreMail-Virus-Scan: suspicious; signature="PUA.Win.Packer.Upx-1"; host=mail.example.com
X-CoreMail-Virus-Scan: unscanned; reason=too-large; host=mail.example.com
X-CoreMail-Virus-Scan: unscanned; reason=scanner-error; host=mail.example.com
```

Clean mail has no such header. The header is internal: a copy sent by an outside sender
is removed on receipt, so it cannot be forged. Mail rules can match on it.

### Status and EICAR test

The Antivirus page shows whether clamd answers, the engine version, the signature
database version and date (clamd `VERSION`), the database age (a warning above 48 h means
freshclam is not updating) and the queue/threads from `STATS` when available.

**EICAR test** scans a small message with the EICAR test file as a base64 attachment
through the same path as inbound mail (size limit, timeout, `INSTREAM`, policy) and shows
whether it was detected and what would happen to such a message. Nothing is delivered.
API: `GET /api/v1/admin/security/clamav/status`, `POST /api/v1/admin/security/clamav/eicar-test`
(both proxied to the security filter, hygiene role; the test needs write access).

Outbound mail (submission) is not scanned by ClamAV.

## Engine limits (clamav container)

The official image `clamav/clamav` uses the compiled clamd defaults (it only sets the
socket, user and log options). Recommended values for 10–500 mailboxes:

| Option | Default | Recommended | Why |
|---|---|---|---|
| `StreamMaxLength` | 100M | 60M | Largest stream clamd accepts; must be ≥ the CoreMail scan limit. |
| `MaxScanSize` | 400M | 200M | Data extracted per message (archives); bounds CPU/RAM per scan. |
| `MaxFileSize` | 100M | 50M | Largest single file, also inside archives. |
| `MaxRecursion` | 17 | 17 | Nesting depth of archives. |
| `MaxFiles` | 10000 | 10000 | Files per archive. |
| `AlertExceedsMax` | no | no | `yes` reports `Heuristics.Limits.Exceeded` (archive bombs) — many false positives with large legitimate archives. |
| `AlertEncryptedArchive` | no | yes | Password-protected ZIP/RAR/7z are a common malware carrier. Combine with "Encrypted archives count as a virus". |
| `AlertEncryptedDoc` | no | no | Encrypted PDFs are often legitimate (payslips, invoices). |
| `AlertOLE2Macros` | no | no | Reports every Office file with macros — too noisy for business mail. |
| `DetectPUA` | no | no | Adware/tools; enable only with "PUA counts as a virus" off, to tag instead of quarantine. |
| `HeuristicAlerts`, `PhishingSignatures`, `ScanMail`, `ScanArchive`, `ScanPDF`, `ScanOLE2`, `ScanHTML` | yes | yes | Keep on. |
| `ConcurrentDatabaseReload` | yes | yes | Scans continue during the daily reload (needs ~2.4 GB RAM briefly); `no` saves RAM but blocks scans during the reload — use the 451 failure policy then. |
| `FRESHCLAM_CHECKS` (image env) | 1 | 12 | Signature update checks per day. |

Apply them with an extra config file mounted into the container (compose):

```yaml
  clamav:
    environment:
      CLAMAV_NO_FRESHCLAMD: "false"
      FRESHCLAM_CHECKS: "12"
    volumes:
      - clamav-data:/var/lib/clamav
      - ./clamav/clamd.conf:/etc/clamav/clamd.conf:ro
```

Start from the image's own file (`docker exec coremail-clamav cat /etc/clamav/clamd.conf > clamav/clamd.conf`),
change the options above and keep `TCPSocket 3310`. Then `docker compose up -d clamav`.
The image needs at least 3 GiB RAM (4 GiB preferred).

Helm: the chart runs the same image with the compiled defaults (`infra/k8s/templates/clamav.yaml`)
and has no value for a custom `clamd.conf` yet. To change the limits, run your own clamd and
point the chart at it with `clamav.enabled: false` + `clamav.external.host`.

## References

- ClamAV Docker image (environment variables, custom config, memory): https://docs.clamav.net/manual/Installing/Docker.html
- clamd protocol (`PING`, `VERSION`, `STATS`, `INSTREAM`, `StreamMaxLength`): https://docs.clamav.net/manual/Usage/ClamdProtocol.html
- Configuration overview: https://docs.clamav.net/manual/Usage/Configuration.html
- `clamd.conf` option reference (defaults): https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample
- Image build (which options the image changes): https://github.com/Cisco-Talos/clamav-docker
