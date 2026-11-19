# Webmail accessibility and responsive layout

Target: WCAG 2.2 AA. Colours only through the theme tokens (`theme-guard.test.ts`).

## Landmarks

| Landmark | Element |
|---|---|
| banner | top bar (`TopBar`) |
| navigation | app rail / bottom bar (`AppRail`), folder tree (`aria-label="Ordner"`) |
| main | `<main id="main-content">` of the app frame |
| complementary | folder pane (`aside`, "Postfachbereich"), calendar list ("Kalenderliste") |

A "Zum Inhalt springen" link is the first focusable element and moves focus to `main`.

## Widgets

- **Folder tree**: `role="tree"` / `treeitem` with `aria-level`, `aria-selected`, `aria-expanded`.
  One tab stop (roving tabindex, `hooks/useRovingFocus.ts`). Up/Down/Home/End move, Right opens a
  node or steps into it, Left closes it or steps to the parent (`lib/rovingFocus.ts`).
- **Message list**: `role="grid"` with one `row` per message and `aria-selected`. One row is in the
  tab order; Up/Down/Home/End/PageUp/PageDown move, Enter opens, Delete deletes. The buttons inside a
  row are only tabbable on that row and the quick actions show while the row has keyboard focus.
  Arrow keys move focus only; keyboard commands (Enter, Delete, `j`/`k`, `x` ...) act on the
  focused row, else on the open message, so focus and target never differ.
  When the focused row leaves the list (delete, move, archive) focus goes to its neighbour.
- **Reading pane**: single pane layout moves focus into the opened message and back onto its row on
  "back". Dialogs (`Modal`) trap focus and return it on close.
- **Live regions**: toasts (undo send / delete / move, new mail) and the selection counter of the
  command bar are `role="status"`; nothing is announced twice.
- Targets are at least 24 x 24 px (checkbox and flag of the list rows included); the focus ring is
  the global `:focus-visible` outline in the accent text token.

## Keyboard shortcuts

Settings -> Ansicht -> Tastenkürzel: "CoreMail" (default), "Gmail" or off. The choice is a roaming
preference (`preferences.view.shortcutsEnabled` / `shortcutSet`, server-validated in
`api-gateway/src/lib/user-preferences.ts`, copy in `web-client/src/lib/preferences.ts`).
`?` opens the list. Shortcuts never fire while typing in an input, textarea, select or editor, nor in
the compose window, nor while a dialog is open (`lib/shortcuts.ts`, tested).

Gmail-compatible keys: `c` new, `r` reply, `a` reply all, `f` forward, `e` archive, `#` delete,
`!` spam, `s` flag, `v` move, `j`/`k` next/previous, `o`/Enter open, `u` back, `x` select,
`z` undo, `/` search, `g i` inbox, `g s` flagged, `g t` sent, `g d` drafts, `?` help.

## Responsive layout

| Width | Mail view | Navigation |
|---|---|---|
| below 768 px | one pane at a time: folders -> list -> message, back button, compose full screen | bottom bar |
| 768 - 1099 px | list + message (or compose); folders in a drawer opened by the "Ordner" button | left rail |
| 1100 px and up | three panes, reading pane preference (right / bottom / off) respected | left rail |

The state machine is `lib/layoutMode.ts`. The calendar starts in the day view below 768 px and hides
its calendar list there. No horizontal page scrolling at 320 px.

## Manual checks (no axe-core in the repo)

Tab order on the mail view; arrow keys in tree and list with a screen reader (tree/grid announced,
selection read); delete a message from the keyboard and check focus; 320 px and 200 % zoom;
single-pane flow with back button; dialog open/close focus return; `?` dialog.
