# docs-audit

`node tools/docs-audit/check.mjs` audits every markdown file in the repository and exits
non-zero on a violation (CI runs it too). This directory owns the checker and the pure
rule helpers it is built from (`rules.mjs`), so a rule can be exercised directly by
`rules.test.mjs` without walking the tree.

## What it checks

1. A cited file must exist and a cited line range must fit inside it. Markdown is cited
   by heading, never by a line number, because line numbers move with every paragraph.
2. A markdown link to a repository file must resolve, and its `#anchor` must match a
   heading in the target.
3. A named reference must resolve against the cited document's headings and list-entry
   titles.
4. The two files of a language pair must keep the same structure, **in order**.
5. No duplicate headings among siblings, and no heading-level jumps inside a file.

## Named references: no length limit

Two forms are checked, and both resolve the same way:

```text
`X.md` 的「Some heading」
`X.md` … 「Some heading」一节 / 条目 / 小节
```

The second form borrows the file named earlier in the same paragraph, so a citation that
wraps across source lines still works. **A long name is not exempt**: the rule used to
skip names longer than 40 characters, which is how a dangling reference to a removed
tracking entry survived in a design record until a human read it.

Boundaries, all of which have to stay true or the rule would report working documents:

- An explicit trailing ellipsis (`「Some heading…」`) is the only accepted abbreviation,
  and it must still prefix-match a real title. A partial name without the ellipsis does
  not resolve.
- Whitespace is collapsed before comparing, because the paragraph-scoped form joins the
  wrapped source lines of a citation and would otherwise carry the line break and the
  continuation line's indentation inside the quotes.
- A trailing parenthetical may be dropped (`（…）` or `(…)`), and a list entry's `P<n>`
  label may be used with or without the label glued to the title.
- A quoted string containing prose markers (`→`, `≤`, `=`, `、`, `;`) is prose rather
  than a title and is not checked.
- A reference in a paragraph that names no backticked `*.md` has no target and is not
  checked, and a path belonging to another repository (rule 1's external prefixes) is
  never resolved here.
- A name the citing document itself declares counts as a self-reference, not a citation
  of the other file.

## Language pairs: compared in order

A pair (`X.zh.md` against `X.md`) is compared in two layers:

1. the four totals — headings, list items, fences, table rows;
2. while both files introduce the same number of sections, a positional comparison of
   the heading level sequence and of each section's own shape (the list items, fence
   lines and table rows inside it).

The second layer is what catches two sections that were reordered: totals and heading
levels stay identical, so only the per-section shape reveals it. Diagnostics name both
files, both line numbers, both headings and the differing component.

Boundaries: two sections that are structurally identical (same level, same list, fence
and table counts) can still be swapped without a signal, because the two files are
written in different languages and the rule cannot know that two headings mean the same
thing. Prose, wrapping and section length are deliberately not compared — CJK text is
denser, so line counts differ on purpose. A heading that exists on one side only is
reported by the totals and stops the positional pass, which would otherwise only add
noise.

## Running it

```bash
node tools/docs-audit/check.mjs
node --test "tools/docs-audit/**/*.test.mjs"
```

CI currently runs only `check.mjs`; adding the test command to the workflow is a
separate change.
