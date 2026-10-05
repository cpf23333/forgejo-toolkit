// The coordinate-scale record that keeps a click on the pixel it was measured on.
//
// Measured 2026-10-05: the dev host's `devicePixelRatio` went 1 → 1.5 mid-session.
// Coordinates read off an earlier screenshot are CSS coordinates at scale 1, so at
// 1.5 the same numbers landed elsewhere, every click missed, and the run spent
// real time reading screenshots that could not have worked. These tests pin the
// record and the refusal that replaced that silence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PIXEL_UNITS_FILE,
  PIXEL_UNITS_VERSION,
  pixelUnitsPath,
  pointerScaleGuard,
  readPixelUnits,
  writePixelUnits,
  type PixelReport,
} from './driver';

function tempHarness(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-pixels-'));
}

function report(scale: number): PixelReport {
  return { scale, viewport: { width: 1440, height: 900 } };
}

test('the reading round-trips through the state file', () => {
  const harnessDir = tempHarness();
  assert.equal(readPixelUnits(harnessDir), null, 'no record yet');
  const written = writePixelUnits(harnessDir, report(1.5), 'vscode-file://…/workbench.html');
  assert.equal(written.version, PIXEL_UNITS_VERSION);
  assert.equal(fs.existsSync(pixelUnitsPath(harnessDir)), true);
  assert.equal(path.basename(pixelUnitsPath(harnessDir)), PIXEL_UNITS_FILE);
  const read = readPixelUnits(harnessDir);
  assert.equal(read?.scale, 1.5);
  assert.deepEqual(read?.viewport, { width: 1440, height: 900 });
});

test('a missing, malformed or foreign record reads as "unknown", never as a scale', () => {
  const harnessDir = tempHarness();
  fs.writeFileSync(pixelUnitsPath(harnessDir), 'not json');
  assert.equal(readPixelUnits(harnessDir), null);
  fs.writeFileSync(pixelUnitsPath(harnessDir), JSON.stringify({ version: 99, scale: 2 }));
  assert.equal(readPixelUnits(harnessDir), null);
  fs.writeFileSync(pixelUnitsPath(harnessDir), JSON.stringify({ version: PIXEL_UNITS_VERSION, scale: 0 }));
  assert.equal(readPixelUnits(harnessDir), null);
});

test('an unchanged or unknown scale lets the pointer command through', () => {
  const harnessDir = tempHarness();
  // No record at all: the first command of a session has nothing to contradict.
  assert.equal(pointerScaleGuard(harnessDir, report(1), 'click'), null);
  writePixelUnits(harnessDir, report(1), 'about:blank');
  assert.equal(pointerScaleGuard(harnessDir, report(1), 'click')?.scale, 1);
});

test('a moved scale refuses the command and says what to do instead', () => {
  const harnessDir = tempHarness();
  writePixelUnits(harnessDir, report(1), 'about:blank');
  assert.throws(
    () => pointerScaleGuard(harnessDir, report(1.5), 'click'),
    (error: Error) => {
      assert.match(error.message, /click: the page's pixel scale changed from 1 to 1\.5/);
      assert.match(error.message, /Take a fresh screenshot \(viewport 1440x900\)/);
      assert.match(error.message, /Nothing was clicked\./);
      return true;
    },
  );
  // The record is left alone: the refusal is not the new reading, so the next
  // command reports the same mismatch rather than forgetting it.
  assert.equal(readPixelUnits(harnessDir)?.scale, 1);
});
