// Unit tests for the dual-window session state file — in particular the rule that
// makes `--window <n>` mean a specific window instead of "whichever page this
// connection listed nth" (measured: Playwright's page order varies between calls).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  clearState,
  readState,
  recordedTargetFor,
  requireState,
  stateFilePath,
  writeState,
  type DualWindowState,
} from './state';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-state-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function sampleState(): DualWindowState {
  return {
    version: 1,
    launchedAt: '2026-09-27T19:30:19.000Z',
    logSession: '20260927T193019',
    profileDir: 'D:\\code\\forgejo-toolkit\\tools\\ui-review\\profile',
    cdpPort: 9222,
    workspace: 'D:\\code\\forgejo-toolkit',
    targets: { window1: 'AAAA1111', window2: 'BBBB2222' },
    exthosts: { window1: 47504, window2: 19904 },
    windowDirs: { window1: 'window1', window2: 'window2' },
    secondWindowOpenedBy: 'keystroke',
    launched: true,
    failedAt: null,
    failure: null,
  };
}

test('a written state round-trips, including a failed launch', () => {
  const harnessDir = tempDir();
  writeState(harnessDir, sampleState());
  assert.equal(stateFilePath(harnessDir), path.join(harnessDir, 'dual-window.json'));
  const read = requireState(harnessDir);
  assert.equal(read.targets.window2, 'BBBB2222');
  assert.equal(read.launched, true);

  // A failed launch (the state file is written as soon as window1 exists, before
  // the keystroke) keeps window1 recorded and marks the failure.
  const failed: DualWindowState = {
    ...sampleState(),
    targets: { window1: 'AAAA1111' },
    exthosts: {},
    windowDirs: {},
    launched: false,
    failedAt: '2026-09-27T19:31:00.000Z',
    failure: 'timed out after 20000 ms waiting for a second workbench window',
  };
  writeState(harnessDir, failed);
  const reRead = requireState(harnessDir);
  assert.equal(reRead.launched, false);
  assert.equal(reRead.targets.window1, 'AAAA1111');
  assert.equal(reRead.targets.window2, undefined);
  assert.match(reRead.failure ?? '', /timed out/);
});

test('--window n resolves through the recorded id, never through page order', () => {
  const harnessDir = tempDir();
  assert.equal(recordedTargetFor(harnessDir, 1), null, 'no session: nothing to resolve');
  writeState(harnessDir, sampleState());
  assert.equal(recordedTargetFor(harnessDir, 1), 'AAAA1111');
  assert.equal(recordedTargetFor(harnessDir, 2), 'BBBB2222');
  // window3 is not part of a dual session, and nonsense is refused rather than
  // silently reading window1's id.
  assert.equal(recordedTargetFor(harnessDir, 3), null);
  assert.equal(recordedTargetFor(harnessDir, 0), null);
  assert.equal(recordedTargetFor(harnessDir, -1), null);
  assert.equal(recordedTargetFor(harnessDir, 1.5), null);
});

test('a cleared or unreadable state is reported, not guessed', () => {
  const harnessDir = tempDir();
  writeState(harnessDir, sampleState());
  assert.equal(clearState(harnessDir), true);
  assert.equal(clearState(harnessDir), false);
  assert.equal(readState(harnessDir), null);
  assert.throws(() => requireState(harnessDir), /no dual-window\.json/);

  // A file from a future version is refused instead of half-read.
  const other = tempDir();
  fs.writeFileSync(stateFilePath(other), JSON.stringify({ ...sampleState(), version: 99 }));
  assert.throws(() => readState(other), /has version 99, expected 1/);
});
