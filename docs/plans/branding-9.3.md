# Plan: Branding (colours, logo, product name) — CoreMail 9.3.0

Status: planned, decisions taken 2026-11-16. Minor release (additive).

## Decisions
| Question | Decision |
|---|---|
| Scope | **Global** for the whole server (per-domain branding later, if needed) |
| Favicon | **Own upload** (square PNG/SVG); without upload the logo is used. No `sharp` dependency. |
| User accent colour | **Admin decides**: brand colour is the default; a BCP switch allows or locks user colours |
| "Powered by CoreMail" | **Switchable, on by default** — discreet in the login footer |

## Current state (9.2)
- Colours run through semantic tokens with contrast checks (`src/theme/*`, `accentFgChannels`).
- `ServerSettings.orgName` exists; `ServerSettings.logoUrl` is a dead setting (external URL, never rendered) — drop it from the UI, keep the column.
- "CoreMail" is hard-coded in ~21 components; the accent colour is a per-user setting (`web-client/src/store/ui.ts`).

## Scope
1. BCP → Organisation → **Branding** with live preview in light and dark:
   product name, logo light (+ optional dark), favicon, primary colour (+ optional header colour),
   login background and welcome text, footer links (imprint, privacy), "allow user accent colour",
   "show Powered by CoreMail".
2. Applied everywhere: webmail + BCP (incl. login, setup, password reset), browser title + favicon,
   system mails (password reset, notifications), Apple profile / autoconfig display name, PWA manifest.

## Design
- **Data**: new singleton model `Branding` (additive): productName, primaryColor, headerColor?,
  logoLightKey, logoDarkKey?, faviconKey?, loginBackgroundKey?, loginText, footerLinks Json,
  allowUserAccent Boolean @default(true), showPoweredBy Boolean @default(true), version Int (cache busting).
  Assets via `getObjectStore()` under `branding/<sha256>.<ext>`.
- **API**:
  - `GET /api/v1/branding` — public (login page needs it before auth).
  - `GET /branding/assets/:hash` — public, `Cache-Control: immutable`, `X-Content-Type-Options: nosniff`,
    `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`.
  - `PUT /api/v1/admin/branding`, `POST /api/v1/admin/branding/assets/:slot` — `ORGANIZATION_MANAGEMENT`,
    audited as `settings.branding.update`, `CHANNEL_SETTINGS_RELOAD` publish.
- **Upload validation**: PNG / WebP / SVG only, magic bytes, ≤ 512 KB, dimension limits.
  SVG sanitised server-side with an allowlist (no `script`, event handlers, `foreignObject`,
  external `href`, `javascript:` URLs, DOCTYPE/entities). Logos rendered only through `<img>`.
- **Colours**: primary colour through `contrast.ts` → accent-fg, hover/active per theme (OKLCH keeps hue).
  Below 3:1 for controls → warning + suggested correction in the BCP. theme-guard test stays.
- **No flash of default colours**: api-gateway injects colour vars, `<title>` and favicon into the served
  `index.html`; a `BrandingProvider` + `useBranding()` replaces hard-coded "CoreMail".
- **Fonts**: optional choice from bundled self-hosted fonts (no Google Fonts — GDPR).
- **Operations**: env defaults `BRANDING_NAME`, `BRANDING_COLOR`; CLI `coremail branding set …`; Helm values.

## API contract (binding for backend and frontend)

Public `GET /api/v1/branding` → `200`, `Cache-Control: no-cache`:
```json
{
  "version": 3,
  "productName": "CoreMail",
  "primaryColor": "#0078d4",
  "headerColor": null,
  "allowUserAccent": true,
  "showPoweredBy": true,
  "loginText": "",
  "footerLinks": [{ "label": "Impressum", "url": "https://example.org/impressum" }],
  "assets": {
    "logoLight": "/branding/assets/<sha256>.svg",
    "logoDark": null,
    "favicon": null,
    "loginBackground": null
  }
}
```
- `primaryColor` / `headerColor`: `#rrggbb` lower-case or `null` (header: null = primary colour).
- Asset URLs are `null` when unset; the frontend falls back to the built-in CoreMail logo / `/favicon.svg`.
  The favicon falls back to `logoLight` when only a logo exists.
- `footerLinks`: max 5, label ≤ 40 chars, `https://` or `mailto:` only.

Admin (`requireRole` → ORGANIZATION_MANAGEMENT, audited `settings.branding.update`):
- `GET /api/v1/admin/branding` → same shape as public.
- `PUT /api/v1/admin/branding` — partial body of `productName` (1–40 chars), `primaryColor`, `headerColor`,
  `allowUserAccent`, `showPoweredBy`, `loginText` (≤ 280 chars, plain text), `footerLinks` → updated object.
  `400 {error, field}` on validation errors; a colour below 3:1 against white/dark surfaces is accepted but the
  response carries `warnings: [{field, message, suggestion: "#rrggbb"}]`.
- `POST /api/v1/admin/branding/assets/:slot` (`slot` ∈ logoLight | logoDark | favicon | loginBackground),
  raw body with `Content-Type: image/png | image/webp | image/svg+xml` (loginBackground also `image/jpeg`),
  ≤ 512 KB (loginBackground ≤ 2 MB) → updated object. `400 {error, code}` with codes `TYPE`, `SIZE`,
  `DIMENSIONS`, `SVG_UNSAFE`.
- `DELETE /api/v1/admin/branding/assets/:slot` → updated object.
- `POST /api/v1/admin/branding/reset` → defaults.
- Every change increments `version` and publishes `CHANNEL_SETTINGS_RELOAD` `{type:'branding'}`.

`GET /branding/assets/:file` — public, immutable cache, `nosniff`,
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, correct content type.

Served `index.html` of webmail and BCP: the gateway injects before `</head>`
`<style id="cm-brand">:root{--brand-primary:R G B}</style>`, replaces `<title>` with the product name and the
favicon `href`, and adds `<script id="cm-branding" type="application/json">…public JSON…</script>` so the SPA
renders branded before its first fetch. The JSON is escaped for script context (`<` → `<`).

## Tests
- Unit: SVG sanitiser with hostile samples (script, onload, XXE, foreignObject, `javascript:`), colour
  validation, RBAC + audit, index.html injection.
- e2e step `branding`: upload, public fetch, headers/CSP, hostile SVG refused, login page shows name + colour.
- Live contrast check light/dark with three extreme test colours.
- Docs `docs/branding.md`, CHANGELOG, release notes.

## Sources
- Nextcloud theming: https://docs.nextcloud.com/server/stable/admin_manual/configuration_server/theming.html
- Grafana custom branding: https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/configure-custom-branding/
- SVG XSS: https://rietta.com/blog/svg-xss-injection-attacks/ · https://www.miggo.io/vulnerability-database/cve/CVE-2023-37269
- OKLCH palettes: https://www.digitalthriveai.com/en-ca/resources/web-design/oklch-css-consistent-accessible-color-palettes/
