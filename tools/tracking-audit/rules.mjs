// The tracking audit's rules, as pure functions, so a test file can exercise them without
// the live repository.
//
// `check.mjs` reads the real documents and reports `ok`/`FAIL` lines; this module holds the
// parts that are decidable from rows alone — how a section's entries are counted and where
// the two size bounds sit. Keeping the bounds here rather than in `check.mjs` is what lets
// the tests assert the **real** budget at its boundary instead of a copy of the number.

/**
 * The characters one `- ` entry of a section may take.
 *
 * **Why this exists:** to stop one entry growing into a design note. Measured with
 * {@link sectionEntries} — top-level `- ` items with their wrapped continuation lines
 * folded in, nested `- ` items counted separately:
 *
 *   2026-10-07: 111 entries; one entry at 333 characters (the PR-description entry) is why
 *               the bound was 350 — a bound has to admit the content the file holds. The
 *               record owner then rewrote that entry (240) on the maintainer's decision, so
 *               the longest became 248 and exactly one entry had been over 250.
 *   2026-10-07: tightened to 250 as the maintainer asked, after that trim landed and after
 *               re-measuring: 111 entries, 0 over 250, longest 248.
 *
 * Moving this number requires the measurement in the same change: a bound the file cannot
 * satisfy is a red tree, not a stricter rule.
 */
export const ENTRY_CHAR_BUDGET = 250;

/**
 * The characters the whole `已完成` section may take.
 *
 * **Why a second bound exists beside the per-entry one:** the entry cap cannot see
 * accumulation. A section can grow release after release with every entry comfortably under
 * 250, one reasonable entry at a time, and nothing would say so — the complaint the
 * maintainer raised twice. The two rules catch different failures: one catches an entry
 * bloating into a design note, this one catches the section fattening by a hundred
 * well-behaved entries.
 *
 * Measured with {@link sectionEntries} (folded entry lengths, summed):
 *
 *   2026-10-07: 111 entries, 9,660 characters (mean 87, longest 248). 10,500 is that
 *               measurement plus deliberate headroom — the readable figure nearest +10%
 *               (9,660 × 1.1 = 10,626) — so the section can take a few more entries before
 *               anyone has to decide whether it should.
 *
 * `未完成` is **exempt**: it carries the context of work not yet done, and squeezing it
 * would only lose information. Moving this number requires the measurement in the same
 * change, for the same reason as the per-entry bound.
 */
export const DONE_SECTION_CHAR_BUDGET = 10_500;

/**
 * One `- ` entry of a section, with the characters it counts as.
 *
 * An entry starts at a top-level `- ` row and runs until the next top-level `- `, a nested
 * `- ` (which is its own item, not part of its parent's size) or a blank line. Its size is
 * its text with whitespace collapsed, so how the prose happens to be wrapped is not what
 * the budget measures. `rows` is the section **without** its heading, and `firstLineNumber`
 * is the absolute line the first row sits on, so a failure can name a line a reader can go
 * to.
 */
export function sectionEntries(rows, firstLineNumber) {
  const entries = [];
  let current;
  rows.forEach((row, index) => {
    if (/^- /.test(row)) {
      if (current) entries.push(current);
      current = { line: firstLineNumber + index, text: row };
      return;
    }
    if (!current) return;
    const trimmed = row.trim();
    if (trimmed === '' || /^- /.test(trimmed)) {
      entries.push(current);
      current = undefined;
      return;
    }
    current.text += ` ${trimmed}`;
  });
  if (current) entries.push(current);
  return entries.map((entry) => ({ ...entry, chars: entry.text.replace(/\s+/g, ' ').trim().length }));
}

/** The entries over one per-entry budget, in the order they appear. */
export function entriesOverBudget(entries, budget) {
  return entries.filter((entry) => entry.chars > budget);
}

/** What a section's entries add up to. */
export function sectionCharTotal(entries) {
  return entries.reduce((sum, entry) => sum + entry.chars, 0);
}
