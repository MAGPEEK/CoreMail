# gate-cert-serial-eas-size — changelog text (gate fixes)

SemVer: PATCH. No API, schema or configuration change; `@coremail/core` gains an additive export
(`randomCertSerialHex`, subpath `@coremail/core/cert-serial`).

### Fixed
- Self-signed certificates (BCP → SSL/TLS, initial setup, protocol self-signed default) could
  occasionally not be loaded ("illegal padding"): the random serial number was sometimes encoded
  with a leading zero byte that OpenSSL refuses. The serial is now always a positive, minimally
  encoded 16-byte value (one shared generator for every certificate CoreMail signs itself).
