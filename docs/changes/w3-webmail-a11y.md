### Added
- Webmail accessibility (WCAG 2.2 AA): folder tree as ARIA tree and message list as ARIA grid with roving tabindex and arrow-key navigation, focus moves to the neighbouring message when the focused one is deleted or moved, a live region for selection announcements, a "skip to content" link, labelled landmarks. See `docs/webmail-accessibility.md`.
- Responsive webmail: below 768 px a single pane flow (folders, message list, message, back button), 768 - 1099 px list and message with the folders in a drawer, the calendar starts in the day view on small screens.

### Changed
- Message list rows and folder items use tree/grid roles instead of `role="button"`; the checkbox and flag of a list row have a 24 px target; the quick actions of a row are shown while it has keyboard focus.

No API, schema or protocol change; no breaking change.
