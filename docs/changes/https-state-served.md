### Fixed
- BCP "Protokolle und Dienste": the HTTPS card no longer says "HTTPS ist nicht aktiv" and the `mapi-https` warning no longer appears while the integrated HTTPS server listens on its port and serves a trusted certificate for the public host name, even when no certificate is explicitly marked for HTTPS (`isActiveHttps`). The overview's `https.active` now means "the HTTPS server listens" (`httpsServerState()` in api-gateway `tls-proxy.ts`); trust still comes from the certificate served for the public host name (`servedProxyCert`).
- The served-certificate view (SSL/TLS) now also probes the HTTPS port while the server listens without an `isActiveHttps` certificate.

The HTTP → HTTPS redirect is unchanged: it still starts only with a certificate explicitly marked for HTTPS. No API shape, schema or breaking change.
