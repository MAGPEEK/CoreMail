# Attack protection — verification and fixes (target 10.6.0)

Real-stack verification of BCP → Schutz → Angriffsschutz on a 10.5.0 build
(standalone `deploy/docker-compose.yml`, attacks from a non-private "stranger"
container on an extra Docker network). Details: [attack-protection.md](../attack-protection.md).

## Fixed

- **BCP → Angriffsschutz, refresh button**: the button did refetch the page's
  four queries, but it gave no sign of it — no loading state, no time of the
  last refresh, and unchanged data keeps the same object (TanStack structural
  sharing), so nothing on the page moved. Together with the sampled event counts
  (at most 10 recorded events per address and minute) a click during an
  ongoing attack looked like a dead button. The icon now turns while loading,
  the page shows „Zuletzt aktualisiert …" and refreshes every part (locks,
  events, block list / exceptions, settings) every 30 s; before, only the locks
  (15 s) and the summary (30 s) were polled, the lists and settings never.
- **Empty and error states**: „Keine Angriffe in den letzten 24 h." when nothing
  was recorded; a failed summary request shows the error instead of the empty
  state (it was shown as „no events").
- **Dashboard „Aktualisieren"** refreshes the attack widget as well; it only
  refetched the dashboard data, the widget kept its state until its own poll.
- **HTTP connection floods** (`HTTP_MAX_CONNS*` refusals, 503) are recorded as
  `IP_RATE_LIMIT` / protocol `http` (once per address and minute, refusals in
  between in `detail.suppressed`) — before they only reached the container log
  and never appeared on the page or the dashboard.
- **Web login brute force past the login limiter** (20 attempts / 15 min per
  address, 429) is recorded as `IP_RATE_LIMIT` / protocol `web` — before, the
  page showed 20 failures and then nothing while the attack went on.
- Unlocking a lock also refreshes the event counts on the page.

## Added

- e2e step `attack` (`scripts/e2e/steps/attack.mjs`): IMAP brute force → account
  lock listed (protocol, remaining time) and events recorded → „Entsperren" →
  login works; block list entry for a helper container → IMAPS and HTTP refused
  (`403 IP_BLOCKED`, event `IP_BLOCKLIST`) → entry removed → admitted.
