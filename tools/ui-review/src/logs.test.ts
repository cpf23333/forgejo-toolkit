// Unit tests for per-window log capture.
//
// Fixtures are the real layout VS Code produces
// (`logs/<session>/window<N>/exthost/exthost.log` plus
// `exthost/output_logging_<stamp>/N-Forgejo Toolkit.log`), so these tests pin
// resolution rules that a real run then only has to confirm — including the one
// that matters most: the session recorded at launch is never silently swapped for
// a newer one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  attributeWindowDirs,
  compilePattern,
  extensionOutputLog,
  exthostLogPath,
  exthostLogPids,
  grepFiles,
  isSessionDirName,
  listSessionDirs,
  listWindowDirs,
  logFilesFor,
  resolveSessionDir,
  selectWindowDirs,
  windowLogDirFacts,
  windowNumber,
} from './logs';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface FixtureWindow {
  exthostPid: number;
  channel: string[];
}

function writeWindow(sessionDir: string, name: string, spec: FixtureWindow): void {
  const dir = path.join(sessionDir, name);
  fs.mkdirSync(path.join(dir, 'exthost', 'output_logging_20260927T164509'), { recursive: true });
  fs.writeFileSync(
    exthostLogPath(dir),
    [
      `2026-09-27 16:45:09.106 [info] Extension host with pid ${spec.exthostPid} started`,
      '2026-09-27 16:45:09.106 [info] Skipping acquiring lock for workspaceStorage.',
      '2026-09-27 16:45:09.341 [info] ExtensionService#_doActivateExtension cpf23333.forgejo-toolkit',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'exthost', 'output_logging_20260927T164509', '1-Forgejo Toolkit.log'),
    `${spec.channel.join('\n')}\n`,
  );
}

function makeFixture(): { logsRoot: string; sessionDir: string; window1: string; window2: string } {
  const logsRoot = tempDir('ui-review-logs-');
  const sessionDir = path.join(logsRoot, '20260927T164507');
  // VS Code numbers its window directories per shell lifetime, so they are not
  // the harness's own window1/window2 labels: this instance started at window3.
  writeWindow(sessionDir, 'window3', { exthostPid: 44400, channel: ['[info] window one'] });
  writeWindow(sessionDir, 'window4', { exthostPid: 52888, channel: ['[info] window two'] });
  return {
    logsRoot,
    sessionDir,
    window1: path.join(sessionDir, 'window3'),
    window2: path.join(sessionDir, 'window4'),
  };
}

test('a session directory name is the timestamped form VS Code writes', () => {
  assert.ok(isSessionDirName('20260927T164507'));
  assert.ok(!isSessionDirName('20260927T16450'));
  assert.ok(!isSessionDirName('window1'));
  assert.ok(!isSessionDirName('20260927T164507-1'));
});

test('sessions are listed oldest-first and the newest is the default', () => {
  const logsRoot = tempDir('ui-review-sessions-');
  fs.mkdirSync(path.join(logsRoot, '20260927T164507'), { recursive: true });
  fs.mkdirSync(path.join(logsRoot, '20260928T090000'), { recursive: true });
  fs.mkdirSync(path.join(logsRoot, 'not-a-session'), { recursive: true });
  fs.writeFileSync(path.join(logsRoot, 'stray.log'), 'x');
  assert.deepEqual(listSessionDirs(logsRoot), ['20260927T164507', '20260928T090000']);
  assert.equal(
    resolveSessionDir(logsRoot),
    path.join(logsRoot, '20260928T090000'),
    'the default is the newest session',
  );
});

test('a pinned session is used even when a newer one exists', () => {
  const logsRoot = tempDir('ui-review-sessions-');
  fs.mkdirSync(path.join(logsRoot, '20260927T164507'), { recursive: true });
  fs.mkdirSync(path.join(logsRoot, '20260928T090000'), { recursive: true });
  const resolved = resolveSessionDir(logsRoot, '20260927T164507');
  assert.equal(resolved, path.join(logsRoot, '20260927T164507'));
  // The dual mode pins the session it launched with; falling back to the newest
  // would mix two sessions' windows in the same "which window is leader" answer.
  assert.notEqual(resolved, resolveSessionDir(logsRoot));
  assert.throws(() => resolveSessionDir(logsRoot, '20260101T000000'), /does not exist under/);
  assert.throws(() => resolveSessionDir(logsRoot, 'nonsense'), /is not a log session name/);
});

test('window directories sort numerically, not lexicographically', () => {
  assert.equal(windowNumber('window1'), 1);
  assert.equal(windowNumber('window10'), 10);
  assert.ok(windowNumber('window2') < windowNumber('window10'));
  assert.equal(windowNumber('nonsense'), Number.MAX_SAFE_INTEGER);
});

test('window labels map to window directories through the extension host pid', () => {
  const fixture = makeFixture();
  const mapped = attributeWindowDirs(
    fixture.sessionDir,
    new Map([
      ['window1', 44400],
      ['window2', 52888],
    ]),
  );
  assert.equal(mapped.window1.name, 'window3');
  assert.equal(mapped.window2.name, 'window4');
  assert.deepEqual(exthostLogPids(mapped.window1.dir), [44400]);
});

test('a window label whose pid matches no directory is refused, not guessed', () => {
  const fixture = makeFixture();
  assert.throws(
    () =>
      attributeWindowDirs(
        fixture.sessionDir,
        new Map([
          ['window1', 44400],
          ['window2', 99999],
        ]),
      ),
    /could not attribute a log directory to window2/,
  );
});

test('the extension output channel is the newest output_logging directory', () => {
  const fixture = makeFixture();
  const dir = fixture.window1;
  // A reload after the extension host is killed starts a new directory; the live
  // channel is the newer one, and reading the older one would show stale lines.
  const newer = path.join(dir, 'exthost', 'output_logging_20260927T170000');
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(newer, '1-Forgejo Toolkit.log'), '[info] after reload\n');
  const picked = extensionOutputLog(dir);
  assert.equal(path.basename(path.dirname(picked!)), 'output_logging_20260927T170000');
  assert.equal(path.basename(picked!), '1-Forgejo Toolkit.log');
  assert.deepEqual(
    listWindowDirs(fixture.sessionDir).map((entry) => entry.name),
    ['window3', 'window4'],
  );
});

test('a window with only an exthost log has no extension channel yet', () => {
  const sessionDir = path.join(tempDir('ui-review-nolog-'), '20260927T164507');
  fs.mkdirSync(path.join(sessionDir, 'window1', 'exthost'), { recursive: true });
  fs.writeFileSync(exthostLogPath(path.join(sessionDir, 'window1')), 'nothing here\n');
  assert.equal(extensionOutputLog(path.join(sessionDir, 'window1')), null);
  assert.equal(exthostLogPids(path.join(sessionDir, 'window1')).length, 0);
});

test('presets pick the files the smoke scenario reads', () => {
  const fixture = makeFixture();
  const extension = logFilesFor(fixture.window2, 'extension');
  assert.equal(extension.length, 1);
  assert.match(extension[0], /Forgejo Toolkit\.log$/);
  assert.deepEqual(logFilesFor(fixture.window2, 'exthost'), [exthostLogPath(fixture.window2)]);

  const mcpLog = path.join(fixture.window2, 'mcpServer.mcp.config.usrlocal.forgejo.log');
  fs.writeFileSync(mcpLog, '[info] forwarding to the extension-host broker\n');
  fs.writeFileSync(path.join(fixture.window2, 'network.log'), 'noise\n');
  assert.deepEqual(logFilesFor(fixture.window2, 'mcp'), [mcpLog]);
  assert.ok(logFilesFor(fixture.window2, 'any').length >= 4);
});

test('grep is case-insensitive by default, /re/ patterns are honoured, and tail keeps the end', () => {
  const file = path.join(tempDir('ui-review-grep-'), 'window1.log');
  fs.writeFileSync(
    file,
    ['2026 [info] MCP broker: session opened for pid 44400', 'noise 1', 'noise 2', 'mcp broker: stepped down'].join(
      '\n',
    ),
  );
  const substring = grepFiles([file], { preset: 'any', grep: 'mcp broker' });
  assert.equal(substring.length, 2);
  assert.deepEqual(
    substring.map((match) => match.line),
    [1, 4],
  );

  const regex = grepFiles([file], { preset: 'any', grep: '/pid 4\\d{4}$/' });
  assert.equal(regex.length, 1);

  const tailed = grepFiles([file], { preset: 'any', grep: 'noise', tail: 1 });
  assert.deepEqual(
    tailed.map((match) => match.line),
    [3],
  );

  // Without --grep every non-blank line counts, so `dual logs all` is a dump.
  assert.equal(grepFiles([file], { preset: 'any' }).length, 4);
  assert.ok(compilePattern('/a/i').test('A'));
  assert.ok(compilePattern('/pid \\d+/').test('pid 44400'), '/regex/ is a regex');
  assert.ok(compilePattern('a.b').test('a.b'));
  assert.ok(!compilePattern('a.b').test('axb'), 'anything not wrapped in slashes is a plain substring');
});

test('selectWindowDirs picks one window, and refuses a session with too few of them', () => {
  const fixture = makeFixture();
  // Without recorded pids the fallback is VS Code's numbering: the two lowest
  // directories, lower number first.
  assert.deepEqual(
    selectWindowDirs(fixture.sessionDir, 'window1').map((entry) => entry.name),
    ['window3'],
  );
  assert.deepEqual(
    selectWindowDirs(
      fixture.sessionDir,
      'window2',
      new Map([
        ['window1', 44400],
        ['window2', 52888],
      ]),
    ).map((entry) => entry.name),
    ['window4'],
  );
  assert.equal(selectWindowDirs(fixture.sessionDir, 'all').length, 2);

  // A session with one window cannot answer for window2 — but window1 still
  // resolves, because `all` and a single-window session are legitimate states.
  const singleRoot = tempDir('ui-review-single-');
  const single = path.join(singleRoot, '20260927T164507');
  writeWindow(single, 'window1', { exthostPid: 44400, channel: ['[info] only one'] });
  assert.throws(() => selectWindowDirs(single, 'window2'), /could not attribute a log directory to window2/);
  assert.deepEqual(
    selectWindowDirs(single, 'window1').map((entry) => entry.name),
    ['window1'],
  );
});

test('window directories are attributed by recorded pid, else by VS Code numbering', () => {
  const fixture = makeFixture();
  // Recorded pids decide, whatever the directory names are.
  const byPid = attributeWindowDirs(
    fixture.sessionDir,
    new Map([
      ['window1', 52888],
      ['window2', 44400],
    ]),
  );
  assert.equal(byPid.window1.name, 'window4');
  assert.equal(byPid.window2.name, 'window3');

  // Without recorded pids the two lowest-numbered directories are used in order.
  const byNumber = attributeWindowDirs(fixture.sessionDir);
  assert.equal(byNumber.window1.name, 'window3');
  assert.equal(byNumber.window2.name, 'window4');

  // A recorded pid that no directory mentions is a hard error, not a fallback.
  assert.throws(
    () =>
      attributeWindowDirs(
        fixture.sessionDir,
        new Map([
          ['window1', 44400],
          ['window2', 99999],
        ]),
      ),
    /could not attribute a log directory to window2 \(recorded exthost pid 99999\)/,
  );
});

test('a window directory that reloaded reports every exthost pid it ever had', () => {
  const fixture = makeFixture();
  const logFile = exthostLogPath(fixture.window2);
  fs.appendFileSync(
    logFile,
    [
      '2026-09-27 19:20:00.000 [info] Extension host terminating: received terminate message from renderer',
      '2026-09-27 19:20:00.100 [info] Extension host with pid 70001 exiting with code 0',
      '2026-09-27 19:20:03.000 [info] Extension host with pid 70002 started',
    ].join('\n'),
  );
  const facts = windowLogDirFacts(fixture.sessionDir);
  const window4 = facts.find((entry) => entry.dir.name === 'window4');
  assert.deepEqual(window4?.exthostPids, [52888, 70002]);
});
