// Fixture-tree tests for the checker itself — the half the pure rule tests in
// `rules.test.mjs` cannot reach: walking a tree, pair discovery, the printed lines and the
// count, and the citation / named-reference / heading rules as applied to real files.
//
// Run with: node --test "tools/docs-audit/**/*.test.mjs"

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runAudit } from './check.mjs';

const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
const roots = [];

/** Writes a fixture tree and returns its root; keys are paths relative to that root. */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'docs-audit-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const audit = (root, options = {}) => runAudit({ root, ...options });
const failuresOf = (root) => audit(root).failures;

/**
 * A tree on which every rule passes: a matching language pair, a citation whose line is
 * inside its target, and a `「…」` reference that resolves.
 */
const CLEAN = {
  'target.ts': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  'guide.md': '# Guide\n\n## Install\n\nSee `target.ts:2` for the value.\n',
  'pair.md': '# Pair\n\n## First\n\n- one\n- two\n\n## Second\n\nProse.\n',
  'pair.zh.md': '# 配对\n\n## 第一\n\n- 一\n- 二\n\n## 第二\n\n正文。\n',
};

test('a clean fixture tree reports nothing, and the CLI exits zero', () => {
  const root = fixture(CLEAN);
  const { failures, lines } = audit(root);

  assert.deepEqual(failures, []);
  assert.match(lines[0], /^auditing \d+ markdown files$/);
  assert.equal(lines[1], '');
  assert.ok(lines.includes('note paired: pair.md <-> pair.zh.md'), lines.join('\n'));

  const run = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // The CLI prints exactly the run's lines, then the summary — nothing else.
  assert.equal(run.stdout, `${lines.join('\n')}\n\ndocumentation: 0 violations\n`);
});

test('the CLI exits non-zero and prints FAIL when a fixture violates a rule', () => {
  const root = fixture({ 'dup.md': '# Dup\n\n## Same\n\ntext\n\n## Same\n\nmore\n' });

  const run = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL dup\.md:7 repeats the heading from line 3/);
  assert.match(run.stdout, /documentation: 1 violation\(s\)/);
});

test('--root with no value refuses instead of auditing the repository', () => {
  const run = spawnSync(process.execPath, [CHECK, '--root'], { encoding: 'utf8' });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--root needs a directory/);
  // No audit ran: not the header, not a single line of it.
  assert.equal(run.stdout, '');
  assert.doesNotMatch(run.stderr, /auditing \d+ markdown files/);

  // A following flag is not a value either.
  const withFlag = spawnSync(process.execPath, [CHECK, '--root', '--record'], { encoding: 'utf8' });
  assert.notEqual(withFlag.status, 0);
  assert.match(withFlag.stderr, /--root needs a directory/);
  assert.equal(withFlag.stdout, '');
});

test('--root with a path that does not exist names the path instead of throwing', () => {
  const parent = mkdtempSync(join(tmpdir(), 'docs-audit-gone-'));
  roots.push(parent);
  const missing = join(parent, 'absent');

  const run = spawnSync(process.execPath, [CHECK, '--root', missing], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--root is not a directory/);
  assert.ok(run.stderr.includes(missing), run.stderr);
  assert.equal(run.stdout, '');
  // A sentence rather than a stack trace: no `ENOENT` and no frames.
  assert.doesNotMatch(run.stderr, /ENOENT/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('a pair that matches passes, and one that differs in headings fails', () => {
  assert.deepEqual(failuresOf(fixture(CLEAN)), []);

  const root = fixture({
    ...CLEAN,
    'pair.zh.md': '# 配对\n\n## 第一\n\n- 一\n- 二\n\n## 第二\n\n正文。\n\n## 多出来\n\n多余。\n',
  });
  const failures = failuresOf(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /pair\.zh\.md and pair\.md differ in headings: 3 vs 4/);
});

test('a pair whose list counts differ fails on the count and on the section order', () => {
  const root = fixture({ ...CLEAN, 'pair.zh.md': '# 配对\n\n## 第一\n\n- 一\n\n## 第二\n\n正文。\n' });
  const failures = failuresOf(root);

  assert.equal(failures.length, 2);
  assert.match(failures[0], /pair\.zh\.md and pair\.md differ in lists: 2 vs 1/);
  assert.match(failures[1], /pair\.zh\.md:3 heading #2/);
});

test('two swapped sections are caught by the ordered half of the pair rule', () => {
  const root = fixture({
    'swap.md': '# S\n\n## A\n\n- one\n- two\n\n## B\n\nprose\n',
    'swap.zh.md': '# S\n\n## 乙\n\nprose\n\n## 甲\n\n- 一\n- 二\n',
  });
  const failures = failuresOf(root);

  assert.equal(failures.length, 2);
  assert.match(failures[0], /swap\.zh\.md:3 heading #2 「## 乙」/);
});

test('a citation inside its target passes, and one past its end fails', () => {
  assert.deepEqual(failuresOf(fixture(CLEAN)), []);

  const root = fixture({ ...CLEAN, 'guide.md': '# Guide\n\n## Install\n\nSee `target.ts:9` for the value.\n' });
  const failures = failuresOf(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /guide\.md:5 cites target\.ts:9 but target\.ts has \d+ lines/);
});

test('a 「heading」 reference that resolves passes, and one that does not fails', () => {
  const resolved = fixture({ ...CLEAN, 'cite.md': '# Cite\n\nSee `pair.md` 的「First」.\n' });
  assert.deepEqual(failuresOf(resolved), []);

  const dangling = fixture({ ...CLEAN, 'cite.md': '# Cite\n\nSee `pair.md` 的「Missing」.\n' });
  const failures = failuresOf(dangling);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /cite\.md:3 names a heading that pair\.md does not have: 「Missing」/);
});

test('a heading repeated among siblings fails', () => {
  const failures = failuresOf(fixture({ 'dup.md': '# Dup\n\n## Same\n\ntext\n\n## Same\n\nmore\n' }));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /dup\.md:7 repeats the heading from line 3: ## Same/);
});

test('a heading that skips a level fails', () => {
  const failures = failuresOf(fixture({ 'jump.md': '# Jump\n\n## Two\n\n#### Four\n' }));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /jump\.md:5 jumps from h2 to h4: #### Four/);
});

test('--record is accepted and changes nothing', () => {
  const root = fixture(CLEAN);
  assert.deepEqual(audit(root, { record: true }), audit(root));
});
