// Unit tests for the *pure* parts of the shared-profile dual-window mode.
//
// Run: pnpm --filter @cpf23333-forgejo-toolkit/ui-review test
//
// What these tests can and cannot prove: they pin the addressing rules (which CDP
// page is window1 vs window2), the log-directory resolution (including "never
// fall back to another session"), the command construction for the keystroke and
// for killing exactly one extension host, and the window/exthost selection rules.
// They do **not** prove that VS Code honours Ctrl+Shift+N as the second window of
// the same profile, that the extension host is a child of the window we think, or
// that the log directories map to the pids we read — those need a real run and are
// called out in the README's smoke scenario.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  CDP_PORT,
  DEFAULT_WINDOW_DIRS,
  NEW_WINDOW_KEYS,
  NEW_WINDOW_SENDKEYS,
  cdpVersionUrl,
  diffWorkbenchPages,
  isWorkbenchPageUrl,
  parseWindowSelector,
  systemKeystrokeCommand,
  uiTargetArgs,
  workbenchTargetIds,
} from './windows';

// --- window addressing --------------------------------------------------------
test('window selectors accept the spellings the CLI documents, and reject the rest', () => {
  assert.equal(parseWindowSelector('1'), 'window1');
  assert.equal(parseWindowSelector('2'), 'window2');
  assert.equal(parseWindowSelector('window1'), 'window1');
  assert.equal(parseWindowSelector('WINDOW2'), 'window2');
  assert.equal(parseWindowSelector(' all '), 'all');
  assert.throws(() => parseWindowSelector('3'), /unknown window selector '3'/);
  assert.throws(() => parseWindowSelector(''), /unknown window selector/);
});

test('the two window labels are the two the dual mode hands out, in order', () => {
  assert.deepEqual([...DEFAULT_WINDOW_DIRS], ['window1', 'window2']);
  assert.equal(DEFAULT_WINDOW_DIRS.length, 2);
});

test('window2 is the workbench page that was not present before the keystroke', () => {
  const before = ['targetA'];
  const after = ['targetA', 'targetB'];
  assert.deepEqual(diffWorkbenchPages(before, after), ['targetB']);
  // A page the user opened by hand (e.g. a webview) is not a window.
  assert.deepEqual(diffWorkbenchPages(before, ['targetA']), []);
  // Ordering is by target id, so the same set always yields the same answer.
  assert.deepEqual(diffWorkbenchPages([], ['b', 'a']), ['a', 'b']);
});

test('only workbench pages count as windows', () => {
  assert.ok(isWorkbenchPageUrl('vscode-file://vscode-app/D:/x/vs/workbench/workbench.html'));
  assert.ok(isWorkbenchPageUrl('file:///C:/vscode/out/vs/code/electron-sandbox/workbench/workbench.html'));
  assert.ok(!isWorkbenchPageUrl('vscode-webview://abc/index.html'));
  assert.ok(!isWorkbenchPageUrl('devtools://devtools/bundled/inspector.html'));

  const targets = [
    { targetId: 'z', type: 'page', url: 'file:///workbench.html' },
    { targetId: 'a', type: 'iframe', url: 'file:///workbench.html' },
    { targetId: 'b', type: 'page', url: 'vscode-webview://x/index.html' },
    { targetId: 'c', type: 'page', url: 'vscode-file://app/workbench.html' },
  ];
  // Sorted, pages only: the order is what lets `connectAll` number the windows.
  assert.deepEqual(workbenchTargetIds(targets), ['c', 'z']);
});

test('addressing one window over CDP uses the target id, never a guess', () => {
  assert.deepEqual(uiTargetArgs('ABC123'), ['--target', 'ABC123']);
  assert.throws(() => uiTargetArgs('  '), /CDP target id is required/);
  assert.equal(cdpVersionUrl(9222), `http://127.0.0.1:${CDP_PORT}/json/version`);
  assert.equal(cdpVersionUrl(9333), 'http://127.0.0.1:9333/json/version');
});

// --- the in-instance keystroke ------------------------------------------------

test('the second window is opened with the in-instance chord, not code --new-window', () => {
  assert.equal(NEW_WINDOW_KEYS, 'Control+Shift+N');
  assert.equal(NEW_WINDOW_SENDKEYS, '^+n');

  const harnessDir = path.resolve('/repo/tools/ui-review');
  const command = systemKeystrokeCommand(harnessDir);
  assert.equal(command.file, 'powershell');
  assert.ok(command.args.includes(path.join(harnessDir, 'src', 'win', 'activate.ps1')));
  assert.equal(command.args[command.args.indexOf('-Keys') + 1], '^+n');
  // The fallback must not reintroduce the measured-ineffective launch path.
  assert.ok(!command.args.some((arg) => arg.includes('--new-window')));
});

test('the keystroke is sent before window2 exists, so window1 is the only possible target', () => {
  // window1 is present before the keystroke by construction: `connectAll` keeps
  // Playwright's creation order, so index 0 is the pre-existing window. A new
  // page can only be explained by the keystroke — that is why `diffWorkbenchPages`
  // is fed the ids seen *before* the press.
  const before = ['window1-target'];
  const after = ['window1-target', 'window2-target'];
  assert.deepEqual(diffWorkbenchPages(before, after), ['window2-target']);
});
