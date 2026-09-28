// Tracking-document audit.
//
// AGENTS.md states the roles of the project tracking documents, but nothing
// enforced them, so the files drifted: TODO.md grew a "what shipped" history
// section while FEATURES.md's 已完成 section filled up with open work, soak
// numbers and "待定/剩余" fragments — the same content in the wrong file, and
// reviews that only diffed the newest entry never noticed. This audit turns
// those rules into checks that fail loudly.
//
// Usage: node tools/tracking-audit/check.mjs
// Exit code 1 when a rule is violated, so it can gate CI like the api audit.

import { readFileSync, readdirSync } from 'node:fs';
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

console.log(
  failures.length === 0
    ? '\ntracking documents: 0 violations'
    : `\ntracking documents: ${failures.length} violation(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
