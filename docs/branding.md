# Branding (since 9.3)

CoreMail can carry your own product name, colours and logos in the webmail and the admin panel
(BCP), on the login page, in the browser title and favicon, and in system texts (password-reset
mail, notifications, Apple configuration profile, Thunderbird autoconfig). Branding is global for
the whole server.

## What can be set

| Setting | Values | Default |
|---|---|---|
| Product name | 1–40 characters, no control characters | `BRANDING_NAME`, else `CoreMail` |
| Primary colour | `#rrggbb` | `BRANDING_COLOR`, else `#0078d4` |
| Header colour | `#rrggbb` or none (= primary colour) | none |
| Logo (light theme) | PNG, WebP, SVG — ≤ 512 KB, ≤ 4096 px | built-in logo |
| Logo (dark theme) | PNG, WebP, SVG — ≤ 512 KB, ≤ 4096 px | light logo / built-in |
| Favicon | PNG, WebP, SVG — ≤ 512 KB, square, ≤ 1024 px | derived from the light logo (see below), else built-in icon |
| Login background | PNG, WebP, JPEG, SVG — ≤ 2 MB, ≤ 4096 px | none |
| Login text | plain text, ≤ 280 characters | empty |
| Footer links | max 5; label ≤ 40 characters; `https://` or `mailto:` only | none |
| Allow user accent colour | users may pick their own accent colour | on |
| Show "Powered by CoreMail" | discreet line in the login footer | on |

`ServerSettings.orgName` (BCP → Organisation) stays the organisation name; the product name is
what the interface shows. Apple profiles and Thunderbird autoconfig show the product name once it
differs from "CoreMail", otherwise the organisation name as before; the Apple profile's
`PayloadOrganization` is always the organisation name.

## Where to set it

- **BCP → Organisation → Branding**. The form is grouped into cards: *Identität* (product name and
  the one logo upload), *Farben* (primary colour, header colour, user accent colour), *Webmail*
  (default background), *Anmeldeseite* (background image, welcome text, footer links, "Powered
  by") and a collapsed *Erweitert* card for the optional overrides — a separate logo for the dark
  mode and an own favicon. *Erweitert* opens by itself when one of them is set. The preview on the
  right (below the form on narrower screens) switches between *Webmail* / *Anmeldeseite* and
  *hell* / *dunkel*.
- **One save for everything**: image changes are part of the unsaved draft like every other field.
  A chosen file is only previewed in the browser and a removal only marked; the sticky bar at the
  bottom shows the number of unsaved changes and offers *Speichern*, *Änderungen verwerfen* and
  *Auf Standard zurücksetzen* (with a confirmation). *Speichern* first sends the image changes
  (`POST` / `DELETE /assets/:slot`, one per changed slot), then the settings (`PUT /`) — the API has
  no single request for both. A failed part does not stop the others; the bar names every part
  that was not saved (for example an SVG refused as unsafe), and failed image changes stay in the
  draft to retry or discard. Closing or reloading the tab with unsaved changes asks for
  confirmation (the browser's own dialog; moving to another BCP page does not ask).
- **CLI**: `coremail branding show | set | upload <slot> <file> | remove <slot> | reset` ([cli.md](cli.md)).
- **Environment defaults** (optional): `BRANDING_NAME`, `BRANDING_COLOR` in `.env` (both compose
  files pass them through) or Helm `app.branding.name` / `app.branding.color`. They apply while
  nothing is stored and after "Reset"; values set in the BCP / CLI win.

### How environment defaults and BCP values interact

Product name and primary colour are each either **stored** (set in the BCP or with the CLI) or
**default** (nothing stored: `BRANDING_NAME` / `BRANDING_COLOR`, else `CoreMail` / `#0078d4`).
A default follows the environment: change `BRANDING_NAME`, restart, and every installation that
never stored a name shows the new one.

- The BCP saves **only the fields you changed**. Saving the page — for example to switch
  "Powered by" off — does not store the name or colour you see, so they stay env-driven. Typing the
  value that is already shown is no change either.
- **"Standard verwenden"** next to the product name and the primary colour removes the stored value
  (the PUT sends `null`); the field shows the default again. The header colour's default is
  "no own colour" (the switch "Eigene Farbe für die Kopfzeile" off = `headerColor: null`).
- CLI: `coremail branding set --name default` / `--color default` / `--header-color none` do the same.
- "Auf Standard zurücksetzen" (`POST /reset`) removes every stored value and all images.

The admin answers carry, in addition to the public object, `defaults: { productName, primaryColor }`
(the current environment defaults) and `explicit: { productName, primaryColor, headerColor }`
(`true` = stored). The public `GET /api/v1/branding` does not contain them.

Changes need the role ORGANIZATION_MANAGEMENT (admin area `organisation`, write). SERVER_MANAGEMENT
and VIEW_ONLY_ORG can read the settings. Every change is written to the audit log as
`settings.branding.update` with the changed fields.

## API

Public, no authentication (the login page needs it before sign-in):

- `GET /api/v1/branding` → `{ version, productName, primaryColor, headerColor, allowUserAccent,
  showPoweredBy, loginText, footerLinks: [{label, url}], assets: { logoLight, logoDark, favicon,
  loginBackground } }` with `Cache-Control: no-cache`. Asset values are URLs or `null`.
- `GET /branding/assets/<sha256>.<ext>` — the uploaded file, `Cache-Control: immutable`,
  `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
  Each gateway keeps the last 16 files (at most 8 MB) in memory, keyed by the content hash, so
  repeated requests (also with cache-busting query strings) do not read the object store.
- `GET /branding/favicons/<sha256>-<64|180>.png` — the favicon (64 px) and the `apple-touch-icon`
  (180 px) derived from the current PNG light logo while no own favicon is set (same headers as the
  assets). Any other hash or size → 404.

### Favicon from the logo

One logo upload is enough: without an own favicon the favicon is derived from the light logo.

| Light logo | Favicon |
|---|---|
| PNG | `/branding/favicons/<sha>-64.png` and `apple-touch-icon` `/branding/favicons/<sha>-180.png`: the logo scaled (aspect ratio kept) and centred in a transparent square — computed once by the gateway in pure JavaScript (`lib/branding/favicon.ts`, PNG codec `png.ts`) and kept in the asset cache. A PNG the codec cannot read (16-bit, interlaced, more than 2048 × 2048 px) is served unchanged under the same URLs. |
| SVG | the sanitised SVG itself (there is no rasteriser in the stack, so no PNG fallback) |
| WebP | the WebP itself (no WebP decoder in the stack) |
| none | the built-in icon |

An own favicon (BCP → Branding → Erweitert) always wins. The dark logo falls back to the light logo.
The web clients compute the same URL when the branding changes at runtime (`faviconHref()` in
`lib/branding.ts`).

Admin (`/api/v1/admin/branding`, Bearer token):

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/` | — | branding object + `defaults` + `explicit` (every admin answer) |
| PUT | `/` | any of `productName`, `primaryColor`, `headerColor`, `allowUserAccent`, `showPoweredBy`, `loginText`, `footerLinks` (`null` resets name / colours) | branding object + `warnings` |
| POST | `/assets/:slot` | raw image, `Content-Type: image/png \| image/webp \| image/svg+xml` (`loginBackground` also `image/jpeg`) | branding object |
| DELETE | `/assets/:slot` | — | branding object |
| POST | `/reset` | — | branding object (defaults, assets deleted) |

Slots: `logoLight`, `logoDark`, `favicon`, `loginBackground`. Errors: `400 {error, field}` for
settings, `400 {error, code}` for uploads with `code` = `TYPE` (type not allowed for the slot or
content does not match the declared type), `SIZE`, `DIMENSIONS`, `SVG_UNSAFE`.
Footer link URLs follow the same rule in the BCP and the API: `https://` with a host and without
user info (`https://user:pw@host` is refused), or `mailto:local@domain.tld` (the domain needs a
dot); no whitespace, control characters, quotes, backticks, angle brackets or backslashes.

Image changes (upload, delete, reset) are serialised by a Redis lock `branding:assets:lock`, so the
deletion of an image no slot references any more can never remove an image a concurrent change has
just stored. If another instance holds the lock for more than 10 s the answer is
`409 {error, code: 'BUSY'}` — try again.

Every change increments `version` and publishes `{type:'branding'}` on the Redis channel
`settings:reload`; every api-gateway instance then drops its cached branding and `index.html`
(30-second cache as a safety net).

## Colours and contrast

The primary colour is used for buttons, links, focus rings and the selection. It should reach
**3:1** against both the light surface (`#ffffff`) and the dark surface (`rgb 27 30 37`). A colour
below that is saved anyway, but the PUT answer carries a warning
`{ field, message, suggestion }`; the suggestion keeps the hue (OKLCH) and only changes the
lightness as far as needed. The webmail derives readable text colours per theme from the brand
colour itself.

## Uploads and SVG safety

Images are checked by their bytes (magic numbers), not only by the declared type, and are stored
in the object store under `branding/<sha256>.<ext>` (content-addressed, `OBJECT_STORAGE` driver).
A replaced or removed image is deleted once no other slot references it.

SVG files are checked against a strict allowlist of what logos use (shapes, paths, text,
gradients, clip paths, masks, simple filters, `<style>`) and **refused** — not silently cleaned —
when they contain:

- a DOCTYPE or entity declarations (XXE, "billion laughs"), processing instructions other than the
  XML declaration, named entities other than the five XML ones;
- `script`, `foreignObject`, `image`, `a`, animation elements (`set`, `animate*`), or any other
  element or attribute that is not on the allowlist;
- event-handler attributes (`onload`, `onclick`, …);
- `href` / `xlink:href` other than a local `#fragment`; `javascript:`, `vbscript:` or `data:`
  anywhere; `url(…)` other than `url(#id)`; CSS escapes (backslashes), `expression()`;
- a `<style>` element containing `url(`, `@import`, `@font-face` or `@namespace`;
- more than 512 KB, more than 64 nesting levels or 20 000 elements;
- more than 50 `<use>` elements, or a `<use>` that references an element which is or contains a
  `<use>` (nested instancing grows exponentially).

Editor metadata (Inkscape / Sodipodi / RDF, `<metadata>`) and comments are dropped; the stored
file is re-serialised from the checked tree. Logos are rendered only through `<img>`, and the
asset route sends a sandboxing CSP, so even an SVG opened directly cannot run script.

Vector exports from Inkscape, Figma or Affinity usually pass. Refused are embedded bitmaps
(`<image>`) and Illustrator exports with a DOCTYPE/entities or `<switch><foreignObject>` blocks —
export with "SVG 1.1, styling: presentation attributes", or run the file through SVGO first.

## No flash of the default look

The api-gateway serves the webmail (`/`) and the BCP (`/bcp/`) `index.html` with the branding
already in it:

```html
<style id="cm-brand">:root{--brand-primary:26 115 232}</style>
<script id="cm-branding" type="application/json">{…public branding JSON…}</script>
```

plus the product name as `<title>` and the favicon (own favicon, else derived from the light logo —
see "Favicon from the logo"; a PNG logo also adds `<link rel="apple-touch-icon">`) as
`<link rel="icon">`.
`--brand-primary` is the initial accent fill (`--color-accent` in `tokens.css`), so the first paint
already uses the brand colour; the apps then apply the contrast-adjusted accent values.
The JSON is escaped for a script context (`<`, `>`, `&`, U+2028/2029 as `\uXXXX`). The page is
cached per branding version inside the gateway and never by the browser (`no-store`).

## Troubleshooting

- **Upload refused with `SVG_UNSAFE`**: the error names the element or attribute; remove it or
  export as plain SVG. **`TYPE`**: the file content does not match the chosen type, or the slot
  does not take that format (JPEG only for the login background). **`DIMENSIONS`**: larger than
  4096 px, or a favicon that is not square / larger than 1024 px.
- **Old name or logo still visible**: the browser keeps the SPA bundle, not the page; reload.
  With several gateway instances, a change reaches the others through Redis (or within 30 s).
- **Back to the defaults**: BCP → Branding → Reset, or `coremail branding reset --yes`.
