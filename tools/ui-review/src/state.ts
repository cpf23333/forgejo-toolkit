// The dual-window mode's state file: what `dual.ts launch` recorded, so that
// `logs`, `targets` and `kill` do not have to re-derive it (and cannot silently
// pick a different log session).
import fs from 'node:fs';
import path from 'node:path';
import type { WindowLabel } from './windows';

export const STATE_FILE = 'dual-window.json';
export const STATE_VERSION = 1;

export interface DualWindowState {
  version: number;
  /** ISO timestamp of the launch. */
  launchedAt: string;
  /** `logs/<session>` directory name inside the isolated profile. */
  logSession: string;
  /** Absolute path of the isolated profile (`--user-data-dir`). */
  profileDir: string;
  cdpPort: number;
  workspace: string;
  /** Window label -> the window's CDP workbench target id. */
  targets: Partial<Record<WindowLabel, string>>;
  /** Window label -> extension-host pid, as paired at launch/verify time. */
  exthosts: Partial<Record<WindowLabel, number>>;
  /** Window label -> `logs/<session>/window<N>` directory name actually on disk. */
  windowDirs: Partial<Record<WindowLabel, string>>;
  /** How `window2` was opened; `keystroke` is the only supported way. */
  secondWindowOpenedBy: 'keystroke' | 'unknown';
  /**
   * False when a step after the two windows were identified threw. The state file
   * is written as soon as both windows exist precisely so that this record — and
   * `dual close` — survive a failed launch.
   */
  launched: boolean;
  failedAt: string | null;
  failure: string | null;
}

export function stateFilePath(harnessDir: string): string {
  return path.join(harnessDir, STATE_FILE);
}

export function readState(harnessDir: string): DualWindowState | null {
  const file = stateFilePath(harnessDir);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DualWindowState;
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`${file} has version ${parsed.version}, expected ${STATE_VERSION}`);
  }
  return parsed;
}

export function requireState(harnessDir: string): DualWindowState {
  const state = readState(harnessDir);
  if (!state) {
    throw new Error(
      `no ${STATE_FILE} in ${harnessDir}: run 'pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual launch' first`,
    );
  }
  return state;
}

export function writeState(harnessDir: string, state: DualWindowState): string {
  const file = stateFilePath(harnessDir);
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

export function clearState(harnessDir: string): boolean {
  const file = stateFilePath(harnessDir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * The target id `dual launch` recorded for `window<n>`, or null when there is no
 * session (or that window was never recorded). This is what makes `--window <n>`
 * mean a specific window rather than "whichever page happens to be nth in this
 * connection's list" — Playwright's order was measured to differ between runs.
 */
export function recordedTargetFor(harnessDir: string, window: number): string | null {
  if (!Number.isInteger(window) || window < 1) return null;
  const state = readState(harnessDir);
  if (!state) return null;
  const label = `window${window}` as WindowLabel;
  return state.targets[label] ?? null;
}
