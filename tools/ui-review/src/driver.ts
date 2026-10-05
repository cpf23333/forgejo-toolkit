// Shared CDP driver helpers for UI review sessions.
//
// A dev host can have several windows open (see the dual-window mode in
// windows.ts), and `connectOverCDP` reaches the whole instance, so "the first
// workbench page" stopped being a safe answer. `connectAll` lists every workbench
// page in creation order — window1 first, window2 second — and `connect` keeps the
// old single-page shape for the existing CLI.
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { cdpTargetsUrl, isWorkbenchPageUrl, WINDOW_LABELS, type WindowLabel } from './windows';

export const PORT = Number(process.env.CDP_PORT || 9222);
export const DIRS = {
  root: path.resolve(import.meta.dirname, '..'),
  shots: path.resolve(import.meta.dirname, '..', 'shots'),
};
fs.mkdirSync(DIRS.shots, { recursive: true });

/**
 * Where the page's pixel scale is remembered between `ui` invocations.
 *
 * Every `ui` call is its own CDP connection, so nothing in memory can notice that
 * `devicePixelRatio` changed since the screenshot the coordinates were read off.
 * This file is that memory: the pointer commands refuse to click when the scale
 * moved, because CDP input is in CSS pixels while a screenshot is in device
 * pixels — the two agree only while the ratio holds.
 */
export const PIXEL_UNITS_FILE = 'pixel-units.json';
export const PIXEL_UNITS_VERSION = 1;

/** What the workbench page reports about its own pixel geometry. */
export interface PixelReport {
  /** `window.devicePixelRatio` at the moment of the reading. */
  scale: number;
  /** CSS-pixel viewport, i.e. the coordinate space CDP input uses. */
  viewport: { width: number; height: number };
}

/** The remembered scale, or `null` when there is no usable record. */
export interface PixelUnitsState {
  version: number;
  scale: number;
  viewport: { width: number; height: number };
  /** ISO timestamp of the last reading, and the page it came from. */
  at: string;
  url: string;
}

export function pixelUnitsPath(harnessDir: string): string {
  return path.join(harnessDir, PIXEL_UNITS_FILE);
}

/** The recorded scale, or `null` when the file is missing or unusable. */
export function readPixelUnits(harnessDir: string): PixelUnitsState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pixelUnitsPath(harnessDir), 'utf8')) as PixelUnitsState;
    if (parsed?.version !== PIXEL_UNITS_VERSION) return null;
    if (typeof parsed.scale !== 'number' || !(parsed.scale > 0)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePixelUnits(harnessDir: string, report: PixelReport, url: string): PixelUnitsState {
  const state: PixelUnitsState = {
    version: PIXEL_UNITS_VERSION,
    scale: report.scale,
    viewport: report.viewport,
    at: new Date().toISOString(),
    url,
  };
  fs.writeFileSync(pixelUnitsPath(harnessDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** Reads the page's pixel geometry — the same reading the screenshot is taken in. */
export async function readPixelReport(page: Page): Promise<PixelReport> {
  // `window` is reached through `globalThis` on purpose: this package's tsconfig
  // has no DOM lib (the harness is a Node CLI), so a bare `window` is not a known
  // name here even though this function only ever runs inside the page.
  return page.evaluate((): PixelReport => {
    const win = globalThis as unknown as {
      devicePixelRatio: number;
      innerWidth: number;
      innerHeight: number;
    };
    return {
      scale: win.devicePixelRatio,
      viewport: { width: win.innerWidth, height: win.innerHeight },
    };
  });
}

/**
 * Refuses a pointer command when the scale moved since the last reading.
 *
 * Measured 2026-10-05: the dev host's `devicePixelRatio` went 1 → 1.5 mid-session.
 * Coordinates read off the earlier screenshot are CSS coordinates at scale 1; at
 * 1.5 the same numbers land elsewhere in the page, so every click missed and the
 * run went on for a while before anyone noticed the clicks were going nowhere.
 *
 * Refusing rather than rescaling on purpose: a screenshot is in device pixels, so
 * at a different scale the honest fix is to take a fresh `shot` and read the
 * coordinates off **that**, not to multiply numbers by a ratio (which would also
 * silently re-map a number the operator may have read off a stale capture).
 */
export function pointerScaleGuard(harnessDir: string, current: PixelReport, command: string): PixelUnitsState | null {
  const previous = readPixelUnits(harnessDir);
  if (previous === null || previous.scale === current.scale) return previous;
  throw new Error(
    `${command}: the page's pixel scale changed from ${previous.scale} to ${current.scale} since the last reading ` +
      `(${previous.at}).\n` +
      '  A screenshot is in device pixels and CDP input is in CSS pixels, so a coordinate read off the older ' +
      'capture no longer points at the same place and the click would miss.\n' +
      `  Take a fresh screenshot (viewport ${current.viewport.width}x${current.viewport.height}) and read the ` +
      'coordinates off that. Nothing was clicked.',
  );
}

export interface WindowPage {
  label: string;
  page: Page;
  url: string;
}

export async function connect(): Promise<{ browser: Browser; page: Page }> {
  const { browser, pages } = await connectAll();
  if (pages.length === 0) {
    throw new Error('No workbench page found. Pages: ' + (await allPageUrls(browser)).join(', '));
  }
  return { browser, page: pages[0].page };
}

/**
 * Every workbench page of the instance, in creation order. Labels are positional
 * (`window1`, `window2`, …) because VS Code exposes no stable window id; the
 * creation order is what makes them agree with the labels `dual.ts` reports.
 *
 * This order is Playwright's, and it **is** creation order — unlike `/json/list`,
 * which was measured returning the second window first. Use `pagesWithTargetIds`
 * when an id is needed, never the list order of `/json/list`.
 */
export async function connectAll(port: number = PORT): Promise<{ browser: Browser; pages: WindowPage[] }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => isWorkbenchPageUrl(page.url()))
    .map((page, index) => ({ label: WINDOW_LABELS[index] ?? `window${index + 1}`, page, url: page.url() }));
  return { browser, pages };
}

/**
 * `--target <cdpTargetId>` (from `dual targets`) pins one window by CDP target id,
 * which is the only addressing the CDP endpoint itself understands and the only
 * one that is stable: Playwright's page order can differ between two connections,
 * so a positional index is not enough on its own.
 *
 * `--window <n>` therefore means "the window `dual launch` called window<n>": the
 * target id recorded in `dual-window.json` is resolved first, and position is used
 * only when there is no session to ask (a bare `pnpm launch` host). `recordedTarget`
 * is how the caller passes that in without driver.ts importing the state file.
 */
export async function connectOne(options: {
  target?: string;
  window?: number;
  recordedTarget?: string | null;
}): Promise<{ browser: Browser; page: Page }> {
  const { browser, pages } = await connectAll();
  if (pages.length === 0) {
    throw new Error('No workbench page found. Pages: ' + (await allPageUrls(browser)).join(', '));
  }
  const wanted = options.target ?? options.recordedTarget ?? undefined;
  if (wanted) {
    const resolved = await pagesWithTargetIds(browser, pages);
    const match = resolved.find((entry) => entry.targetId === wanted);
    if (!match) {
      await browser.close();
      const known = resolved.map((entry) => entry.targetId ?? '(unknown)').join(', ');
      const why = options.target
        ? `no workbench page with CDP target id ${options.target}`
        : `window${options.window ?? 1} was recorded as target ${wanted}, which is not open any more`;
      throw new Error(`${why}; known ids: ${known || '(none)'} — run 'dual targets' to list them`);
    }
    return { browser, page: match.page };
  }
  const index = (options.window ?? 1) - 1;
  const chosen = pages[index];
  if (!chosen) {
    await browser.close();
    throw new Error(
      `window${index + 1} is not open (${pages.length} workbench page(s) found); ` +
        `run 'dual.ts launch' to open the dual-window session`,
    );
  }
  return { browser, page: chosen.page };
}

interface ResolvedPage {
  page: Page;
  targetId: string | null;
}

/**
 * Each workbench page's CDP target id, read from the page's own session
 * (`Target.getTargetInfo`) rather than inferred from list order.
 */
export async function pagesWithTargetIds(browser: Browser, pages: readonly WindowPage[]): Promise<ResolvedPage[]> {
  const context = browser.contexts()[0];
  const resolved: ResolvedPage[] = [];
  for (const entry of pages) {
    if (!context) {
      resolved.push({ page: entry.page, targetId: null });
      continue;
    }
    try {
      const session = await context.newCDPSession(entry.page);
      const info = (await session.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } };
      await session.detach();
      resolved.push({ page: entry.page, targetId: info.targetInfo?.targetId ?? null });
    } catch {
      resolved.push({ page: entry.page, targetId: null });
    }
  }
  return resolved;
}

export interface CdpTarget {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

/**
 * Normalise a `/json/list` payload.
 *
 * The HTTP endpoint (and the DevTools protocol it mirrors) spells the target id
 * `id`, while the protocol's own `Target.getTargets`/`Target.getTargetInfo` reply
 * spells it `targetId`. Reading only one of the two produced `undefined` for every
 * id, which made `dual targets` print `undefined` and `--target` unmatchable, so
 * both spellings are accepted here and everything downstream sees `targetId`.
 */
export function normalizeCdpTargets(payload: unknown): CdpTarget[] {
  if (!Array.isArray(payload)) return [];
  const targets: CdpTarget[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { id?: unknown; targetId?: unknown; type?: unknown; title?: unknown; url?: unknown };
    const targetId = typeof entry.targetId === 'string' && entry.targetId ? entry.targetId : entry.id;
    if (typeof targetId !== 'string' || !targetId) continue;
    targets.push({
      targetId,
      type: typeof entry.type === 'string' ? entry.type : '',
      title: typeof entry.title === 'string' ? entry.title : '',
      url: typeof entry.url === 'string' ? entry.url : '',
    });
  }
  return targets;
}

/** The raw target list from the dev host's CDP endpoint, normalised. */
export async function cdpTargets(port = PORT): Promise<CdpTarget[]> {
  const response = await fetch(cdpTargetsUrl(port));
  if (!response.ok) throw new Error(`CDP /json/list returned ${response.status}`);
  return normalizeCdpTargets(await response.json());
}

async function allPageUrls(browser: Browser): Promise<string[]> {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .map((page) => page.url());
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
export type { WindowLabel };
