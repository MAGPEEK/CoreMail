### Added

- **Personal mail templates ("Vorlagen").** Users keep templates with name, subject, body and
  optional An / Cc / Bcc (no attachments; at most 200 per user, body up to 256 KB).
  REST `GET/POST /api/v1/mail/templates`, `GET/PUT/DELETE /api/v1/mail/templates/:id` — own
  templates only (another user's id answers 404), validation errors 400 `TEMPLATE_INVALID` with the
  failing fields, the 201st template 409 `TEMPLATE_LIMIT`. Writes reach the user's other tabs as the
  realtime event `settings` with the new section `templates`. New table `mail_templates`
  (additive schema change).
- **Webmail:** "Neue E-Mail aus Vorlage" picker (search, preview, "Verwenden" opens a new compose
  tab with subject, recipients and body before the default signature; hook `useTemplatePicker()`
  for the ribbon), "Vorlagen verwalten" (list + editor with the compose recipient fields and editor),
  compose "…" menu "Vorlage einfügen …" (body at the cursor, subject / recipients only while empty)
  and "Als Vorlage speichern …" (without signature and quoted original), Settings → Vorlagen.
  Template bodies are sanitised with the mail sanitiser before saving, when loaded into an editor
  and on display.
