import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runAudit } from './check.mjs';

/**
 * The tracking checker itself, run against a **fixture tree** rather than this repository.
 *
 * `rules.test.mjs` holds the counting and the two size bounds; this file holds everything
 * that used to be provable only by editing the real documents: the file reading, the
 * printed `ok`/`FAIL` lines and the violation count, the changelog's freeze ledger and its
 * `--record` escape, the TODO checks, the known-issues heading parity and the
 * line-citation check. The checker takes `--root <dir>` (default: this repository) for
 * exactly this, so the fixture needs no copy of the project.
 *
 * What it still does not cover: the webview/vitest suites and the other two audits — this
 * file is about *this* checker's rules and their messages.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const script = join(here, 'check.mjs');

/** A tree that passes every tracking rule, with optional files replaced wholesale. */
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tracking-audit-'));
  mkdirSync(join(root, 'tools', 'tracking-audit'), { recursive: true });
  const files = {
    'CHANGELOG.md':
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a note for the unreleased change\n\n## [0.1.0] - 2024-01-01\n\n### Added\n\n- the shipped thing\n',
    'TODO.md': '# TODO\n\nWhat is left to do here.\n\n- [ ] an open item\n',
    'FEATURES.md':
      '# Features\n\nWhat this plugin does for a user.\n\n## 已完成\n\n- a delivered capability\n\n## 未完成\n\n- a planned capability\n',
    'KNOWN_ISSUES.md': '# Known Issues\n\n## The first issue\n\nWhat happens, and the way around it.\n',
    'KNOWN_ISSUES.zh.md': '# 已知问题\n\n## 第一个问题\n\n会发生什么，以及绕开办法。\n',
    ...overrides,
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, name), text);
  }
  // Record this fixture's own released section into its own ledger: the ledger path is
  // root-relative, which is why the fixture carries `tools/tracking-audit/` as well.
  runAudit({ root, record: true });
  return root;
}

/** The `ok`/`FAIL` line whose rule name contains `fragment`. */
function lineFor(lines, fragment) {
  return lines.find((line) => line.includes(fragment));
}

describe('the tracking checker on a clean fixture', () => {
  it('reports no failure and prints an ok line for every rule', () => {
    const root = fixture();
    const { failures, lines } = runAudit({ root });
    assert.deepEqual(failures, []);
    assert.ok(lines.length > 5, 'every rule reports a line');
    assert.deepEqual(
      lines.filter((line) => !line.startsWith('ok  ')),
      [],
    );
  });

  it('exits zero when run as a script against it', () => {
    const root = fixture();
    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /tracking documents: 0 violations/);
  });
});

describe('the checker’s own CLI', () => {
  const auditLine = /^(ok {2}|FAIL)/m;

  it('refuses a bare --root instead of auditing this repository', () => {
    const result = spawnSync(process.execPath, [script, '--root'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    // No audit lines at all: the caller asked for another tree and must not be told about
    // this one, which is exactly the trap the bare flag used to be.
    assert.doesNotMatch(result.stdout, auditLine);
    assert.doesNotMatch(result.stdout, /tracking documents:/);
    assert.match(result.stderr, /--root needs a directory/);
  });

  it('names a nonexistent root instead of printing an ENOENT stack', () => {
    const missing = join(tmpdir(), 'tracking-audit-does-not-exist', String(process.pid));
    const result = spawnSync(process.execPath, [script, '--root', missing], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, auditLine);
    assert.match(result.stderr, /No such directory to audit:/);
    assert.ok(result.stderr.includes(missing), `the sentence names the path: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /at .*node:internal/);
  });
});

describe('the tracking checker catches a violation', () => {
  it('fails a checked box in the todo and counts it', () => {
    const root = fixture({ 'TODO.md': '# TODO\n\nWhat is left.\n\n- [x] a finished item\n' });
    const { failures } = runAudit({ root });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /TODO\.md items are open \(no checked boxes\): 1 checked item/);
  });

  it('fails an entry over the per-entry bound, naming the line and its size', () => {
    const root = fixture({
      'FEATURES.md': `# Features\n\nWhat this plugin does.\n\n## 已完成\n\n- ${'x'.repeat(249)}\n\n## 未完成\n\n- later\n`,
    });
    const { failures } = runAudit({ root });
    const failure = failures.find((entry) => entry.includes('entries stay within 250 chars'));
    assert.ok(failure, failures.join('\n'));
    assert.match(failure, /line 7 \(251 chars\)/);
  });

  it('fails a section over its total bound, naming the section, its total and the bound', () => {
    const entries = Array.from({ length: 50 }, () => `- ${'y'.repeat(238)}`).join('\n');
    const root = fixture({
      'FEATURES.md': `# Features\n\nWhat this plugin does.\n\n## 已完成\n\n${entries}\n\n## 未完成\n\n- later\n`,
    });
    const { failures } = runAudit({ root });
    const failure = failures.find((entry) => entry.includes('stays within 10500 characters'));
    assert.ok(failure, failures.join('\n'));
    assert.match(failure, /the section holds 12000 characters/);
  });

  it('fails a heading-count mismatch in the known-issues pair', () => {
    const root = fixture({ 'KNOWN_ISSUES.zh.md': '# 已知问题\n\n没有小节。\n' });
    const { failures } = runAudit({ root });
    assert.match(failures.join('\n'), /KNOWN_ISSUES\.md and \.zh\.md have the same heading count/);
  });

  it('fails a line-number citation of a tracking document', () => {
    const root = fixture({ 'NOTES.md': 'see TODO.md:12 for the detail\n' });
    const { failures } = runAudit({ root });
    assert.match(failures.join('\n'), /no line-number citations of the tracking documents/);
  });
});

describe('the changelog freeze ledger', () => {
  it('refuses a changed released section, and --record is the way past it', () => {
    const root = fixture();
    // A new note written into the already-released section: exactly what the ledger is for.
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a note for the unreleased change\n\n## [0.1.0] - 2024-01-01\n\n### Added\n\n- the shipped thing\n- and a line added after the release\n',
    );
    const refused = runAudit({ root });
    assert.match(refused.failures.join('\n'), /released sections are unchanged since they were recorded/);

    // `--record` rewrites the ledger and returns without checking: the only way past it.
    const recorded = runAudit({ root, record: true });
    assert.deepEqual(recorded.failures, []);
    assert.equal(recorded.recorded, true);
    assert.deepEqual(runAudit({ root }).failures, []);
  });

  it('records a section the ledger has never seen', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracking-audit-'));
    mkdirSync(join(root, 'tools', 'tracking-audit'), { recursive: true });
    for (const [name, text] of Object.entries({
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [0.2.0] - 2024-02-02\n\n- shipped\n',
      'TODO.md': '# TODO\n\nWhat is left.\n\n- [ ] an item\n',
      'FEATURES.md': '# Features\n\nWhat it does.\n\n## 已完成\n\n- done\n\n## 未完成\n\n- later\n',
      'KNOWN_ISSUES.md': '# Known Issues\n\n## One\n\nAround it.\n',
      'KNOWN_ISSUES.zh.md': '# 已知问题\n\n## 一\n\n绕开。\n',
    })) {
      writeFileSync(join(root, name), text);
    }
    // An empty ledger exists but has never seen this version, which is the state a release
    // cut leaves behind: the check must ask for a re-record rather than pass.
    writeFileSync(join(root, 'tools', 'tracking-audit', 'released-sections.json'), '{"note":"","sections":{}}\n');
    const before = runAudit({ root });
    assert.match(before.failures.join('\n'), /every released section is recorded in the freeze ledger/);
    const recorded = runAudit({ root, record: true });
    assert.match(recorded.lines.join('\n'), /recorded 1 released section\(s\): 0\.2\.0/);
    assert.deepEqual(runAudit({ root }).failures, []);
  });
});

describe('the default root', () => {
  it('is still this repository, and it passes', () => {
    const { failures, lines } = runAudit();
    assert.deepEqual(failures, []);
    assert.ok(lineFor(lines, 'released sections are unchanged since they were recorded'));
  });
});
