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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const failures = [];

const read = (path) => readFileSync(join(root, path), 'utf8');

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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

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

if (process.argv.includes('--record')) {
  const { released } = changelogSections(read(CHANGELOG));
  const sections = Object.fromEntries(released.map((section) => [section.version, section.hash]));
  writeFileSync(join(root, LEDGER), `${JSON.stringify({ note: LEDGER_NOTE, sections }, null, 2)}\n`);
  console.log(
    `recorded ${released.length} released section(s): ${released.map((section) => section.version).join(', ')}`,
  );
  process.exit(0);
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

  // The entry-level budget. Measured before it was chosen: on 2026-10-07 the longest
  // 已完成 entry is 333 characters (line 100, the PR-description entry folded over its
  // wrapped lines); the next ones are 248, 211 and 210. 350 is therefore the smallest
  // round number above the content the file actually holds, so the guard is green
  // today and bounds the next growth — an entry budget of 250 would already fail this
  // file, and trimming an entry is a content change rather than a guard. Raise the
  // number only with a measurement in the same change.
  const ENTRY_CHAR_BUDGET = 350;
  const entries = [];
  let current;
  done.rows.slice(1).forEach((row, index) => {
    if (/^- /.test(row)) {
      if (current) entries.push(current);
      current = { line: done.start + index + 2, text: row };
      return;
    }
    if (!current) return;
    const trimmed = row.trim();
    // A blank line or a nested `- ` item ends this entry: sub-items are their own
    // items, and folding them in would make the parent's size depend on how its
    // children were written.
    if (trimmed === '' || /^- /.test(trimmed)) {
      entries.push(current);
      current = undefined;
      return;
    }
    current.text += ` ${trimmed}`;
  });
  if (current) entries.push(current);
  const oversized = entries
    .map((entry) => ({ line: entry.line, chars: entry.text.replace(/\s+/g, ' ').trim().length }))
    .filter((entry) => entry.chars > ENTRY_CHAR_BUDGET);
  check(
    `FEATURES.md 已完成 entries stay within ${ENTRY_CHAR_BUDGET} chars`,
    oversized.map((entry) => `line ${entry.line} (${entry.chars} chars)`).join(', '),
    oversized.length === 0,
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
  const malformed = versions.filter((entry) => entry.text !== '## [Unreleased]' && !RELEASED_HEADING.test(entry.text));
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

console.log(
  failures.length === 0
    ? '\ntracking documents: 0 violations'
    : `\ntracking documents: ${failures.length} violation(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
