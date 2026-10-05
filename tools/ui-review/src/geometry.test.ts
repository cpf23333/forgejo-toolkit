// The coordinate contract of the pointer commands.
//
// Measured 2026-10-05 in the isolated dev host: the settings page's `AI 端点`
// section sat at inner y≈1460 of a **794-high sidebar webview frame**, so a
// coordinate taken from that element resolved to y≈1528 of a 900-high page. CDP
// accepted it, nothing was clicked, and the command still exited 0. In the same
// session two webview frames were open at once — the sidebar view (49,68) 233x794
// and an editor-area panel (289,69) 425x502 — and
// `document.querySelector('iframe.webview')` silently answers with the first, which
// is how an earlier run read a "3× mismatch" out of comparing two different frames.
//
// These tests pin the invariant that replaced both silences: **a coordinate the
// harness accepts is one the browser will deliver to the element it was read for,
// or the command refuses with the measured numbers.**
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PIXEL_UNITS_VERSION,
  parsePngSize,
  pixelUnitsPath,
  placeCoordinate,
  pointerGeometryGuard,
  readPixelUnits,
  refreshPixelUnits,
  screenshotSize,
  writePixelUnits,
  type PixelReport,
  type PixelUnitsState,
  type WebviewFrame,
} from './driver';

function tempHarness(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-geometry-'));
}

/** A capture header as the browser writes it: PNG signature plus an IHDR size. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** The two frames the dev host had open: the sidebar settings view and an editor panel. */
const SIDEBAR: WebviewFrame = {
  webviewId: 'ad61c2c5-042b-4e60-a8de-81ab6c66becb',
  where: 'sidebar',
  rect: { x: 49, y: 68, width: 233, height: 794 },
};
const EDITOR: WebviewFrame = {
  webviewId: '0ae05038-7600-4a3a-b636-002767465272',
  where: 'editor',
  rect: { x: 289, y: 69, width: 425, height: 502 },
};

const PAGE: PixelReport = { scale: 1, viewport: { width: 1440, height: 900 } };

/** The reading a `shot` at 1440x900 with `frames` open would have written. */
function capture(frames: WebviewFrame[], overrides: Partial<PixelUnitsState> = {}): PixelUnitsState {
  return {
    version: PIXEL_UNITS_VERSION,
    scale: 1,
    viewport: { width: 1440, height: 900 },
    image: { width: 1440, height: 900 },
    imageScale: 1,
    frames,
    shot: 'ai-section',
    at: '2026-10-05T12:30:00.000Z',
    url: 'vscode-file://…/workbench.html',
    ...overrides,
  };
}

/** The measured "Test connection" coordinate inside the sidebar frame. */
const TEST_CONNECTION = { x: 110, y: 381 };

test('a capture reports its own pixel size, and nothing else does', () => {
  assert.deepEqual(parsePngSize(pngHeader(1440, 900)), { width: 1440, height: 900 });
  assert.deepEqual(parsePngSize(pngHeader(4320, 2700)), { width: 4320, height: 2700 }, 'a 3x capture says 3x');
  assert.equal(parsePngSize(Buffer.alloc(4)), null, 'too short to hold an IHDR');
  assert.equal(parsePngSize(Buffer.from('not a png at all, but long enough to read')), null);
  const wrongChunk = pngHeader(10, 10);
  wrongChunk.write('JUNK', 12, 'latin1');
  assert.equal(parsePngSize(wrongChunk), null, 'a missing IHDR is not a size');
  const dir = tempHarness();
  fs.writeFileSync(path.join(dir, 'shot.png'), pngHeader(233, 794));
  assert.deepEqual(screenshotSize(path.join(dir, 'shot.png')), { width: 233, height: 794 });
  assert.equal(screenshotSize(path.join(dir, 'missing.png')), null);
});

test('a coordinate is placed in the frame that contains it, or on the chrome', () => {
  const inSidebar = placeCoordinate(TEST_CONNECTION, [SIDEBAR, EDITOR]);
  assert.equal(inSidebar.kind, 'webview');
  assert.deepEqual(inSidebar.frame, SIDEBAR);
  assert.match(inSidebar.note, /inside the sidebar webview \(49,68\) 233x794, webview ad61c2c5/);
  assert.deepEqual(placeCoordinate({ x: 300, y: 200 }, [SIDEBAR, EDITOR]).frame, EDITOR);
  // 1000,600 is the editor area's own chrome beside the panel: no frame is there.
  assert.equal(placeCoordinate({ x: 1000, y: 600 }, [SIDEBAR, EDITOR]).kind, 'chrome');
  assert.match(placeCoordinate({ x: 1000, y: 600 }, []).note, /over workbench chrome/);
});

test('a coordinate inside the recorded frame passes, and the note names the frame', () => {
  const note = pointerGeometryGuard({
    command: 'click',
    point: TEST_CONNECTION,
    recorded: capture([SIDEBAR, EDITOR]),
    current: PAGE,
    liveFrames: [SIDEBAR, EDITOR],
  });
  assert.match(note, /^click: \(110, 381\) is inside the sidebar webview \(49,68\) 233x794/);
});

test('a coordinate outside the viewport refuses instead of clicking nothing', () => {
  // The measured case: the AI section scrolled out of a 794-high frame.
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: { x: 110, y: 1527 },
        recorded: capture([SIDEBAR]),
        current: PAGE,
        liveFrames: [SIDEBAR],
      }),
    (error: Error) => {
      assert.match(error.message, /click: \(110, 1527\) is outside the page's CSS viewport 1440x900/);
      assert.match(error.message, /the command would exit 0 having clicked nothing/);
      assert.match(error.message, /ui scroll/);
      assert.match(error.message, /Nothing was clicked\./);
      return true;
    },
  );
});

test('a non-numeric coordinate refuses instead of forwarding NaN', () => {
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: { x: Number('abc'), y: 10 },
        recorded: null,
        current: PAGE,
        liveFrames: [],
      }),
    /click: \(NaN, 10\) is not a coordinate/,
  );
});

test('a capture that is not one image pixel per CSS pixel refuses, with both scales', () => {
  // The 3x reading: a capture of 4320x2700 image px for a 1440x900 CSS viewport
  // while the page reports devicePixelRatio 1. Every coordinate read off it would
  // land three times too far into the page.
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: TEST_CONNECTION,
        recorded: capture([SIDEBAR], { image: { width: 4320, height: 2700 }, imageScale: 3 }),
        current: PAGE,
        liveFrames: [SIDEBAR],
      }),
    (error: Error) => {
      assert.match(error.message, /the last capture \(ai-section\) is 4320x2700 image px for a 1440x900 CSS viewport/);
      assert.match(error.message, /i\.e\. 3\.00 image px per CSS px/);
      assert.match(error.message, /the page reports 1 device px per CSS px now/);
      assert.match(error.message, /Take a fresh screenshot \(viewport 1440x900\)/);
      assert.match(error.message, /Nothing was clicked\./);
      return true;
    },
  );
  // A capture that agrees with the page is not a refusal, whatever the ratio is.
  assert.match(
    pointerGeometryGuard({
      command: 'click',
      point: TEST_CONNECTION,
      recorded: capture([SIDEBAR], {
        scale: 1.5,
        image: { width: 2160, height: 1350 },
        imageScale: 1.5,
      }),
      current: { scale: 1.5, viewport: { width: 1440, height: 900 } },
      liveFrames: [SIDEBAR],
    }),
    /is inside the sidebar webview/,
  );
});

test('a window resized since the capture refuses, naming both sizes', () => {
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: TEST_CONNECTION,
        recorded: capture([SIDEBAR]),
        current: { scale: 1, viewport: { width: 1200, height: 800 } },
        liveFrames: [SIDEBAR],
      }),
    (error: Error) => {
      assert.match(
        error.message,
        /the page is 1200x800 now, but the last capture \(ai-section\) was taken at 1440x900/,
      );
      assert.match(error.message, /Nothing was clicked\./);
      return true;
    },
  );
});

test('a frame that moved or closed since the capture refuses, naming both rects', () => {
  const moved: WebviewFrame = { ...SIDEBAR, rect: { x: 49, y: 68, width: 233, height: 400 } };
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: TEST_CONNECTION,
        recorded: capture([SIDEBAR]),
        current: PAGE,
        liveFrames: [moved],
      }),
    (error: Error) => {
      assert.match(
        error.message,
        /was inside the sidebar webview \(49,68\) 233x794 when the last capture \(ai-section\) was taken/,
      );
      assert.match(error.message, /the frame there now is the sidebar webview \(49,68\) 233x400/);
      assert.match(error.message, /Nothing was clicked\./);
      return true;
    },
  );
  // Closed, with nothing in its place: the coordinate is over the chrome now.
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: TEST_CONNECTION,
        recorded: capture([SIDEBAR]),
        current: PAGE,
        liveFrames: [],
      }),
    /and no webview frame contains it now/,
  );
  // A different frame took the space: same refusal, and it says which frame.
  const replacement: WebviewFrame = { ...EDITOR, rect: SIDEBAR.rect };
  assert.throws(
    () =>
      pointerGeometryGuard({
        command: 'click',
        point: TEST_CONNECTION,
        recorded: capture([SIDEBAR]),
        current: PAGE,
        liveFrames: [replacement],
      }),
    /the frame there now is the editor webview \(49,68\) 233x794, webview 0ae05038/,
  );
});

test('a coordinate over the workbench chrome still passes', () => {
  const note = pointerGeometryGuard({
    command: 'click',
    point: { x: 1000, y: 600 },
    recorded: capture([SIDEBAR, EDITOR]),
    current: PAGE,
    liveFrames: [SIDEBAR, EDITOR],
  });
  assert.match(note, /click: \(1000, 600\) is over workbench chrome/);
  // No record at all (the first command of a session) is not a refusal either.
  assert.match(
    pointerGeometryGuard({ command: 'hover', point: { x: 10, y: 10 }, recorded: null, current: PAGE, liveFrames: [] }),
    /is over workbench chrome/,
  );
});

test('only a capture replaces the recorded capture geometry', () => {
  const harnessDir = tempHarness();
  writePixelUnits(harnessDir, PAGE, 'about:blank', {
    image: { width: 1440, height: 900 },
    imageScale: 1,
    frames: [SIDEBAR],
    shot: 'ai-section',
  });
  assert.deepEqual(readPixelUnits(harnessDir)?.frames, [SIDEBAR]);
  // A command that is not a capture refreshes the scale — the next click compares
  // against what this one saw — but keeps the capture the coordinates come from.
  const refreshed = refreshPixelUnits(
    harnessDir,
    { scale: 1.5, viewport: { width: 1440, height: 900 } },
    'about:blank',
  );
  assert.equal(refreshed.scale, 1.5);
  assert.equal(refreshed.shot, 'ai-section');
  assert.deepEqual(refreshed.image, { width: 1440, height: 900 });
  assert.equal(refreshed.imageScale, 1);
  assert.deepEqual(refreshed.frames, [SIDEBAR]);
  assert.deepEqual(refreshed.viewport, { width: 1440, height: 900 }, 'the capture viewport is not overwritten');
  // A record written before the frames existed is unknown, not a reading.
  fs.writeFileSync(
    pixelUnitsPath(harnessDir),
    JSON.stringify({ version: 1, scale: 1, viewport: { width: 1440, height: 900 } }),
  );
  assert.equal(readPixelUnits(harnessDir), null);
});
