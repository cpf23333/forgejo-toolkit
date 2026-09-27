// Unified interaction CLI for the dev-host workbench.
//
//   node src/ui.ts shot <name>
//   node src/ui.ts click <x> <y> [name] [waitMs]
//   node src/ui.ts rclick <x> <y> [name]         (right click)
//   node src/ui.ts scroll <x> <y> <deltaY> [name]
//   node src/ui.ts drag <x1> <y1> <x2> <y2> [name]
//   node src/ui.ts hover <x> <y> [name]          (moves the mouse without clicking)
//   node src/ui.ts type <text> [name]          (types into the focused element)
//   node src/ui.ts key <key> [name]            (e.g. Escape, Enter, Tab)
//   node src/ui.ts eval <js>                   (evaluates in the workbench page, prints the result)
//
// Coordinates are relative to the last CDP screenshot (viewport size, e.g.
// 1440x900). Every command ends with a screenshot saved under shots/.
//
// With two windows open (the dual-window mode) one has to be named:
//   node src/ui.ts --window 2 shot w2-home
//   node src/ui.ts --target <cdpTargetId> shot w2-home   (ids: src/dual.ts targets)
// `--window 2` resolves through the id `dual launch` recorded for window2, so it
// means the same window on every call; with no dual session it falls back to
// position. Without either flag the first window (window1) is used, which is also
// what a single-window dev host has always been.
import path from 'node:path';
import { connectOne, shot, waitWorkbench } from './driver';
import { recordedTargetFor } from './state';
import { parseWindowSelector } from './windows';

const argv = process.argv.slice(2);

let target: string | undefined;
let windowIndex = 1;
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
  console.error('usage: ui.ts [--window N | --target ID] <shot|click|scroll|drag|hover|type|key|eval> ...');
  process.exit(1);
}

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const { browser, page } = await connectOne({
  target,
  window: windowIndex,
  recordedTarget: recordedTargetFor(HARNESS_DIR, windowIndex),
});
await waitWorkbench(page, 1000);

let name = cmd;
switch (cmd) {
  case 'shot':
    name = rest[0] || 'shot';
    break;
  case 'click': {
    const [x, y, n, waitMs] = rest;
    await page.mouse.click(Number(x), Number(y));
    await page.waitForTimeout(Number(waitMs || 2000));
    name = n || name;
    break;
  }
  case 'rclick': {
    const [x, y, n] = rest;
    await page.mouse.click(Number(x), Number(y), { button: 'right' });
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'scroll': {
    const [x, y, dy, n] = rest;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.wheel(0, Number(dy));
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'drag': {
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
    const [x, y, n] = rest;
    await page.mouse.move(Number(x), Number(y));
    await page.waitForTimeout(800);
    name = n || name;
    break;
  }
  case 'type': {
    const [text, n] = rest;
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForTimeout(600);
    name = n || name;
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
    const [script, n] = rest;
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

await shot(page, name);
await browser.close();
