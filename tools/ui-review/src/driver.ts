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
 * Where the page's pixel scale **and the last capture's geometry** are remembered
 * between `ui` invocations.
 *
 * Every `ui` call is its own CDP connection, so nothing in memory can notice that
 * `devicePixelRatio` changed since the screenshot the coordinates were read off.
 * This file is that memory: the pointer commands refuse to click when the scale
 * moved, because CDP input is in CSS pixels while a screenshot is in device
 * pixels — the two agree only while the ratio holds.
 *
 * Since 2026-10-05 it also remembers two more things about the capture the
 * coordinates are supposed to come from, because the scale alone was not enough
 * (see {@link pointerGeometryGuard}):
 *
 * - its **pixel size**, so a capture that came back at a different number of image
 *   pixels per CSS pixel than the page reports is caught instead of trusted;
 * - the **webview frames** that were on screen, because a webview is a separate
 *   frame with its own rect: with the sidebar view and an editor-area panel open at
 *   once, one coordinate belongs to one of them, and the frame it belonged to must
 *   still be there, unchanged, when the click runs.
 */
export const PIXEL_UNITS_FILE = 'pixel-units.json';
export const PIXEL_UNITS_VERSION = 2;

/** What the workbench page reports about its own pixel geometry. */
export interface PixelReport {
  /** `window.devicePixelRatio` at the moment of the reading. */
  scale: number;
  /** CSS-pixel viewport, i.e. the coordinate space CDP input uses. */
  viewport: { width: number; height: number };
}

/** A rectangle in the workbench page's CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One webview frame the page hosts, in the page's CSS pixels.
 *
 * Measured 2026-10-05 (VS Code 1.140 / Electron 43): a webview is an
 * `iframe.webview` inside a `div.webview-overlay-content` whose own rect equals the
 * iframe's, so the iframe's rect **is** the frame on screen. `webview` elements are
 * still matched for builds that render webviews that way instead.
 *
 * `webviewId` is the id out of the iframe's `src` (`…/index.html?id=<uuid>`), which
 * is what makes a frame nameable across `ui` invocations — position and DOM order
 * are not stable enough (the sidebar frame is simply the first one in the document).
 */
export interface WebviewFrame {
  webviewId: string | null;
  /** The workbench part the frame sits in: `sidebar`, `editor`, `panel`, … */
  where: string;
  rect: Rect;
}

/** The remembered reading: the page's scale plus the last capture's geometry. */
export interface PixelUnitsState {
  version: number;
  scale: number;
  viewport: { width: number; height: number };
  /**
   * The last capture's pixel size, and the image-pixels-per-CSS-pixel it worked out
   * to. Only `shot` writes these: a screenshot is what a coordinate is read off, so
   * a command that is not a capture must not replace it.
   */
  image?: { width: number; height: number };
  imageScale?: number;
  /** The webview frames the last capture could place a coordinate in. */
  frames?: WebviewFrame[];
  /** The name of the capture those coordinates are meant to come from. */
  shot?: string;
  /** ISO timestamp of the last reading, and the page it came from. */
  at: string;
  url: string;
}

/** The capture-specific half of a reading; absent for commands that are not `shot`. */
export interface CaptureGeometry {
  image?: { width: number; height: number };
  imageScale?: number;
  frames?: WebviewFrame[];
  shot?: string;
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

export function writePixelUnits(
  harnessDir: string,
  report: PixelReport,
  url: string,
  capture: CaptureGeometry = {},
): PixelUnitsState {
  const state: PixelUnitsState = {
    version: PIXEL_UNITS_VERSION,
    scale: report.scale,
    viewport: report.viewport,
    ...(capture.image === undefined ? {} : { image: capture.image }),
    ...(capture.imageScale === undefined ? {} : { imageScale: capture.imageScale }),
    ...(capture.frames === undefined ? {} : { frames: capture.frames }),
    ...(capture.shot === undefined ? {} : { shot: capture.shot }),
    at: new Date().toISOString(),
    url,
  };
  fs.writeFileSync(pixelUnitsPath(harnessDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/**
 * Re-records the reading after a command that is **not** a capture.
 *
 * The page's scale is refreshed — the next command compares against what this one
 * saw — while the capture's own geometry (`viewport`, `image`, `frames`, `shot`) is
 * carried over: it still describes the screenshot the operator is reading
 * coordinates off, and a resize between a capture and a click has to stay visible
 * as a mismatch rather than being overwritten by an unrelated command.
 */
export function refreshPixelUnits(harnessDir: string, report: PixelReport, url: string): PixelUnitsState {
  const previous = readPixelUnits(harnessDir);
  return writePixelUnits(harnessDir, { scale: report.scale, viewport: previous?.viewport ?? report.viewport }, url, {
    ...(previous?.image === undefined ? {} : { image: previous.image }),
    ...(previous?.imageScale === undefined ? {} : { imageScale: previous.imageScale }),
    ...(previous?.frames === undefined ? {} : { frames: previous.frames }),
    ...(previous?.shot === undefined ? {} : { shot: previous.shot }),
  });
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

/** The subset of the page DOM {@link readWebviewFrames} walks, structurally typed. */
interface DomElementLike {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  classList: { contains(name: string): boolean };
  parentElement: DomElementLike | null;
  getAttribute(name: string): string | null;
  src?: string;
}

/**
 * Every visible webview frame of the page, in document order, in CSS pixels.
 *
 * This is the measurement the pointer commands work in and the one an operator has
 * to reason about: with more than one webview open, a coordinate read off the
 * screenshot belongs to whichever frame's rect contains it — and
 * `document.querySelector('iframe.webview')` silently answers with the **first**
 * one (the sidebar's), which is how a run concluded the settings page was 3× the
 * size of "the frame" while it was really looking at two different frames.
 *
 * The workbench part names are spelled out **inside** the evaluated function, and it
 * declares no inner named function: its source is serialized into the page, where a
 * module-scope constant is a `ReferenceError` and esbuild's `keepNames` wrapper for a
 * named inner function (`__name`) is one too — measured 2026-10-05, from a
 * `page.evaluate: ReferenceError: __name is not defined`.
 *
 * Which part a frame is in is decided **geometrically**, by the part whose rect
 * contains the frame's centre, not by DOM ancestry: a webview sits in a top-level
 * `position: fixed` overlay (CSS anchor positioning) beside the workbench, not inside
 * the sidebar or editor element, so walking parents reports every frame as
 * `workbench`.
 */
export async function readWebviewFrames(page: Page): Promise<WebviewFrame[]> {
  return page.evaluate((): WebviewFrame[] => {
    const parts = ['sidebar', 'editor', 'panel', 'auxiliarybar', 'activitybar', 'statusbar', 'titlebar'];
    const doc = (
      globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<DomElementLike> } }
    ).document;
    const partRects: Array<{ where: string; rect: { x: number; y: number; width: number; height: number } }> = [];
    for (const name of parts) {
      const element = Array.from(doc.querySelectorAll(`.part.${name}`))[0];
      if (element === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      partRects.push({ where: name, rect });
    }
    const frames: WebviewFrame[] = [];
    for (const element of Array.from(doc.querySelectorAll('iframe.webview, webview'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const src = String(element.src ?? element.getAttribute('src') ?? '');
      const id = /[?&]id=([^&]+)/.exec(src);
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      let where = 'workbench';
      let node: DomElementLike | null = element;
      while (node) {
        if (node.classList.contains('part')) {
          where = 'part';
          break;
        }
        node = node.parentElement;
      }
      for (const part of partRects) {
        if (
          cx >= part.rect.x &&
          cy >= part.rect.y &&
          cx <= part.rect.x + part.rect.width &&
          cy <= part.rect.y + part.rect.height
        ) {
          where = part.where;
          break;
        }
      }
      frames.push({
        webviewId: id ? id[1] : null,
        where,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    return frames;
  });
}

/**
 * The pixel size of a PNG capture, read from its IHDR chunk.
 *
 * Deliberately not an image library: the only question is how many image pixels the
 * capture has, and a PNG answers it in bytes 16–23. `null` for anything that is not
 * a PNG this can read — an unknown size must never be treated as agreement.
 */
export function parsePngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (const [index, byte] of signature.entries()) {
    if (bytes[index] !== byte) return null;
  }
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** {@link parsePngSize} for a capture on disk; `null` when it cannot be read. */
export function screenshotSize(file: string): { width: number; height: number } | null {
  try {
    return parsePngSize(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function containsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function describeRect(rect: Rect): string {
  return `(${rect.x},${rect.y}) ${rect.width}x${rect.height}`;
}

/** Where a page coordinate lands: in one webview frame, or on the workbench chrome. */
export interface CoordinatePlacement {
  kind: 'webview' | 'chrome';
  frame?: WebviewFrame;
  /** One line naming what the coordinate lands in — printed before the command acts. */
  note: string;
}

/** Which webview frame (if any) owns a page coordinate. Pure; see {@link readWebviewFrames}. */
export function placeCoordinate(point: { x: number; y: number }, frames: readonly WebviewFrame[]): CoordinatePlacement {
  const frame = frames.find((candidate) => containsPoint(candidate.rect, point));
  if (!frame) {
    return { kind: 'chrome', note: 'over workbench chrome (no webview frame contains it)' };
  }
  const which = frame.where === 'workbench' ? 'webview frame' : `${frame.where} webview`;
  const id = frame.webviewId === null ? '' : `, webview ${frame.webviewId.slice(0, 8)}`;
  return { kind: 'webview', frame, note: `inside the ${which} ${describeRect(frame.rect)}${id}` };
}

export interface PointerGeometryInput {
  command: string;
  point: { x: number; y: number };
  /** The last reading, i.e. what the coordinates were read off. */
  recorded: PixelUnitsState | null;
  /** The page's geometry now. */
  current: PixelReport;
  /** The frames on screen now, from {@link readWebviewFrames}. */
  liveFrames: readonly WebviewFrame[];
}

/**
 * The coordinate contract of every pointer command.
 *
 * Returns the one-line note naming what the coordinate lands in, or throws with the
 * measured numbers when the coordinate cannot be trusted. Four ways it cannot:
 *
 * 1. **It is not a number** — `ui click a b` would otherwise forward `NaN`.
 * 2. **It is outside the page's CSS viewport.** Measured 2026-10-05: the settings
 *    page's `AI 端点` section sat at inner y≈1460 of a 794-high sidebar frame, so a
 *    coordinate taken from that element resolved to y≈1528 of a 900-high page. CDP
 *    accepted it, nothing was clicked, and the command still exited 0 — the silent
 *    miss the README warns about, now a refusal.
 * 3. **The capture and the page disagree about what a pixel is.** A screenshot is in
 *    image pixels; CDP input is in CSS pixels. They agree only while the capture's
 *    `image.width / viewport.width` equals the page's `devicePixelRatio`, and a
 *    capture that came back at a different ratio (a stale capture from another
 *    window size, a build that captures at device scale, an unexpected zoom) makes
 *    every coordinate read off it point somewhere else. The pixel-scale guard covers
 *    `devicePixelRatio` *moving*; this covers the capture never having matched it.
 * 4. **The frame the coordinate was read for has moved or gone.** A webview is a
 *    separate frame; if the sidebar frame or an editor-area panel that contained the
 *    point at capture time is not there any more, or is not the same size, the
 *    element the coordinate was read for is not there either.
 *
 * The point of refusing rather than rescaling is the same as the scale guard's: only
 * a fresh capture gives coordinates that are truthful again.
 */
export function pointerGeometryGuard(input: PointerGeometryInput): string {
  const { command, point, recorded, current, liveFrames } = input;
  const viewport = current.viewport;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(
      `${command}: (${point.x}, ${point.y}) is not a coordinate. Pass two numbers in CSS pixels ` +
        `(the viewport is ${viewport.width}x${viewport.height}). Nothing was clicked.`,
    );
  }
  if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
    throw new Error(
      `${command}: (${point.x}, ${point.y}) is outside the page's CSS viewport ${viewport.width}x${viewport.height}.\n` +
        '  A pointer event there cannot reach the document: the command would exit 0 having clicked nothing.\n' +
        '  A coordinate usually ends up here because it was read off the DOM rather than a capture, or off a ' +
        'control a webview has scrolled out of view — scroll it first (ui scroll), then take a fresh screenshot.\n' +
        '  Nothing was clicked.',
    );
  }
  if (recorded?.image !== undefined && recorded.viewport.width > 0) {
    const imageScale = recorded.image.width / recorded.viewport.width;
    if (Math.abs(imageScale - current.scale) > 0.01) {
      throw new Error(
        `${command}: the last capture (${recorded.shot ?? 'screenshot'}) is ${recorded.image.width}x${recorded.image.height} ` +
          `image px for a ${recorded.viewport.width}x${recorded.viewport.height} CSS viewport, i.e. ${imageScale.toFixed(2)} ` +
          `image px per CSS px, while the page reports ${current.scale} device px per CSS px now.\n` +
          '  The two spaces disagree, so one coordinate read off that capture points somewhere else in the page.\n' +
          `  Take a fresh screenshot (viewport ${viewport.width}x${viewport.height}) and read the coordinates off that. ` +
          'Nothing was clicked.',
      );
    }
  }
  if (
    recorded !== null &&
    (recorded.viewport.width !== viewport.width || recorded.viewport.height !== viewport.height)
  ) {
    throw new Error(
      `${command}: the page is ${viewport.width}x${viewport.height} now, but the last capture ` +
        `(${recorded.shot ?? 'screenshot'}) was taken at ${recorded.viewport.width}x${recorded.viewport.height}.\n` +
        '  The window was resized, so the layout the coordinate was read off is gone and the same numbers land on ' +
        'a different element.\n' +
        `  Take a fresh screenshot (viewport ${viewport.width}x${viewport.height}) and read the coordinates off that. ` +
        'Nothing was clicked.',
    );
  }
  const live = placeCoordinate(point, liveFrames);
  const before = recorded?.frames === undefined ? null : placeCoordinate(point, recorded.frames);
  if (before?.kind === 'webview' && before.frame !== undefined) {
    const was = before.frame;
    const now = live.kind === 'webview' ? live.frame : undefined;
    const sameFrame =
      now !== undefined &&
      (was.webviewId !== null && now.webviewId !== null ? was.webviewId === now.webviewId : was.where === now.where);
    if (!sameFrame || now === undefined || !rectEquals(was.rect, now.rect)) {
      const nowText =
        now === undefined
          ? 'no webview frame contains it now'
          : `the frame there now is the ${now.where} webview ${describeRect(now.rect)}` +
            (now.webviewId === null ? '' : `, webview ${now.webviewId.slice(0, 8)}`);
      throw new Error(
        `${command}: (${point.x}, ${point.y}) was inside the ${was.where} webview ${describeRect(was.rect)} when the last ` +
          `capture (${recorded?.shot ?? 'screenshot'}) was taken, and ${nowText}.\n` +
          '  The frame moved, resized or closed, so the element the coordinate was read for may not be there any more.\n' +
          `  Take a fresh screenshot (viewport ${viewport.width}x${viewport.height}) and read the coordinates off that. ` +
          'Nothing was clicked.',
      );
    }
  }
  return `${command}: (${point.x}, ${point.y}) is ${live.note}`;
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
