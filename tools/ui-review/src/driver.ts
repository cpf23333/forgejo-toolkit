// Shared CDP driver helpers for UI review sessions.
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const PORT = Number(process.env.CDP_PORT || 9222);
export const DIRS = {
  root: path.resolve(import.meta.dirname, '..'),
  shots: path.resolve(import.meta.dirname, '..', 'shots'),
};
fs.mkdirSync(DIRS.shots, { recursive: true });

export async function connect(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  const workbench = pages.find((p) => p.url().includes('workbench.html'));
  if (!workbench) {
    throw new Error('No workbench page found. Pages: ' + pages.map((p) => p.url()).join(', '));
  }
  return { browser, page: workbench };
}

export async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(DIRS.shots, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
  return file;
}

// Wait until the workbench has finished its initial render.
export async function waitWorkbench(page: Page, ms = 8000): Promise<void> {
  await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await page.waitForTimeout(ms);
}

// NOTE: VS Code webviews are out-of-process iframes; their DOM is not reachable
// through CDP frames. Drive them with coordinate input (page.mouse / page.keyboard)
// and verify with screenshots. Native OS dialogs (showConfirm etc.) are not part
// of the renderer at all — use src/win/dialog.ps1 + system screenshots instead.
