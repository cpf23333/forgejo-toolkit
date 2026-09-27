// The dev-host launch configuration, shared by `launch.ts` (one isolated profile
// per launch) and `dual.ts` (that same launch, then a second window of the same
// profile). Keeping it in one place is what makes "the dual-window mode is the
// same first window as today" checkable instead of a copy that can drift.
import fs from 'node:fs';
import path from 'node:path';
import { CDP_PORT } from './windows';

export interface LaunchConfig {
  harnessDir: string;
  repoRoot: string;
  profileDir: string;
  extensionsDir: string;
  extensionDevDir: string;
  workspace: string;
  cdpPort: number;
  locale?: string;
}

export function defaultLaunchConfig(
  harnessDir: string,
  workspaceArg?: string,
  env: NodeJS.ProcessEnv = process.env,
): LaunchConfig {
  const repoRoot = path.resolve(harnessDir, '..', '..');
  return {
    harnessDir,
    repoRoot,
    profileDir: path.join(harnessDir, 'profile'),
    extensionsDir: path.join(harnessDir, 'extensions'),
    extensionDevDir: path.join(repoRoot, 'packages', 'forgejo-toolkit'),
    workspace: workspaceArg || env.UI_WORKSPACE || 'D:\\code\\test',
    cdpPort: Number(env.CDP_PORT || CDP_PORT),
    locale: env.UI_LOCALE,
  };
}

/**
 * The arguments for the **first** window. `--user-data-dir` plus
 * `--extensions-dir` are the whole isolation story: without them a second launch
 * would join the user's own VS Code instance and the Chromium flags (notably
 * `--remote-debugging-port`) would be swallowed by it.
 *
 * The second window is deliberately *not* launched with these arguments; see
 * windows.ts (Ctrl+Shift+N inside the running instance).
 */
export function launchArgs(config: LaunchConfig): string[] {
  return [
    `--user-data-dir=${config.profileDir}`,
    `--extensions-dir=${config.extensionsDir}`,
    `--extensionDevelopmentPath=${config.extensionDevDir}`,
    `--remote-debugging-port=${config.cdpPort}`,
    '--new-window',
    '--skip-welcome',
    '--skip-release-notes',
    ...(config.locale ? [`--locale=${config.locale}`] : []),
    config.workspace,
  ];
}

/** Pre-seed settings so the walkthroughs work offline (mock API on by default). */
export function seedProfileSettings(profileDir: string): void {
  const userDir = path.join(profileDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, 'settings.json');
  const settings: Record<string, unknown> = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
    : {};
  settings['forgejoToolkit.useMockApi'] ??= true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function logsRootFor(config: LaunchConfig): string {
  return path.join(config.profileDir, 'logs');
}
