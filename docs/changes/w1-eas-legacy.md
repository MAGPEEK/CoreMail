# w1-eas-legacy — changelog text (Keep a Changelog)

### Added
- ActiveSync: protocol versions 12.1 and 14.0 next to 14.1 (`MS-ASProtocolVersions: 12.1,14.0,14.1`).
  The version is negotiated per request (`MS-ASProtocolVersion` header or the base64 request
  line) and remembered per device (`ActiveSyncDevice.protocolVersion`, new nullable column —
  additive schema change); a request without a version uses the device's last one.
- ActiveSync: base64-encoded request lines ([MS-ASHTTP]) — command code, DeviceId, DeviceType,
  policy key and command parameters from the binary query value.
- ActiveSync 12.1: SendMail / SmartReply / SmartForward with a raw MIME body and the parameters in
  the request line (`SaveInSent`, `ItemId` + `CollectionId` or `LongId`); answered with an empty
  HTTP 200, failures as HTTP 400 / 403 / 507 / 500.
- ActiveSync 12.1: GetItemEstimate request form with `Class` and `FilterType` directly in the
  Collection (the Class is echoed).
- `docs/activesync.md` (supported versions and their differences); e2e step `eas-legacy`
  (12.1 flow incl. query-string SendMail and a base64 request line, 14.0 flow).

### Changed
- ActiveSync responses carry only elements the negotiated version defines: no Email2
  conversation properties and no body Preview before 14.0, no recipient Availability before
  14.0, UserInformation in the Accounts form and RightsManagementInformation only for 14.1,
  `DeviceInformation` in Provision only for 14.1.
- ActiveSync 12.1: a blocked device gets HTTP 403 for Provision too (12.1 has no in-band
  global status codes); a pending remote wipe on a request without policy key gets HTTP 403
  as well, every other refusal HTTP 449 (the HTTP codes the protocol defines instead of the
  status values).
- ActiveSync: a request naming a protocol version the server does not announce (e.g. 2.5, 12.0,
  16.x) is still served as 14.1, as before; the service now logs a warning once per device.
