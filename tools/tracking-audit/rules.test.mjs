import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DONE_SECTION_CHAR_BUDGET,
  ENTRY_CHAR_BUDGET,
  entriesOverBudget,
  sectionCharTotal,
  sectionEntries,
} from './rules.mjs';

/**
 * The tracking audit's rules, exercised **without the live repository**.
 *
 * Until this file existed, nothing but the repository itself ran these rules: `check.mjs`
 * reads the real documents, so the only way to find out what a bound does at its edge was
 * to edit `FEATURES.md` and watch the audit. That is a bad way to keep a rule honest — the
 * boundary cases below are exactly the ones a mutation test would otherwise have to perform
 * by hand.
 *
 * The bounds under test are the **real** exported constants, not copies of their numbers,
 * which is why they live in `rules.mjs` rather than in `check.mjs`.
 *
 * What this file does not cover, said plainly: `check.mjs` itself — reading the files,
 * printing `ok`/`FAIL`, the changelog's freeze ledger and `--record`, the TODO and
 * known-issues checks. Those need the repository (or a fixture root `check.mjs` does not
 * take), and are still exercised only by running the audit against the tree.
 */

/** One entry of exactly `chars` characters, so a boundary can be stated instead of guessed. */
function entryOf(chars) {
  return sectionEntries([`- ${'x'.repeat(chars - 2)}`], 1)[0];
}

describe('the entry budget', () => {
  it('passes an entry exactly at the bound', () => {
    assert.deepEqual(entriesOverBudget([entryOf(ENTRY_CHAR_BUDGET)], ENTRY_CHAR_BUDGET), []);
  });

  it('fails an entry one character over the bound', () => {
    const over = entriesOverBudget([entryOf(ENTRY_CHAR_BUDGET + 1)], ENTRY_CHAR_BUDGET);
    assert.deepEqual(
      over.map((entry) => entry.chars),
      [ENTRY_CHAR_BUDGET + 1],
    );
  });

  it('measures the entry the way the audit does, not the way it is wrapped', () => {
    // One sentence over three rows is one entry of the same size as the same sentence on one
    // row: the budget is about how much an entry says, not where the editor broke it.
    const wrapped = sectionEntries(['- alpha beta', '  gamma', '  delta'], 10);
    const flat = sectionEntries(['- alpha beta gamma delta'], 10);
    assert.equal(wrapped.length, 1);
    assert.equal(wrapped[0].chars, flat[0].chars);
    assert.equal(wrapped[0].line, 10);
  });

  it('does not fold a nested item into its parent', () => {
    // A nested row ends the entry above it and is not an entry of its own: the budget must
    // not depend on how a parent's sub-items were written, and a section's nested lists do
    // not silently add to its total.
    const entries = sectionEntries(['- parent', '  - child one', '  - child two'], 1);
    assert.deepEqual(
      entries.map((entry) => entry.chars),
      [8],
    );
  });

  it('ends an entry at a blank line', () => {
    const entries = sectionEntries(['- first', '', 'prose after a gap', '- second'], 1);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].text, '- first');
  });
});

describe('the 已完成 section budget', () => {
  it('passes a section exactly at the bound', () => {
    const entries = sectionEntries([`- ${'y'.repeat(DONE_SECTION_CHAR_BUDGET - 2)}`], 1);
    assert.equal(sectionCharTotal(entries), DONE_SECTION_CHAR_BUDGET);
    assert.ok(sectionCharTotal(entries) <= DONE_SECTION_CHAR_BUDGET);
  });

  it('fails a section one character over the bound', () => {
    const entries = sectionEntries([`- ${'y'.repeat(DONE_SECTION_CHAR_BUDGET - 1)}`], 1);
    assert.equal(sectionCharTotal(entries), DONE_SECTION_CHAR_BUDGET + 1);
    assert.ok(!(sectionCharTotal(entries) <= DONE_SECTION_CHAR_BUDGET));
  });

  it('accumulates entries the per-entry bound would each let through', () => {
    // The failure the two bounds catch together: one entry at a time, each comfortably
    // inside the entry budget, adding up past the section's.
    const count = Math.ceil((DONE_SECTION_CHAR_BUDGET + 1) / ENTRY_CHAR_BUDGET);
    const entries = sectionEntries(
      Array.from({ length: count }, () => `- ${'z'.repeat(ENTRY_CHAR_BUDGET - 2)}`),
      1,
    );
    assert.deepEqual(entriesOverBudget(entries, ENTRY_CHAR_BUDGET), []);
    assert.ok(sectionCharTotal(entries) > DONE_SECTION_CHAR_BUDGET);
  });
});

describe('the counting itself', () => {
  it('reports the absolute line each entry sits on', () => {
    const entries = sectionEntries(['- one', '', '- two'], 40);
    assert.deepEqual(
      entries.map((entry) => entry.line),
      [40, 42],
    );
  });

  it('collapses the whitespace an entry happens to contain', () => {
    const entries = sectionEntries(['- a\t\tb   c'], 1);
    assert.equal(entries[0].chars, '- a b c'.length);
  });

  it('returns nothing for a section with no entries', () => {
    assert.deepEqual(sectionEntries(['prose only'], 1), []);
    assert.equal(sectionCharTotal([]), 0);
  });
});

// The two bounds the audit imports must be the documented ones: a test that asserted a
// copied number could pass while the rule itself drifted.
describe('the bounds the audit imports', () => {
  it('are the documented ones', () => {
    assert.equal(ENTRY_CHAR_BUDGET, 250);
    assert.equal(DONE_SECTION_CHAR_BUDGET, 10_500);
  });
});
