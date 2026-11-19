### Added
- Profile photos: Settings → E-Mail-Konto shows the own avatar (96 px) with "Foto hochladen…", "Foto ändern…" and "Foto entfernen". A picked JPEG, PNG or WebP image (max. 5 MB) opens a crop dialog — round mask over a square stage, drag with mouse or touch, zoom with a slider ("Zoom"), the mouse wheel or + / −, arrow keys to move, live previews at 96, 40 and 28 px; the image always covers the circle. The browser uploads a 512×512 rendering.
- REST API: `PUT /api/v1/user/photo` (raw PNG / JPEG body or multipart field `photo`, max. 5 MB), `DELETE /api/v1/user/photo`, `GET /api/v1/users/:id/photo` (users of the same domain only, strong ETag, `Cache-Control: private, no-cache`), `POST /api/v1/users/photos/lookup` (batched address → photo lookup, aliases included, max. 100 addresses) and `photo` in `GET /api/v1/user/profile`.
- Every upload is re-encoded on the server: type by magic bytes, dimensions checked from the header before decoding (max. 2048 × 2048 pixels — decompression bombs are refused), JPEG marker walk before decoding (one baseline / progressive frame, at most 32 scans and 512 segments — a file of thousands of tiny scans would otherwise block the gateway for minutes), jpeg-js memory cap 128 MB, centre crop, 512×512 baseline JPEG without EXIF / GPS / ICC / comment data. Errors: 413 `SIZE`, 415 `TYPE` / `UNSUPPORTED`, 422 `DIMENSIONS` / `CORRUPT`; per-user upload limit (`PROFILE_PHOTO_UPLOAD_LIMIT`, `PROFILE_PHOTO_UPLOAD_WINDOW_SEC`).
- Photos are stored through the object store under content-addressed keys `profile-photos/<aa>/<sha256>.jpg`; schema: `User.photoKey`, `User.photoUpdatedAt` (additive).
- Webmail: photos of internal users appear in the message list, the reading pane, the contact card, the contact list and on meeting attendees (one batched lookup per screen, one image load per photo version); external senders keep their initials. The top bar account menu shows the own photo in the button and the menu header.
- Webmail module switch `profilePhoto` (server → domain → user, BCP webmail policies, CLI `coremail policy set --profile-photo on|off|inherit`): off hides upload / change and `PUT /api/v1/user/photo` answers 403 `FEATURE_DISABLED`; an existing photo stays visible and removable. Schema: `WebmailPolicy.profilePhoto` (additive, default inherit = on).
- BCP: the mailbox detail shows the photo with "Foto entfernen" (`GET` / `DELETE /api/v1/admin/mailboxes/:id/photo`, area recipients, management scope, audit `mailbox.photo.remove`).
- e2e step `profile-photo`.

### Changed
- Avatar initials follow one rule everywhere (avatars and contact list): first letter of the first and of the last word of the display name ("Mustermann, Erika" and "Erika Mustermann" → "EM", parenthesised parts ignored, Unicode letters); one word → one letter; without a name the first letter of the address' local part — never "?" when an address exists. The top bar used to show only the first character.
- Deleting a mailbox removes its profile photo object.
### Fixed (review)
- Two accounts saving / removing byte-identical photos at the same moment could leave one of them pointing at a deleted object; the release now restores the object when a reference appears meanwhile and the save writes it again after switching the key.
- Webmail: a newer photo version no longer revokes the `blob:` URL of an older one still shown elsewhere (e.g. under an alias address); URLs are revoked when their cache entry is dropped.
- Webmail top bar: after a page reload the account button showed "U" and the menu had no name / address (the restored session carries neither); it now falls back to the profile.
- Webmail dev server proxies `/auth` like the admin panel's (session restore and login during development).

SemVer: compatible feature (MINOR). No breaking change: new endpoints and additive columns only; photos are not exposed over CardDAV, ActiveSync or MAPI. New runtime dependency `jpeg-js` (pure JavaScript) in the api-gateway.
