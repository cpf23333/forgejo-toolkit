// Tracking-document audit.
//
// AGENTS.md states the roles of the project tracking documents, but nothing
// enforced them, so the files drifted: TODO.md grew a "what shipped" history
// section while FEATURES.md's 已完成 section filled up with open work, soak
// numbers and "待定/剩余" fragments — the same content in the wrong file, and
// reviews that only diffed the newest entry never noticed. This audit turns
// those rules into checks that fail loudly.
//
// Two guards were added after each class bit us for real (2026-10-07):
//
// 1. **The changelog's structure, and its released sections as frozen text.** New
//    notes belong under `## [Unreleased]`; a line written into an already-released
//    section is invisible to every other check and ships as a false release note
//    (that happened: an entry for an unreleased change landed inside `[0.2.0]`).
//    What is decidable without git history is: exactly one undated
//    `## [Unreleased]`, first in the file; every other version heading shaped
//    `## [x.y.z] - YYYY-MM-DD`; and every released section still hashing to what
//    `released-sections.json` recorded — `--record` rewrites that ledger, and the
//    release cut is when it must be run, because the section the release renames
//    is a new released section with no recorded hash yet.
//    What this **cannot** catch: who or when changed a released section (only that
//    the text differs); whether an `[Unreleased]` entry is worded, placed or
//    sectioned well; whether a pending change has an `[Unreleased]` entry at all (a
//    changeset with no entry is legitimate for an internal change, per
//    `docs/release.md`); and whether the root and package CHANGELOG copies agree
//    (that is `packages/forgejo-toolkit/src/__tests__/packagingFiles.test.ts`).
// 2. **`FEATURES.md`'s 已完成 entries stay within a character budget.** The section
//    grew back twice, and the per-line cap let one entry sprawl over many wrapped
//    lines. The unit is an **entry**: a top-level `- ` item plus its wrapped
//    continuation text (nested `- ` sub-items are their own items and are not folded
//    in), whitespace collapsed. 已完成 only: 未完成 carries what an unstarted item
//    needs, by the maintainer's ruling.
//
// Usage: node tools/tracking-audit/check.mjs [--record]
//   --record  rewrite released-sections.json from the current CHANGELOG.md (run at
//             a release cut, or after amending a release note on purpose). It prints
//             what it recorded and exits 0: it is a maintenance command, not a check.
// Exit code 1 when a rule is violated, so it can gate CI like the api audit.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DONE_SECTION_CHAR_BUDGET,
  ENTRY_CHAR_BUDGET,
  entriesOverBudget,
  sectionCharTotal,
  sectionEntries,
} from './rules.mjs';

/**
 * The repository this checker audits by default, and the state one run keeps.
 *
 * `runAudit` takes the root as a parameter so the checks can be exercised against a
 * fixture tree instead of only against this repository; the default is exactly what this
 * script has always audited, so CI's invocation is unchanged (`--root <dir>` overrides it,
 * which is what the fixture tests use). The printed lines are collected rather than
 * printed here, so a caller can assert on them and the script entry point can print them
 * in the same order as before.
 */
const defaultRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
let currentRoot = defaultRoot;
let failures = [];
let lines = [];

const read = (path) => readFileSync(join(currentRoot, path), 'utf8');

/** Headings of a document, with the line each one sits on. */
function headings(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((entry) => /^##+ /.test(entry.text));
}

/** Everything between two headings (the second heading excluded). */
function span(text, from, until) {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex((line) => line.trim().startsWith(from));
  if (start < 0) return { rows: [], start };
  let end = rows.length;
  for (let index = start + 1; index < rows.length; index += 1) {
    if (until && rows[index].trim().startsWith(until)) {
      end = index;
      break;
    }
  }
  return { rows: rows.slice(start, end), start };
}

/** The file's one-line role header: the first plain paragraph after the title. */
function roleHeader(text) {
  const rows = text.split(/\r?\n/);
  for (let index = 0; index < Math.min(rows.length, 8); index += 1) {
    const line = rows[index].trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('>')) continue;
    return { line: index + 1, text: line };
  }
  return undefined;
}

function check(name, detail, ok) {
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

/**
 * Runs every tracking check against one root, and returns what a caller needs: the lines
 * the checker would print, and the failures behind them.
 *
 * `record` is the `--record` mode: it rewrites the changelog's frozen-section ledger and
 * returns without running the checks — a maintenance command, not a check.
 */
export function runAudit({ root = defaultRoot, record = false } = {}) {
  currentRoot = root;
  failures = [];
  lines = [];

  // --- The changelog's frozen sections ---------------------------------------------

  const CHANGELOG = 'CHANGELOG.md';
  const LEDGER = 'tools/tracking-audit/released-sections.json';
  const RECORD_COMMAND = 'node tools/tracking-audit/check.mjs --record';
  const LEDGER_NOTE =
    'Frozen released sections of CHANGELOG.md. A section is hashed as its body: the heading line through the line before the next `## ` heading, trailing blank lines dropped, LF-joined. Rewrite with `node tools/tracking-audit/check.mjs --record` at a release cut (the renamed section is new) or when a release note is amended on purpose.';
  const RELEASED_HEADING = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/;

  const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

  /**
   * Every `## [` heading of a changelog, and the released ones with the hash the ledger
   * records. A released section's body is its own bytes: any edit to a released note
   * changes the hash, which is the whole point (there is no history to compare against).
   */
  function changelogSections(text) {
    const rows = text.split(/\r?\n/);
    const versions = rows
      .map((line, index) => ({ index, line: index + 1, text: line.trim() }))
      .filter((entry) => /^## \[/.test(entry.text));
    const released = [];
    versions.forEach((heading, position) => {
      const match = RELEASED_HEADING.exec(heading.text);
      if (!match) return;
      const next = versions[position + 1];
      const body = rows.slice(heading.index, next ? next.index : rows.length);
      while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
      released.push({ version: match[1], line: heading.line, hash: sha256(body.join('\n')) });
    });
    return { versions, released };
  }

  if (record) {
    const { released } = changelogSections(read(CHANGELOG));
    const sections = Object.fromEntries(released.map((section) => [section.version, section.hash]));
    writeFileSync(join(currentRoot, LEDGER), `${JSON.stringify({ note: LEDGER_NOTE, sections }, null, 2)}\n`);
    lines.push(
      `recorded ${released.length} released section(s): ${released.map((section) => section.version).join(', ')}`,
    );
    return { failures, lines, recorded: true };
  }

  function readLedger() {
    try {
      const parsed = JSON.parse(read(LEDGER));
      return parsed && typeof parsed.sections === 'object' ? parsed.sections : undefined;
    } catch {
      return undefined;
    }
  }

  // 1. TODO.md holds only unfinished work: no completed/history section.
  {
    const text = read('TODO.md');
    const bad = headings(text).filter((heading) => /已完成|已发布|已交付/.test(heading.text));
    check(
      'TODO.md has no completed/history heading',
      bad.map((heading) => `line ${heading.line}: ${heading.text}`).join(', '),
      bad.length === 0,
    );
    const lists = text.split(/\r?\n/).filter((line) => /^- \[[ x]\]/.test(line.trim()));
    const open = lists.filter((line) => line.trim().startsWith('- [ ]'));
    check(
      'TODO.md items are open (no checked boxes)',
      `${lists.length - open.length} checked item(s)`,
      lists.length === open.length,
    );
    check('TODO.md carries a role header', 'none in the first 8 lines', roleHeader(text) !== undefined);
  }

  // 2. FEATURES.md's 已完成 is a delivered-feature record, not a task list.
  {
    const text = read('FEATURES.md');
    const done = span(text, '## 已完成', '## ');
    check('FEATURES.md has a 已完成 section', 'heading not found', done.start >= 0);
    const openMarkers = /待定|待实测|待实现|剩余|未实现|尚未实现|暂缓/;
    // Every line of the section, not only its list entries: open work hidden in a
    // continuation line or a sub-heading is still open work.
    const offenders = done.rows
      .map((line, index) => ({ line: done.start + index + 1, text: line.trim() }))
      .filter((entry) => entry.text !== '' && openMarkers.test(entry.text));
    check(
      'FEATURES.md 已完成 lists no open work',
      offenders.map((entry) => `line ${entry.line}`).join(', '),
      offenders.length === 0,
    );
    const long = done.rows
      .map((line, index) => ({ line: done.start + index + 1, chars: line.trim().length }))
      .filter((entry) => entry.chars > 600);
    check(
      'FEATURES.md 已完成 entries stay short',
      long.map((entry) => `line ${entry.line} (${entry.chars} chars)`).join(', '),
      long.length === 0,
    );

    // The two size bounds and the counting they are measured with live in `rules.mjs`, next
    // to their own measured justification, so the audit's test file can exercise the **real**
    // numbers at their boundaries instead of copies of them. One bound catches an entry
    // bloating into a design note; the other catches the section fattening one reasonable
    // entry at a time. `未完成` is exempt from both, as it carries the context of open work.
    const entries = sectionEntries(done.rows.slice(1), done.start + 2);
    const oversized = entriesOverBudget(entries, ENTRY_CHAR_BUDGET);
    check(
      `FEATURES.md 已完成 entries stay within ${ENTRY_CHAR_BUDGET} chars`,
      oversized.map((entry) => `line ${entry.line} (${entry.chars} chars)`).join(', '),
      oversized.length === 0,
    );
    const doneTotal = sectionCharTotal(entries);
    check(
      `FEATURES.md 已完成 stays within ${DONE_SECTION_CHAR_BUDGET} characters`,
      `the section holds ${doneTotal} characters`,
      doneTotal <= DONE_SECTION_CHAR_BUDGET,
    );

    check('FEATURES.md carries a role header', 'none in the first 8 lines', roleHeader(text) !== undefined);
  }

  // 3. Known issues: both languages, same headings.
  {
    const en = headings(read('KNOWN_ISSUES.md'));
    const zh = headings(read('KNOWN_ISSUES.zh.md'));
    check(
      'KNOWN_ISSUES.md and .zh.md have the same heading count',
      `en=${en.length} zh=${zh.length}`,
      en.length === zh.length,
    );
  }

  // 4. Tracking files are referenced by name, never by a line number that rots.
  {
    const skip = new Set(['node_modules', '.git', 'out', 'dist', 'shots', 'profile', '.changeset']);
    const pattern = /(TODO|FEATURES|KNOWN_ISSUES(?:\.zh)?)\.md:\d+/;
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|ts|vue|json)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        text.split(/\r?\n/).forEach((line, index) => {
          if (pattern.test(line)) hits.push(`${relative(root, full)}:${index + 1}`);
        });
      }
    };
    walk(root);
    check(
      'no line-number citations of the tracking documents',
      hits.slice(0, 8).join(', ') + (hits.length > 8 ? ` (+${hits.length - 8} more)` : ''),
      hits.length === 0,
    );
  }

  // 5. The changelog: new notes under [Unreleased], released sections frozen by hash.
  {
    const text = read(CHANGELOG);
    const { versions, released } = changelogSections(text);
    const unreleased = versions.filter((entry) => /^## \[Unreleased\]/.test(entry.text));
    check('CHANGELOG.md has exactly one [Unreleased] section', `${unreleased.length} found`, unreleased.length === 1);
    check(
      'CHANGELOG.md opens with [Unreleased]',
      versions.length === 0 ? 'no version heading' : `first is ${versions[0].text} (line ${versions[0].line})`,
      versions.length > 0 && /^## \[Unreleased\]$/.test(versions[0].text),
    );
    check(
      '[Unreleased] carries no release date',
      unreleased.map((entry) => `line ${entry.line}: ${entry.text}`).join(', '),
      unreleased.every((entry) => entry.text === '## [Unreleased]'),
    );
    const malformed = versions.filter(
      (entry) => entry.text !== '## [Unreleased]' && !RELEASED_HEADING.test(entry.text),
    );
    check(
      'every other version heading reads ## [x.y.z] - YYYY-MM-DD',
      malformed.map((entry) => `line ${entry.line}: ${entry.text}`).join(', '),
      malformed.length === 0,
    );

    const recorded = readLedger();
    if (recorded === undefined) {
      check('released sections match the freeze ledger', `cannot read ${LEDGER}`, false);
    } else {
      const unrecorded = released.filter((section) => recorded[section.version] === undefined);
      check(
        'every released section is recorded in the freeze ledger',
        `${unrecorded.map((section) => `${section.version} (line ${section.line})`).join(', ')} — run \`${RECORD_COMMAND}\``,
        unrecorded.length === 0,
      );
      // A line added to an already-released section is exactly what this catches: the
      // section's bytes change, so its recorded hash stops matching.
      const changed = released.filter(
        (section) => recorded[section.version] !== undefined && recorded[section.version] !== section.hash,
      );
      check(
        'released sections are unchanged since they were recorded',
        `${changed.map((section) => `${section.version} (line ${section.line})`).join(', ')} — a new note belongs under [Unreleased]; re-record only when the release itself was amended`,
        changed.length === 0,
      );
    }
  }

  return { failures, lines, recorded: false };
}

/**
 * The script entry point: print what a run produced, in the order `check` recorded it, and
 * exit non-zero on a violation.
 *
 * `--root <dir>` audits another tree (the fixture tests use it); the default stays this
 * repository, so `node tools/tracking-audit/check.mjs` behaves exactly as it always has.
 */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const rootArgument = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  // A bare `--root` used to fall back to this repository and report a clean audit of the
  // wrong tree, with no hint that the argument was never read: fail instead, saying what the
  // flag needs, and print no audit lines at all.
  if (rootIndex >= 0 && (rootArgument === undefined || rootArgument.startsWith('--'))) {
    console.error('--root needs a directory: pass `--root <dir>` with the tree to audit.');
    process.exit(1);
  }
  // A typo in the path used to surface as a raw ENOENT stack. Failing is right; a stack
  // trace is not — name the directory instead.
  if (rootArgument !== undefined && !existsSync(resolve(rootArgument))) {
    console.error(`No such directory to audit: ${resolve(rootArgument)}`);
    process.exit(1);
  }
  const {
    failures: reported,
    lines: printed,
    recorded,
  } = runAudit({
    ...(rootArgument === undefined ? {} : { root: resolve(rootArgument) }),
    record: args.includes('--record'),
  });
  for (const line of printed) {
    console.log(line);
  }
  if (!recorded) {
    console.log(
      reported.length === 0
        ? '\ntracking documents: 0 violations'
        : `\ntracking documents: ${reported.length} violation(s)`,
    );
  }
  process.exit(recorded || reported.length === 0 ? 0 : 1);
}
