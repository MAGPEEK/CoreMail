# w2b-e2e-fixes — changelog text (Keep a Changelog)

### Fixed
- Webmail policy: switching the module "App-Passwörter" back on applies to IMAP, POP3, SMTP, JMAP,
  MAPI and Autodiscover logins at once. These services did not follow the policy reload signal and
  refused existing app passwords for up to 30 s after the module was enabled again.
