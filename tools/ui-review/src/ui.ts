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
//
// Coordinates are relative to the last CDP screenshot (viewport size, e.g.
// 1440x900). Every command ends with a screenshot saved under shots/.
import { connect, shot, waitWorkbench } from './driver';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: ui.ts <shot|click|scroll|drag|hover|type|key> ...');
  process.exit(1);
}

const { browser, page } = await connect();
await waitWorkbench(page, 1000);

let name = cmd;
switch (cmd) {
  case 'shot':
    name = args[0] || 'shot';
    break;
  case 'click': {
    const [x, y, n, waitMs] = args;
    await page.mouse.click(Number(x), Number(y));
    await page.waitForTimeout(Number(waitMs || 2000));
    name = n || name;
    break;
  }
  case 'rclick': {
    const [x, y, n] = args;
    await page.mouse.click(Number(x), Number(y), { button: 'right' });
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'scroll': {
    const [x, y, dy, n] = args;
    await page.mouse.move(Number(x), Number(y));
    await page.mouse.wheel(0, Number(dy));
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  case 'drag': {
    const [x1, y1, x2, y2, n] = args;
    await page.mouse.move(Number(x1), Number(y1));
    await page.mouse.down();
    await page.mouse.move(Number(x2), Number(y2), { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    name = n || name;
    break;
  }
  case 'hover': {
    const [x, y, n] = args;
    await page.mouse.move(Number(x), Number(y));
    await page.waitForTimeout(800);
    name = n || name;
    break;
  }
  case 'type': {
    const [text, n] = args;
    await page.keyboard.type(text, { delay: 20 });
    await page.waitForTimeout(600);
    name = n || name;
    break;
  }
  case 'key': {
    const [key, n] = args;
    await page.keyboard.press(key);
    await page.waitForTimeout(1200);
    name = n || name;
    break;
  }
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}

await shot(page, name);
await browser.close();
