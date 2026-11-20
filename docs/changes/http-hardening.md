# HTTP connection hardening (slowloris, slow POST, connection floods)

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead (target 10.5.0 "Angriffsschutz").

### Security

- **HTTP connection hardening of the api-gateway** (port 3000 and the integrated HTTPS
  proxy): explicit header timeout (`HTTP_HEADERS_TIMEOUT_MS`, 20 s; was Node's 60 s checked
  every 30 s), request timeout (`HTTP_REQUEST_TIMEOUT_MS`, 5 min; bounds only receiving the
  request, so SSE, ActiveSync Ping, MAPI NotificationWait, JMAP EventSource and WebSocket
  upgrades are not cut), keep-alive timeout (`HTTP_KEEPALIVE_TIMEOUT_MS`, 5 s), deadline
  check every 5 s (`HTTP_CONNECTIONS_CHECK_INTERVAL_MS`), TLS handshake timeout on the HTTPS
  proxy (`HTTPS_HANDSHAKE_TIMEOUT_MS`, 10 s; was 120 s), a global connection cap shared by
  HTTP and HTTPS (`HTTP_MAX_CONNS`, 4000) and a per-client cap (`HTTP_MAX_CONNS_PER_IP`, 300,
  IPv6 per /64, exempt list `HTTP_CONN_EXEMPT_CIDRS`, loopback always exempt), counted on the
  raw TCP socket before TLS. Over a cap port 3000 answers a minimal `503` + `Retry-After`,
  the HTTPS proxy drops the connection before the handshake; refusals are logged at most once
  per minute per client. Behind `TRUST_PROXY` a trusted proxy peer is not subject to the
  per-IP cap on port 3000 (limit connections on the proxy instead). Code
  `packages/api-gateway/src/lib/http-hardening.ts`, docs/api-gateway-security.md
  "Connection limits and timeouts (10.5)".
