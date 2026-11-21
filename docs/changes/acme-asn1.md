# Let's Encrypt order after passkeys (target 10.6.1, PATCH)

### Fixed

- **Let's Encrypt certificates could not be ordered in 10.6.0** (setup wizard step "Zertifikat" and
  BCP → SSL/TLS): the certificate request failed with "Cannot get schema for 'AlgorithmIdentifier'
  target". The passkey library and the ACME client each brought their own copy of the ASN.1
  packages and shared one provider registry, so the request was encoded with the wrong copy once
  the passkey code was loaded. The build now pins one copy (`@peculiar/asn1-*` overrides in
  `pnpm-workspace.yaml`); a regression test creates a CSR after loading the passkey library.
