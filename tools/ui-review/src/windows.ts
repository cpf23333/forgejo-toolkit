// Shared-profile dual-window mode: the pure parts.
//
// The harness launches its dev host with an isolated `--user-data-dir` (see
// launch.ts), which means every launch gets a *different* profile. The lease
// work (`docs/design/multi-window-polling-lease.md`) and the MCP broker both need
// the opposite: **two windows of one profile**, so they share `globalStorage`
// (lease file) and the per-user broker endpoint.
//
// The measured technique (design doc §10.2, verified 2026-09-27) is a second
// window opened *inside the running instance* — Ctrl+Shift+N — because
// `code --new-window <folder>` against the same profile only raises the existing
// window. `code --new-window` is also found in launch.ts, where it is correct:
// there the app is being started for the first time.
//
// Nothing in this file touches the filesystem, Playwright, or Windows; it holds
// the label/addressing rules, the keystroke and CLI command construction, and the
// process-selection rules, so they are unit-testable without a real run.
import path from 'node:path';

export const WINDOW_LABELS = ['window1', 'window2'] as const;
export type WindowLabel = (typeof WINDOW_LABELS)[number];
export type WindowSelector = WindowLabel | 'all';

export const DEFAULT_WINDOW_DIRS = ['window1', 'window2'] as const;

/** What the user types / the CLI accepts: `1`, `2`, `window1`, `window2`, `all`. */
export function parseWindowSelector(raw: string): WindowSelector {
  const value = raw.trim().toLowerCase();
  if (value === 'all') return 'all';
  if (value === '1' || value === 'window1') return 'window1';
  if (value === '2' || value === 'window2') return 'window2';
  throw new Error(`unknown window selector '${raw}' (expected 1, 2, window1, window2 or all)`);
}

export function formatWindowLabel(label: WindowLabel): string {
  return label;
}

/**
 * The first window is the one that already had a workbench page when the second
 * was requested; the new page from the keystroke is the second window. Playwright
 * returns context pages in creation order, and `Target.getTargets` in target-id
 * order, so both are stable for a connection that listed `previous` first — the
 * caller must pass the ids it saw *before* sending the keystroke.
 */
export function diffWorkbenchPages(previous: readonly string[], current: readonly string[]): string[] {
  const seen = new Set(previous);
  return [...new Set(current)].filter((id) => !seen.has(id)).sort();
}

const WORKBENCH_URL = 'workbench.html';

export function isWorkbenchPageUrl(url: string): boolean {
  return url.includes(WORKBENCH_URL);
}

export interface CdpTargetLike {
  targetId: string;
  type: string;
  url: string;
}

/** Workbench pages only, in a stable order (target id). OOPIF webviews are not pages. */
export function workbenchTargetIds(targets: readonly CdpTargetLike[]): string[] {
  return targets
    .filter((t) => t.type === 'page' && isWorkbenchPageUrl(t.url))
    .map((t) => t.targetId)
    .sort();
}

// --- the in-instance keystroke ------------------------------------------------

/** Chord that opens a new window **of the running instance** (not a new app). */
export const NEW_WINDOW_KEYS = 'Control+Shift+N' as const;
/** `WScript.Shell` spelling of the same chord, used only by the system fallback. */
export const NEW_WINDOW_SENDKEYS = '^+n' as const;

export const CDP_PORT = Number(process.env.CDP_PORT || 9222);

export function cdpVersionUrl(port: number = CDP_PORT): string {
  return `http://127.0.0.1:${port}/json/version`;
}

export function cdpTargetsUrl(port: number = CDP_PORT): string {
  return `http://127.0.0.1:${port}/json/list`;
}

/**
 * `activate.ps1 -Keys '^+n'` — the system-level fallback. It exists because CDP
 * input can be swallowed (a focused native dialog, an OOPIF with focus). It is
 * *not* the primary path: with two dev-host windows open, `activate.ps1` finds the
 * dev host by `MainWindowHandle` (see src/win/devhost.ps1), which is one window
 * per process, so it may raise the wrong window; the README says to focus the
 * first window by hand before using it.
 */
export function systemKeystrokeCommand(harnessDir: string): {
  file: string;
  args: string[];
} {
  return {
    file: 'powershell',
    args: ['-NoProfile', '-File', path.join(harnessDir, 'src', 'win', 'activate.ps1'), '-Keys', NEW_WINDOW_SENDKEYS],
  };
}

/**
 * A `connectOverCDP` connection reaches the whole dev-host instance, so the driver
 * cannot pick a window by itself: `pnpm ui` addresses one window with
 * `--target <cdpTargetId>` (the `uiTargetArgs` below), and the id comes from
 * `dual.ts targets`, which prints the two windows' target ids.
 */
export function uiTargetArgs(targetId: string): string[] {
  if (!targetId.trim()) throw new Error('a CDP target id is required to address a single window');
  return ['--target', targetId];
}
