### Added

- **Webmail compose: table size picker.** "Tabelle einfügen" in the table menu (formatting flyout
  and ribbon) opens an 8 × 8 grid instead of always inserting 3 × 3: hovering highlights the
  top-left rectangle and shows "Spalten × Zeilen", a click inserts that size (first row a header row
  as before). Keyboard accessible (`role="grid"`, arrows / Home / End / PageUp / PageDown, Enter or
  Space inserts, Escape goes back to the menu).
- **Webmail compose: growing tables.** Round "+" handles (24 × 24 px) centred on the right and bottom
  edge of the table under the pointer or with the cursor add a column after the last column
  ("Spalte hinzufügen") or a row after the last row ("Zeile hinzufügen"), with the cursor in the
  first new cell. The handles are an overlay outside the document, so drafts and sent mail never
  contain them; not shown in plain-text format. Enter on the empty last paragraph of a table's last
  cell adds a row (Tab in the last cell already did); any other Enter stays a line break in the cell.
