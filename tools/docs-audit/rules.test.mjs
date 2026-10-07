// Tests for the pure documentation-audit rules. Run with:
//
//   node --test "tools/docs-audit/**/*.test.mjs"
//
// (CI currently runs only `check.mjs`; wiring this file into the workflow is a
// separate change.)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparePairStructure,
  headingsOfLines,
  namesTitleIn,
  pairCounts,
  sectionShapes,
  titlesOfLines,
} from './rules.mjs';

const lines = (...rows) => rows;

test('headingsOfLines ignores `#` comments inside fenced code', () => {
  const found = headingsOfLines(
    lines('# Title', '', '```bash', '# Install dependencies', 'pnpm install', '```', '## Real'),
  );
  assert.deepEqual(
    found.map((heading) => heading.text),
    ['# Title', '## Real'],
  );
  assert.equal(found[1].line, 7);
});

test('a citation longer than 40 characters resolves like a short one', () => {
  const long = 'P4 AI 接入 OpenAI 兼容端点（可选的第二种模型传输，默认仍走 vscode.lm）';
  assert.ok(long.length > 40, 'the fixture must be longer than the removed cap');
  const titles = titlesOfLines(lines(`## ${long}`, ''));
  assert.equal(namesTitleIn(titles, long), true);
  // The dangling reference that used to be skipped: same shape, one word changed.
  assert.equal(namesTitleIn(titles, 'P4 AI 接入 OpenAI 兼容端点（可选的第二种模型传输，默认改走别的通道）'), false);
});

test('a citation whose heading was removed does not resolve', () => {
  const titles = titlesOfLines(lines('# Docs', '', '## Kept', ''));
  assert.equal(namesTitleIn(titles, 'Removed entry'), false);
});

test('a citation wrapped across source lines collapses its whitespace', () => {
  const heading = '### 2.1 选项 `forgejoToolkit.multiWindowLease` 的用途与用户可见语义';
  const titles = titlesOfLines(lines(heading, ''));
  const wrapped = '2.1 选项\n    `forgejoToolkit.multiWindowLease` 的用途与用户可见语义';
  assert.equal(namesTitleIn(titles, wrapped), true);
});

test('an ellipsis abbreviates by prefix, and only with the ellipsis', () => {
  const titles = titlesOfLines(lines('## Release guide opens the next section', ''));
  assert.equal(namesTitleIn(titles, 'Release guide opens…'), true);
  assert.equal(namesTitleIn(titles, 'Release guide opens'), false);
  assert.equal(namesTitleIn(titles, 'Nonexistent…'), false);
});

test('list entries are citable by title, with and without their P-label', () => {
  const titles = titlesOfLines(lines('- **P2 Issue 分诊建议**：按内容建议标签。', '- [ ] **P4** AI 接入端点：说明。'));
  assert.equal(namesTitleIn(titles, 'P2 Issue 分诊建议'), true);
  assert.equal(namesTitleIn(titles, 'Issue 分诊建议'), true);
  assert.equal(namesTitleIn(titles, 'P4 AI 接入端点'), true);
  assert.equal(namesTitleIn(titles, 'P4 别的条目'), false);
});

const PAIR_EN = lines('# Doc', '', '## Alpha', '', '- one', '- two', '', '## Beta', '', 'Some prose.');
const PAIR_ZH_SAME = lines('# 文档', '', '## 甲', '', '- 一', '- 二', '', '## 乙', '', '一些正文。');
const PAIR_ZH_SWAPPED = lines('# 文档', '', '## 乙', '', '一些正文。', '', '## 甲', '', '- 一', '- 二');

test('sectionShapes records level and per-section counts in order', () => {
  const shapes = sectionShapes(PAIR_EN);
  assert.deepEqual(
    shapes.map((section) => [section.level, section.lists, section.fences, section.tables]),
    [
      [1, 0, 0, 0],
      [2, 2, 0, 0],
      [2, 0, 0, 0],
    ],
  );
});

test('an equivalent pair reports nothing', () => {
  assert.deepEqual(comparePairStructure('doc.md', 'doc.zh.md', PAIR_EN, PAIR_ZH_SAME), []);
});

test('two swapped sections are caught, with both files and both positions', () => {
  const findings = comparePairStructure('doc.md', 'doc.zh.md', PAIR_EN, PAIR_ZH_SWAPPED);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /doc\.zh\.md:3/);
  assert.match(findings[0], /doc\.md:3/);
  assert.match(findings[0], /「## 乙」/);
  assert.match(findings[0], /「## Alpha」/);
  // Totals and headings are equal, which is exactly why the old rule missed it.
  assert.deepEqual(pairCounts(PAIR_EN), pairCounts(PAIR_ZH_SWAPPED));
  assert.deepEqual(
    sectionShapes(PAIR_EN).map((section) => section.level),
    sectionShapes(PAIR_ZH_SWAPPED).map((section) => section.level),
  );
});

test('a level divergence is reported at its position', () => {
  const zh = lines('# 文档', '', '### 甲', '', '- 一', '- 二', '', '## 乙', '', '一些正文。');
  const findings = comparePairStructure('doc.md', 'doc.zh.md', PAIR_EN, zh);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /doc\.zh\.md:3 heading #2 is 「### 甲」 \(h3\)/);
  assert.match(findings[0], /doc\.md:3 heading #2 is 「## Alpha」 \(h2\)/);
});

test('a total drift keeps its original message and skips the positional pass', () => {
  const zh = lines('# 文档', '', '## 甲', '', '- 一', '- 二');
  const findings = comparePairStructure('doc.md', 'doc.zh.md', PAIR_EN, zh);
  assert.deepEqual(findings, ['doc.zh.md and doc.md differ in headings: 3 vs 2']);
});

test('two structurally identical sections may be swapped without a signal (documented boundary)', () => {
  const en = lines('## One', '', '## Two');
  const zh = lines('## 二', '', '## 一');
  assert.deepEqual(comparePairStructure('doc.md', 'doc.zh.md', en, zh), []);
});

test('a fence or table that moves to another section is caught', () => {
  const en = lines('## A', '', '```bash', 'x', '```', '', '## B');
  const zh = lines('## 甲', '', '## 乙', '', '```bash', 'x', '```');
  assert.deepEqual(pairCounts(en), pairCounts(zh));
  const findings = comparePairStructure('doc.md', 'doc.zh.md', en, zh);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /doc\.zh\.md:1 heading #1 「## 甲」 holds 0\/0\/0/);
  assert.match(findings[0], /doc\.md:1 heading #1 「## A」 holds 0\/2\/0/);
});
