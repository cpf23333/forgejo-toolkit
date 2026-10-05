// Unified interaction CLI for the dev-host workbench.
//
//   node src/ui.ts shot <name>
//   node src/ui.ts scale [name]                (reports devicePixelRatio and the viewport)
//   node src/ui.ts click <x> <y> [name] [waitMs]
//   node src/ui.ts rclick <x> <y> [name]         (right click)
//   node src/ui.ts scroll <x> <y> <deltaY> [name]
//   node src/ui.ts drag <x1> <y1> <x2> <y2> [name]
//   node src/ui.ts hover <x> <y> [name]          (moves the mouse without clicking)
//   node src/ui.ts type <text> [name]          (types into the focused element)
//   node src/ui.ts key <key> [name]            (e.g. Escape, Enter, Tab)
//   node src/ui.ts eval --script-file <path.js> [name]   (evaluates in the workbench page)
//   node src/ui.ts eval <js> [name]            (one already-quoted argument; see below)
//
// Coordinates are relative to the last CDP screenshot (viewport size, e.g.
// 1440x900). Every command ends with a screenshot saved under shots/.
//
// Two traps, both measured:
//
//   * **A script argument is at the shell's mercy.** This CLI is reached through
//     `pnpm run`, which hands the command line to a shell; quotes come back
//     stripped and `=>` was read as a redirect, which created stray files in the
//     repository root. `--script-file` is the form that cannot be mangled: write
//     the script to a file and pass the path (no metacharacters in it).
//   * **`devicePixelRatio` is not constant.** It changed 1 → 1.5 mid-session once,
//     after which coordinates read off an older screenshot landed somewhere else
//     and the clicks missed. Every pointer command checks the scale against the
//     last reading (driver.ts's PIXEL_UNITS_FILE) and refuses when it moved.
//
// With two windows open (the dual-window mode) one has to be named:
//   node src/ui.ts --window 2 shot w2-home
//   node src/ui.ts --target <cdpTargetId> shot w2-home   (ids: src/dual.ts targets)
// `--window 2` resolves through the id `dual launch` recorded for window2, so it
// means the same window on every call; with no dual session it falls back to
// position. Without either flag the first window (window1) is used, which is also
// what a single-window dev host has always been.
import fs from 'node:fs';
import path from 'node:path';
import {
  connectOne,
  pointerScaleGuard,
  readPixelReport,
  readPixelUnits,
  shot,
  waitWorkbench,
  writePixelUnits,
} from './driver';
import { recordedTargetFor } from './state';
import { parseWindowSelector } from './windows';

const argv = process.argv.slice(2);

let target: string | undefined;
let windowIndex = 1;
let scriptFile: string | undefined;
const args: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--target') {
    target = argv[index + 1];
    if (!target) {
      console.error('--target needs a CDP target id (see src/dual.ts targets)');
      process.exit(1);
    }
    index += 1;
    continue;
  }
  if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length);
    continue;
  }
  if (arg === '--window') {
    const raw = argv[index + 1];
    if (!raw) {
      console.error('--window needs a window selector (1, 2, window1, window2)');
      process.exit(1);
    }
    windowIndex = selectorToIndex(raw);
    index += 1;
    continue;
  }
  if (arg.startsWith('--window=')) {
    windowIndex = selectorToIndex(arg.slice('--window='.length));
    continue;
  }
  if (arg === '--script-file') {
    scriptFile = argv[index + 1];
    if (!scriptFile) {
      console.error(`--script-file needs a path (see "ui eval" below)`);
      process.exit(1);
    }
    index += 1;
    continue;
  }
  if (arg.startsWith('--script-file=')) {
    scriptFile = arg.slice('--script-file='.length);
    continue;
  }
  args.push(arg);
}

function selectorToIndex(raw: string): number {
  const selector = parseWindowSelector(raw);
  if (selector === 'all') {
    console.error("--window takes one window; 'all' is only meaningful for 'dual.ts logs'");
    process.exit(1);
  }
  return Number(selector.slice('window'.length));
}

const [cmd, ...rest] = args;
if (!cmd) {
  console.error(
    'usage: ui.ts [--window N | --target ID] <shot|click|scroll|drag|hover|type|key|eval> ...\n' +
      '       ui.ts eval --script-file <path.js> [name]',
  );
  process.exit(1);
}

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const { browser, page } = await connectOne({
  target,
  window: windowIndex,
  recordedTarget: recordedTargetFor(HARNESS_DIR, windowIndex),
});
await waitWorkbench(page, 1000);

// The pixel scale, read once per invocation (see driver.ts's PIXEL_UNITS_FILE):
// the pointer commands below compare it with the last reading and refuse when it
// moved, because a coordinate read off an older screenshot would land elsewhere.
const pixels = await readPixelReport(page);

/** Every command that puts a pointer at a coordinate goes through this first. */
function guardPointer(command: string): void {
  pointerScaleGuard(HARNESS_DIR, pixels, command);
}

let name = cmd;
switch (cmd) {
  case 'scale':
    // Reports the scale a screenshot and a click are currently expressed in, and
    // whether it still matches the last reading. The guard below is the automatic
    // half; this is the one an operator can ask for.
    console.log(
      JSON.stringify(
        {
          scale: pixels.scale,
          viewport: pixels.viewport,
          recordedScale: readPixelUnits(HARNESS_DIR)?.scale ?? null,
        },
        null,
        2,
      ),
    );
    name = rest[0] || 'scale';
    break;
  case 'shot':
    // A screenshot is the reading a coordinate comes from, so it also (re)sets
    // the recorded scale: after it, the coordinates match this capture by
    // construction.
    name = rest[0] || 'shot';
    break;
  case 'click': {
    guardPointer('click');
    const [x, y, n, waitMs] = rest;
    await page.mouse.click(Number(x), Number(y));
    await page.waitForTimeout(Number(waitMs || 2000));
    name = n || name;
    break;
  }
  case 'rclick': {
    guardPointer('rclick');
    const [x, y, n] = rest;
    await page.mouse.click(Number(x), Number(y), { button: 'right' });
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'scroll': {
    guardPointer('scroll');
    const [x, y, dy, n] = rest;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.wheel(0, Number(dy));
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'drag': {
    guardPointer('drag');
    const [x1, y1, x2, y2, n] = rest;
    await page.mouse.move(Number(x1), Number(y1));
    await page.mouse.down();
    await page.mouse.move(Number(x2), Number(y2), { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    name = n || name;
    break;
  }
  case 'hover': {
    guardPointer('hover');
    const [x, y, n] = rest;
    await page.mouse.move(Number(x), Number(y));
    await page.waitForTimeout(800);
    name = n || name;
    break;
  }
  case 'type': {
    // `type <text> [name]`: two positionals. A third token, or a missing text, means
    // the shell split an unquoted argument; typing the fragment and exiting 0 is how
    // a form ends up silently half-filled. Accepted spellings: one word, or
    // `"the whole text" name`.
    const [text, first, second] = rest;
    if (text === undefined || text === '' || second !== undefined) {
      console.error(
        `type: needs one text argument and optionally one screenshot name, got ${rest.length}:\n  ${rest.join(' | ')}\n` +
          'Quote a multi-word text as a single argument.',
      );
      process.exit(1);
    }
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForTimeout(600);
    name = first || name;
    break;
  }
  case 'key': {
    const [key, n] = rest;
    await page.keyboard.press(key);
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'eval': {
    // The script arrives as text, and the two ways of passing it are not equally
    // safe: `pnpm run` sends the command line through a shell, which strips quotes
    // and reads `=>` as a redirect — the measured accident created stray files in
    // the repository root. `--script-file` is the route that carries no shell
    // metacharacters at all.
    let script: string | undefined;
    if (scriptFile !== undefined) {
      const file = path.resolve(scriptFile);
      try {
        script = fs.readFileSync(file, 'utf8');
      } catch (error) {
        console.error(`eval: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    } else {
      if (rest.length === 0) {
        console.error(
          'eval: no script given.\n' +
            '  Use --script-file, which passes the script as a file path and is the only form a shell cannot mangle:\n' +
            '    ui eval --script-file shots\\eval.js\n' +
            '    (PowerShell: @\' …script… \'@ | Set-Content shots\\eval.js — the here-string keeps quotes and "=>" intact)',
        );
        process.exit(1);
      }
      if (rest.length > 1) {
        console.error(
          `eval: the script arrived as ${rest.length} arguments, so the shell split it:\n  ${rest.join(' ')}\n` +
            'Pass it with --script-file instead.',
        );
        process.exit(1);
      }
      script = rest[0];
    }
    if (script.trim() === '') {
      console.error('eval: the script is empty');
      process.exit(1);
    }
    const [n] = scriptFile !== undefined ? rest : rest.slice(1);
    // eslint-disable-next-line no-eval
    const result = await page.evaluate(script);
    console.log(JSON.stringify(result, null, 2));
    name = n || name;
    break;
  }
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}

// `scale` reports; it does not re-record, so what the operator sees is the same
// reading the guard compares against.
if (cmd !== 'scale') {
  writePixelUnits(HARNESS_DIR, cmd === 'shot' ? await readPixelReport(page) : pixels, page.url());
}
await shot(page, name);
await browser.close();
