# Branding page layout and favicon from the logo

Changelog fragment for the next release (Keep a Changelog).

### Changed

- **BCP → Organisation → Branding** is regrouped into cards: *Identität* (product name and one
  logo upload), *Farben* (primary colour, header colour, user accent colour), *Webmail* (default
  background, moved out of the colour card), *Anmeldeseite* (background image, welcome text,
  footer links, "Powered by") and a collapsed *Erweitert* card with the optional dark-mode logo
  and own favicon (opens by itself when one of them is set; disclosure button with
  `aria-expanded`).
- **One save model**: image uploads and removals are part of the unsaved draft (object-URL preview
  in the browser) instead of being stored at once. *Speichern* sends the image changes first, then
  the settings, and names every part that failed; failed image changes stay in the draft.
  *Änderungen verwerfen* also drops pending images.
- A **sticky action bar** at the bottom of the page shows "N ungespeicherte Änderungen" /
  "Alle Änderungen gespeichert" and holds *Auf Standard zurücksetzen* (with confirmation),
  *Änderungen verwerfen* and *Speichern*; the old button row in the middle of the page is gone.
  Closing or reloading the tab with unsaved changes asks for confirmation.
- The **preview** shows one view at a time with radio-group switches *Webmail* / *Anmeldeseite*
  and *hell* / *dunkel*; the webmail view includes the default background, the login view the
  background image, logo, welcome text and footer links. Below the `xl` breakpoint it sits under
  the form.
- **Favicon from the logo**: without an own favicon, a PNG light logo becomes a square favicon —
  `GET /branding/favicons/<sha256>-64.png` and an `apple-touch-icon` `…-180.png`, the logo scaled
  into a transparent square by the gateway (pure-JS PNG codec, no new dependency). SVG and WebP
  logos are used as they are, as before. An own favicon still wins; stored favicons and dark logos
  stay valid.
