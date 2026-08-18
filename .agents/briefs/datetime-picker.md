# Date/Time Picker Component — Design Brief

## Job and audience

A reusable date/time picker for the Forgejo Toolkit VS Code extension webview. Users select due dates, deadlines, or release timestamps inside Issue/PR/Milestone/Release forms. The component must feel native to VS Code and work in both Chinese and English.

## Outcome and proof

Primary task: let the user pick a valid ISO 8601 date-time string matching Forgejo's API (`due_date` uses `format: date-time`).
Success: the picker returns a string Forgejo accepts, is keyboard accessible, and visually consistent with surrounding `vscode-elements` form controls.

## Selected direction

- **Visual authority:** VS Code native, not a third-party design system. Use VS Code theme CSS variables (`--vscode-*`) and the same border/radius/spacing rhythm as `vscode-text-field` / `vscode-dropdown`.
- **Interaction thesis:** input box + dropdown calendar panel. The input accepts typed ISO strings and shows the formatted localized value; the panel drops down on focus/click and closes on selection or outside click.
- **Structure:**
  - Top bar: month/year navigation + "today" shortcut.
  - Calendar grid: days of the selected month, with selected/hover/disabled states.
  - Time row: hour and minute inputs (or dropdowns) below the calendar.
  - Footer: clear button + confirm/close affordance.
- **Focal moment:** clicking a date updates the input immediately; time defaults to 00:00 unless already set.

## Scope and boundaries

- **In scope:** single-point date-time selection, keyboard navigation, i18n (en/zh), dark/light theme via VS Code tokens, form integration through `v-model`.
- **Out of scope:** date ranges, recurring dates, timezone selector (emit UTC/offset-aware ISO string; display in local time), inline calendar-only variant.
- **What remains untouched:** existing Issue/PR create/edit forms will swap the native `datetime-local` input for this component; no other form behavior changes.

## States and ranges

- Empty / placeholder
- Filled date with default 00:00 time
- Filled date with custom time
- Disabled (read-only form)
- Invalid (Forgejo rejects the string)
- Calendar open / closed

## Constraints and open decisions

- **Platform:** Vue 3 + VS Code webview; no external date library unless justified. Prefer native `Intl.DateTimeFormat` and manual calendar math to keep bundle small.
- **Accessibility:** keyboard navigation (arrow keys move day, Enter selects, Esc closes), focus trap inside panel, ARIA labels for days and controls.
- **Localization:** all labels from `packages/forgejo-toolkit/webview/src/i18n/{en,zh}.json`.
- **Open decision:** whether to use `vscode-text-field` for the input or a styled native `<input>` to better control the dropdown trigger and formatting.
