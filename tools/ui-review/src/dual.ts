// Shared-profile dual-window mode for the UI-review harness.
//
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual launch
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual verify
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual targets
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual logs <window> [--grep X] [--tail N]
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual kill <window>
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review dual close
//
// Why this exists: the lease work (`docs/design/multi-window-polling-lease.md`
// §10.2, §11.2) needs **two windows of one profile**, because the lease file lives
// in that profile's `globalStorage` and the MCP broker endpoint is derived from
// the user profile. The normal launcher gives every launch its own profile, which
// can never produce that scenario.
//
// How the second window is opened: Ctrl+Shift+N *inside the running instance*.
// `code --new-window <folder>` against the same profile only raises the existing
// window (measured, §10.2) — it is not used here, and this mode refuses to report
// success unless a second workbench page actually appeared.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cdpTargets, connectAll, pagesWithTargetIds, waitWorkbench } from './driver';
import {
  defaultLaunchConfig,
  launchArgs,
  logsRootFor,
  readConfiguredInstances,
  readMockApiSetting,
  seedProfileSettings,
  type LaunchConfig,
} from './config';
import { buildDirFor, requireApiMode } from './apiMode';
import { flagBool, flagNumber, flagString, parseArgs } from './cliArgs';
import {
  attributeWindowDirs,
  extensionOutputLog,
  exthostLogPids,
  grepFiles,
  listSessionDirs,
  listWindowDirs,
  logFilesFor,
  resolveSessionDir,
  selectWindowDirs,
  type LogPreset,
  type WindowLogDir,
} from './logs';
import { clearState, readState, requireState, writeState, type DualWindowState } from './state';
import {
  extensionHostCandidates,
  killProcess,
  killTargetFor,
  listDevHostProcesses,
  pairExtensionHosts,
  profileOwners,
  windowProcesses,
  type DevHostProcess,
  type ExthostRef,
} from './winProc';
import {
  DEFAULT_WINDOW_DIRS,
  NEW_WINDOW_KEYS,
  cdpVersionUrl,
  isWorkbenchPageUrl,
  parseWindowSelector,
  systemKeystrokeCommand,
  workbenchTargetIds,
  type WindowLabel,
} from './windows';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const STATE_FILE_PATH = path.join(HARNESS_DIR, 'dual-window.json');
/** How many times the in-instance keystroke is sent before giving up (see below). */
const KEYSTROKE_ATTEMPTS = 3;

const USAGE = `usage: dual.ts <command> [options]

  launch [workspace]     launch the first dev host window, then open a second
                         window of the same profile with Ctrl+Shift+N
      --timeout <ms>       how long to wait for the second window (default 60000)
      --system-keystroke   fall back to activate.ps1 SendKeys if CDP input is
                           swallowed (may target the wrong window; see README)
      --no-wait-window     do not wait for the second window's log directory
      --real-api           allow this run to poll the real instance(s) configured
                           in the profile. Without it, a build with no mock API
                           compiled in is refused before any window starts
  verify                 re-check the running session (one profile, two windows,
                         two extension hosts, per-window log directories)
  targets                list the CDP target ids of both windows
  windows                list the log directories of both windows
  logs <1|2|all>         print this session's logs per window
      --preset extension|exthost|mcp|any   (default extension)
      --grep <text|/regex/>   --tail <n>   --follow
  kill <1|2>             Stop-Process -Force this window's extension host
      --print-command      print the exact PowerShell command instead of running it
  close                  stop this harness's dev host (all windows)
  state                  print the recorded session state`;

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'launch':
      await launchCommand(args);
      break;
    case 'verify':
      await verifyCommand();
      break;
    case 'targets':
      await targetsCommand();
      break;
    case 'windows':
      windowsCommand();
      break;
    case 'logs':
      await logsCommand(args);
      break;
    case 'kill':
      await killCommand(args);
      break;
    case 'close':
      closeCommand();
      break;
    case 'state':
      console.log(JSON.stringify(requireState(HARNESS_DIR), null, 2));
      break;
    default:
      console.error(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`dual: ${(error as Error).message}`);
  process.exit(1);
}

// --- launch -------------------------------------------------------------------

async function launchCommand(argvArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs(argvArgs, {
    value: ['--timeout'],
    boolean: ['--system-keystroke', '--no-wait-window', '--real-api'],
  });
  const config = defaultLaunchConfig(HARNESS_DIR, parsed.positional[0]);
  const timeoutMs = flagNumber(parsed, '--timeout', 60_000);

  // Before the running-session checks and before anything is spawned: a build
  // without the mock API must not start a window that would poll the profile's
  // real instance unless the operator passed --real-api (see src/apiMode.ts).
  const mode = requireApiMode({
    buildDir: buildDirFor(config.extensionDevDir),
    profileDir: config.profileDir,
    instances: readConfiguredInstances(config.profileDir),
    mockApiSetting: readMockApiSetting(config.profileDir),
    realApiRequested: flagBool(parsed, '--real-api'),
  });

  const existing = readState(HARNESS_DIR);
  if (existing && (await cdpReady(config.cdpPort))) {
    throw new Error(
      `a dual-window session from ${existing.launchedAt} is still running (${existing.profileDir}); ` +
        `run 'dual close' first, or 'dual verify' to inspect it`,
    );
  }
  const alreadyOpen = await workbenchIds(config.cdpPort);
  if (alreadyOpen.length > 0) {
    throw new Error(
      `a dev host is already listening on port ${config.cdpPort} with ${alreadyOpen.length} window(s) but no ` +
        `dual state file; run 'pnpm kill' first, so the two windows are the two this mode launched`,
    );
  }

  fs.mkdirSync(config.profileDir, { recursive: true });
  fs.mkdirSync(config.extensionsDir, { recursive: true });
  seedProfileSettings(config.profileDir, { useMockApi: mode === 'mock' });

  console.log(`launching the first window (profile ${config.profileDir})`);
  // `code` is a shell shim on Windows; escaping is not a concern here because every
  // argument comes from this file, not from user input, but `windowsHide` keeps a
  // console from flashing and the deprecation warning out of the output.
  const child = spawn('code', launchArgs(config), {
    detached: true,
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });
  child.unref();

  await waitForCdp(config.cdpPort, 60_000);

  const session = await currentLogSession(config);
  console.log(`log session: ${session}`);

  // One connection for the whole launch: Playwright's page list is in creation
  // order, which is the only ordering that can label the first and the second
  // window (/json/list does not preserve creation order — measured). The label of
  // each window is recorded as that page's own CDP target id, read from the page's
  // session, so the ids `dual targets` prints are the same ones `dual launch`
  // reported even when the list order differs.
  const { browser, pages } = await connectAll();
  const state = emptyState(config, session);
  try {
    if (pages.length !== 1) {
      // More than one workbench page right after the launch means the app restored
      // extra windows on its own (a leftover session state). Pairing would then be
      // a guess, and the whole point of this mode is that the two windows are the
      // two it knows about.
      throw new Error(
        `the first launch opened ${pages.length} workbench page(s); expected exactly one. ` +
          `Run 'pnpm kill', delete the profile's session state (or the whole profile), and retry`,
      );
    }
    await waitWorkbench(pages[0].page, 2000);
    const window1 = await identifyWindow(browser, pages, 0);
    console.log(`window1: target ${window1.targetId ?? '(unknown)'} — ${window1.title}`);

    // The session is recorded *first*: window1 is up and must be stoppable even if
    // everything after this point fails (the second window is exactly where this
    // launch is most likely to fail).
    state.targets.window1 = window1.targetId ?? undefined;
    writeState(HARNESS_DIR, state);
    console.log(`session state written to ${STATE_FILE_PATH} (window1 is already stoppable)`);

    const window2 = await openSecondWindow(browser, pages, parsed, timeoutMs);
    console.log(`window2: target ${window2.targetId ?? '(unknown)'} — ${window2.title}`);
    state.targets.window2 = window2.targetId ?? undefined;
    writeState(HARNESS_DIR, state);
  } catch (error) {
    state.launched = false;
    state.failedAt = new Date().toISOString();
    state.failure = (error as Error).message;
    writeState(HARNESS_DIR, state);
    console.error(`dual: launch failed: ${state.failure}`);
    console.error(
      `dual: whatever is running was recorded in ${STATE_FILE_PATH}; inspect it with 'dual verify' / ` +
        `'dual logs all', and stop it with 'dual close' (or 'pnpm kill' for every dev-host process)`,
    );
    process.exit(1);
  } finally {
    await browser.close();
  }

  try {
    if (!flagBool(parsed, '--no-wait-window')) {
      const mapped = await waitForWindowDirs(config, state);
      state.windowDirs = { window1: mapped.window1.name, window2: mapped.window2.name };
      // The pids come from each window's own exthost.log, which is the only
      // reliable window -> extension host link on current builds.
      const pairing = pairExtensionHosts(
        listDevHostProcesses(HARNESS_DIR),
        logPidsFor(config, session, { window1: state.windowDirs.window1, window2: state.windowDirs.window2 }),
      );
      state.exthosts = {
        window1: pairing.window1.pid ?? undefined,
        window2: pairing.window2.pid ?? undefined,
      };
      writeState(HARNESS_DIR, state);
      console.log(
        `extension hosts: window1 ${describeExthost(pairing.window1)}, window2 ${describeExthost(pairing.window2)}`,
      );
    } else {
      state.exthosts = readExthostsWithoutWaiting(config, session);
      writeState(HARNESS_DIR, state);
    }
  } catch (error) {
    state.launched = false;
    state.failedAt = new Date().toISOString();
    state.failure = (error as Error).message;
    writeState(HARNESS_DIR, state);
    console.error(`dual: launch failed while reading the windows' logs: ${state.failure}`);
    console.error(
      `dual: both windows are still running and the session was recorded in ${STATE_FILE_PATH}; ` +
        `inspect it with 'dual verify' / 'dual logs all', and stop it with 'dual close' ` +
        `(or 'pnpm kill' for every dev-host process of this harness)`,
    );
    process.exit(1);
  }

  const processes = listDevHostProcesses(HARNESS_DIR);
  reportSession(state, processes, profileOwners(processes));
}

function describeExthost(ref: ExthostRef): string {
  if (ref.pid === null) return '(no pid in its log)';
  return `pid ${ref.pid} (${ref.source}${ref.alive ? '' : ', not running'})`;
}

function emptyState(config: LaunchConfig, session: string): DualWindowState {
  return {
    version: 1,
    launchedAt: new Date().toISOString(),
    logSession: session,
    profileDir: config.profileDir,
    cdpPort: config.cdpPort,
    workspace: config.workspace,
    targets: {},
    exthosts: {},
    windowDirs: {},
    secondWindowOpenedBy: 'keystroke',
    launched: true,
    failedAt: null,
    failure: null,
  };
}

/**
 * Open window2 with the in-instance keystroke.
 *
 * Measured: the first `Control+Shift+N` sent over CDP can be swallowed even
 * though the workbench has rendered — the same keystroke a second later opens the
 * window. So the chord is sent up to `KEYSTROKE_ATTEMPTS` times, each with its own
 * wait; the failure message only appears when none of them produced a page. With
 * `--system-keystroke` the `activate.ps1` SendKeys path is the last attempt.
 */
async function openSecondWindow(
  browser: Parameters<typeof pagesWithTargetIds>[0],
  before: Parameters<typeof pagesWithTargetIds>[1],
  parsed: ReturnType<typeof parseArgs>,
  timeoutMs: number,
): Promise<IdentifiedWindow> {
  const perAttempt = Math.max(10_000, Math.ceil(timeoutMs / KEYSTROKE_ATTEMPTS));
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= KEYSTROKE_ATTEMPTS; attempt += 1) {
    console.log(
      `sending ${NEW_WINDOW_KEYS} inside the running instance (attempt ${attempt}/${KEYSTROKE_ATTEMPTS}) ` +
        'for a second window of this profile',
    );
    const page = before[0]?.page;
    if (!page) throw new Error('the first window has no workbench page to send the keystroke to');
    // Focusing first is what makes the chord land reliably; it also matches what a
    // human does before pressing it.
    await page.bringToFront().catch(() => {});
    await page.keyboard.press(NEW_WINDOW_KEYS);
    try {
      return await waitForSecondWindow(browser, before, perAttempt);
    } catch (error) {
      lastError = error as Error;
      // A partial miss can leave the window about to appear; check once more
      // before deciding the attempt failed.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pages = await workbenchPagesFor(browser);
      const added = pages.find((entry) => !before.some((known) => known.page === entry.page));
      if (added) return identifyWindow(browser, pages, pages.indexOf(added));
      console.log(`attempt ${attempt} produced no second window: ${lastError.message}`);
    }
  }
  if (flagBool(parsed, '--system-keystroke')) {
    console.log('falling back to activate.ps1 SendKeys; focus window1 by hand if it landed on the wrong window');
    await runSystemKeystroke();
    return waitForSecondWindow(browser, before, perAttempt);
  }
  throw new Error(
    `${lastError?.message ?? 'no second window appeared'} — the mode refuses to continue, because two windows ` +
      'of *different* profiles would defeat the lease scenario (Ctrl+Shift+N vs `code --new-window`, ' +
      'see README; --system-keystroke adds a SendKeys fallback)',
  );
}

/**
 * `--no-wait-window`: still name both extension hosts from whatever the logs
 * already say, but never wait for a directory to appear.
 */
function readExthostsWithoutWaiting(config: LaunchConfig, session: string): DualWindowState['exthosts'] {
  try {
    const dir = resolveSessionDir(logsRootFor(config), session);
    const dirs = attributeWindowDirs(dir);
    const pairing = pairExtensionHosts(
      listDevHostProcesses(HARNESS_DIR),
      logPidsFor(config, session, { window1: dirs.window1.name, window2: dirs.window2.name }),
    );
    return {
      window1: pairing.window1.pid ?? undefined,
      window2: pairing.window2.pid ?? undefined,
    };
  } catch {
    return {};
  }
}

/**
 * One window as the mode knows it: its position in Playwright's creation-ordered
 * page list (which is what makes it "window1" or "window2"), the page's own CDP
 * target id, and its title for a human reading the output.
 */
interface IdentifiedWindow {
  index: number;
  targetId: string | null;
  title: string;
  url: string;
}

async function identifyWindow(
  browser: Parameters<typeof pagesWithTargetIds>[0],
  pages: Parameters<typeof pagesWithTargetIds>[1],
  index: number,
): Promise<IdentifiedWindow> {
  const resolved = await pagesWithTargetIds(browser, pages);
  const entry = resolved[index];
  if (!entry) throw new Error(`window${index + 1} disappeared while it was being identified`);
  return {
    index,
    targetId: entry.targetId,
    title: await safeTitle(entry.page),
    url: entry.page.url(),
  };
}

async function safeTitle(page: { title: () => Promise<string> }): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '(title unavailable)';
  }
}

/**
 * Wait for the window the keystroke opens, and identify it *by page order*: the
 * pre-existing page stays at index 0, the new one arrives later in the list. Its
 * CDP target id is then read from the page itself, which is what gets recorded —
 * the `/json/list` order is not creation order and cannot be used for this.
 */
async function waitForSecondWindow(
  browser: Parameters<typeof pagesWithTargetIds>[0],
  before: ReadonlyArray<{ page: unknown }>,
  timeoutMs: number,
): Promise<IdentifiedWindow> {
  const known = new Set(before.map((entry) => entry.page));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pages = await workbenchPagesFor(browser);
    const added = pages.find((entry) => !known.has(entry.page));
    if (added) {
      return identifyWindow(browser, pages, pages.indexOf(added));
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for a second workbench window; the mode refuses to continue, ` +
          'because two windows of *different* profiles would defeat the lease scenario ' +
          '(Ctrl+Shift+N vs `code --new-window`, see README)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Workbench pages of a connected instance, in Playwright's (creation) order. */
async function workbenchPagesFor(
  browser: Parameters<typeof pagesWithTargetIds>[0],
): Promise<Array<{ label: string; page: import('playwright').Page; url: string }>> {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => isWorkbenchPageUrl(page.url()))
    .map((page, index) => ({ label: DEFAULT_WINDOW_DIRS[index] ?? `window${index + 1}`, page, url: page.url() }));
}

async function runSystemKeystroke(): Promise<void> {
  const { file, args } = systemKeystrokeCommand(HARNESS_DIR);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with ${code}`));
    });
  });
}

async function waitForWindowDirs(
  config: LaunchConfig,
  state: DualWindowState,
): Promise<Record<WindowLabel, WindowLogDir>> {
  const dir = resolveSessionDir(logsRootFor(config), state.logSession);
  // Wait for both windows' directories to exist at all. Which directory is which
  // window cannot be decided by a pid we do not have yet (the names come first),
  // so the only rule available here is VS Code's numbering: of the two
  // lowest-numbered window directories, the lower is the window that existed
  // first. `attributeWindowDirs` says as much in its own comment, and the pid
  // check that follows is what confirms it.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const facts = listWindowDirs(dir);
    if (facts.length >= 2) {
      const dirs = attributeWindowDirs(dir);
      // Both windows' extension output channels must exist for log capture to be
      // useful; a directory that exists but has no channel yet is not enough.
      if (DEFAULT_WINDOW_DIRS.every((label) => extensionOutputLog(dirs[label].dir))) {
        return dirs;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for both windows' log directories under ${dir}; ` + `run 'dual windows' to see what exists`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The pids each window's own `exthost/exthost.log` names. This is the window ->
 * extension host link on current VS Code builds: the extension host process has no
 * per-window marker in its command line (measured: six identical
 * `--type=utility --utility-sub-type=node.mojom.NodeService` processes, none with
 * `--logsPath` or `--user-data-dir`).
 */
function logPidsFor(
  config: LaunchConfig,
  session: string,
  windowDirs: Partial<Record<WindowLabel, string>>,
): Map<WindowLabel, number[]> {
  const dir = resolveSessionDir(logsRootFor(config), session);
  const logPids = new Map<WindowLabel, number[]>();
  for (const label of DEFAULT_WINDOW_DIRS) {
    const name = windowDirs[label];
    logPids.set(label, name ? exthostLogPids(path.join(dir, name)) : []);
  }
  return logPids;
}

async function currentLogSession(config: LaunchConfig): Promise<string> {
  const root = logsRootFor(config);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const sessions = listSessionDirs(root);
    if (sessions.length > 0) return sessions[sessions.length - 1];
    if (Date.now() > deadline) {
      throw new Error(`no log session appeared under ${root}; the dev host did not start logging`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// --- verify / targets / windows ----------------------------------------------

async function verifyCommand(): Promise<void> {
  const state = requireState(HARNESS_DIR);
  const processes = listDevHostProcesses(HARNESS_DIR);
  if (processes.length === 0) throw new Error("no dev-host process is running; run 'dual launch' again");

  const owners = profileOwners(processes);
  const windows = windowProcesses(processes);
  const config = defaultLaunchConfig(HARNESS_DIR);
  const dir = resolveSessionDir(logsRootFor(config), state.logSession);
  const dirs = attributeWindowDirs(dir, recordedPids(state));
  const pairing = pairExtensionHosts(processes, logPidsFor(config, state.logSession, state.windowDirs));

  const problems: string[] = [];
  if (!owners.consistent) {
    problems.push(`more than one --user-data-dir is in play: ${owners.profiles.join(' | ')}`);
  }
  if (
    state.profileDir &&
    owners.profiles.length > 0 &&
    !owners.profiles.some((profile) => samePath(profile, state.profileDir))
  ) {
    problems.push(`the running profile is not the recorded one (${state.profileDir})`);
  }
  if (state.failure) {
    problems.push(`the recorded launch failed: ${state.failure}`);
  }
  if (windows.length !== 2) {
    // Reported rather than failed on: which Chromium process type carries a VS
    // Code *window* is not documented, so the count is evidence, not a contract.
    console.log(
      `note: ${windows.length} process(es) look like window roots, expected 2 ` +
        `(pids ${windows.map((process) => process.pid).join(', ') || 'none'})`,
    );
  }
  for (const label of DEFAULT_WINDOW_DIRS) {
    const ref = pairing[label];
    if (ref.pid === null) {
      problems.push(`${label}: no "Extension host with pid" line in ${dirs[label].name}/exthost/exthost.log`);
      continue;
    }
    if (!ref.alive) {
      // Legitimate right after `dual kill`; a problem for a session that is meant
      // to be healthy.
      problems.push(`${label}: extension host pid ${ref.pid} (from its log) is not running any more`);
    }
    const recorded = state.exthosts[label];
    if (recorded !== undefined && recorded !== ref.pid) {
      console.log(`note: ${label}'s extension host changed (${recorded} -> ${ref.pid}): it was restarted`);
    }
  }
  if (pairing.window1.pid !== null && pairing.window1.pid === pairing.window2.pid) {
    problems.push("both windows' logs name the same extension host pid");
  }

  reportSession(state, processes, owners);
  console.log(
    `  log dirs: ${
      listWindowDirs(dir)
        .map((entry) => entry.name)
        .join(', ') || '(none yet)'
    }`,
  );
  for (const label of DEFAULT_WINDOW_DIRS) {
    const channel = extensionOutputLog(dirs[label].dir);
    console.log(
      `    ${label} -> ${dirs[label].name}: ${describeExthost(pairing[label])}` +
        (channel ? `, channel ${path.relative(dir, channel)}` : ', no extension channel yet'),
    );
  }

  if (problems.length > 0) {
    console.error(`dual verify FAILED:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('dual verify OK: two windows, one profile, one extension host each');
}

/** The pids recorded in the state file, for attributing directories back to windows. */
function recordedPids(state: DualWindowState): Map<WindowLabel, number> {
  const pids = new Map<WindowLabel, number>();
  for (const label of DEFAULT_WINDOW_DIRS) {
    const pid = state.exthosts[label];
    if (pid !== undefined) pids.set(label, pid);
  }
  return pids;
}

async function targetsCommand(): Promise<void> {
  const state = readState(HARNESS_DIR);
  // Ask each page for its own target id: `/json/list` returns windows in an order
  // that is *not* creation order (measured), and Playwright's own page order was
  // measured to differ between two connections too. The recorded ids are therefore
  // the only stable labels, and they decide which entry is window1/window2; a page
  // whose id is not recorded is reported as unrecorded rather than guessed.
  const { browser, pages } = await connectAll(state?.cdpPort);
  try {
    const windows = await pagesWithTargetIds(browser, pages);
    console.log(`${windows.length} workbench page(s)`);
    for (const [index, entry] of windows.entries()) {
      const label = labelForTarget(state, entry.targetId) ?? `page[${index}] (unrecorded)`;
      console.log(`  ${label}: ${entry.targetId ?? '(unknown)'} — ${await safeTitle(entry.page)}`);
    }
    if (windows.length !== 2) {
      console.log('note: this mode means to have exactly two windows; run dual close, then dual launch');
    }
    if (!state) {
      console.log(
        'note: no dual-window.json, so nothing is recorded: this lists pages in the order Playwright saw them, ' +
          'which is only meaningful for a host started by `pnpm launch`',
      );
    }
    // `--target <id>` is the reliable addressing; `--window <n>` resolves through
    // these same recorded ids (see ui.ts), so this table is what to copy from.
  } finally {
    await browser.close();
  }
}

/** The recorded label whose target id is `targetId`, if any. */
function labelForTarget(state: DualWindowState | null, targetId: string | null): WindowLabel | null {
  if (!state || !targetId) return null;
  for (const label of DEFAULT_WINDOW_DIRS) {
    if (state.targets[label] === targetId) return label;
  }
  return null;
}

function windowsCommand(): void {
  const state = requireState(HARNESS_DIR);
  const config = defaultLaunchConfig(HARNESS_DIR);
  const dir = resolveSessionDir(logsRootFor(config), state.logSession);
  const all = listWindowDirs(dir);
  const dirs = attributeWindowDirs(dir, recordedPids(state));
  console.log(`session ${state.logSession}: ${all.map((entry) => entry.name).join(', ') || '(none)'}`);
  let pairing: ReturnType<typeof pairExtensionHosts> | null = null;
  try {
    pairing = pairExtensionHosts(
      listDevHostProcesses(HARNESS_DIR),
      logPidsFor(config, state.logSession, {
        window1: dirs.window1.name,
        window2: dirs.window2.name,
      }),
    );
  } catch {
    pairing = null;
  }
  for (const label of DEFAULT_WINDOW_DIRS) {
    const entry = dirs[label];
    const exthostLog = path.join(entry.dir, 'exthost', 'exthost.log');
    const channel = extensionOutputLog(entry.dir);
    const pids = exthostLogPids(entry.dir);
    console.log(
      `  ${label}: ${entry.name} (exthost.log ${fs.existsSync(exthostLog) ? 'present' : 'missing'}` +
        `${pids.length > 0 ? `, names pid ${pids[pids.length - 1]}${pids.length > 1 ? ` of ${pids.join('/')}` : ''}` : ''}` +
        `${channel ? `, channel ${path.relative(dir, channel)}` : ', no extension channel'}` +
        `${pairing ? `; ${describeExthost(pairing[label])}` : ''})`,
    );
  }
}

// --- logs ---------------------------------------------------------------------

async function logsCommand(argvArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs(argvArgs, {
    value: ['--preset', '--grep', '--tail', '--window'],
    boolean: ['--follow'],
  });
  const selector = parseWindowSelector(parsed.positional[0] ?? flagString(parsed, '--window') ?? 'all');
  const preset = (flagString(parsed, '--preset') ?? 'extension') as LogPreset;
  if (!['extension', 'exthost', 'mcp', 'any'].includes(preset)) {
    throw new Error(`unknown --preset '${preset}' (extension, exthost, mcp, any)`);
  }
  const state = readState(HARNESS_DIR);
  const config = defaultLaunchConfig(HARNESS_DIR);
  const dir = resolveSessionDir(logsRootFor(config), state?.logSession);
  const dirs = selectWindowDirs(dir, selector, state ? recordedPids(state) : undefined);
  const query = {
    preset,
    grep: flagString(parsed, '--grep'),
    tail: parsed.flags.has('--tail') ? flagNumber(parsed, '--tail', 0) : undefined,
  };

  const print = (windowDir: WindowLogDir): void => {
    const files = logFilesFor(windowDir.dir, preset);
    const matches = grepFiles(files, query);
    console.log(`--- ${windowDir.name} (${preset}${query.grep ? `, /${query.grep}/` : ''}) ${matches.length} line(s)`);
    for (const match of matches) console.log(`${path.basename(match.file)}:${match.line}: ${match.text}`);
  };

  for (const dir of dirs) print(dir);
  if (!flagBool(parsed, '--follow')) return;

  const offsets = new Map<string, number>();
  for (const dir of dirs) {
    for (const file of logFilesFor(dir.dir, preset)) offsets.set(file, fs.statSync(file).size);
  }
  console.log('--- following (Ctrl+C to stop)');
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const dir of dirs) {
      for (const file of logFilesFor(dir.dir, preset)) {
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        const offset = offsets.get(file) ?? 0;
        if (size <= offset) {
          if (size < offset) offsets.set(file, size);
          continue;
        }
        const handle = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(size - offset);
        fs.readSync(handle, buffer, 0, buffer.length, offset);
        fs.closeSync(handle);
        offsets.set(file, size);
        for (const line of buffer.toString('utf8').split(/\r?\n/)) {
          if (line.trim() !== '') console.log(`${dir.name} ${path.basename(file)}: ${line}`);
        }
      }
    }
  }
}

// --- kill / close -------------------------------------------------------------

async function killCommand(argvArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs(argvArgs, { value: [], boolean: ['--print-command'] });
  const selector = parseWindowSelector(parsed.positional[0] ?? '');
  if (selector === 'all') throw new Error("kill takes one window; 'all' is only meaningful for 'dual logs'");
  const state = requireState(HARNESS_DIR);
  const config = defaultLaunchConfig(HARNESS_DIR);
  const processes = listDevHostProcesses(HARNESS_DIR);
  const pairing = pairExtensionHosts(processes, logPidsFor(config, state.logSession, state.windowDirs));
  const target = killTargetFor(selector, pairing[selector], processes);

  console.log(`${selector}: extension host ${target.pid} (pid from ${pairing[selector].source})`);
  console.log(`  ${target.command}`);
  if (flagBool(parsed, '--print-command')) return;

  killProcess(target.pid);
  console.log(
    `killed ${selector}'s extension host; that window loses its extension host while the app and the other ` +
      'window stay up — the crash shape the lease must survive',
  );

  const after = listDevHostProcesses(HARNESS_DIR);
  const other: WindowLabel = selector === 'window1' ? 'window2' : 'window1';
  const survivors = pairExtensionHosts(after, logPidsFor(config, state.logSession, state.windowDirs));
  console.log(`still running: ${other} (${describeExthost(survivors[other])})`);

  const dir = resolveSessionDir(logsRootFor(config), state.logSession);
  const dirs = attributeWindowDirs(dir, recordedPids(state));
  const entry = dirs[selector];
  const channel = extensionOutputLog(entry.dir);
  console.log(
    `its log directory ${entry.name} keeps the last lines it wrote` +
      `${channel ? ` (${path.relative(dir, channel)})` : ''}; reloading that window starts a new ` +
      'output_logging_* directory in there',
  );
}

function closeCommand(): void {
  const processes = listDevHostProcesses(HARNESS_DIR);
  const windows = windowProcesses(processes);
  if (windows.length === 0) {
    console.log('no dev-host window is running');
  } else {
    for (const process of windows) {
      // A Code.exe without `--type=` is the app instance's root process (measured:
      // exactly one per dev host, however many windows it has), so stopping it
      // closes every window of *this harness* — which is what `close` is for.
      // `dual kill <n>` is the per-window operation.
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Stop-Process -Id ${process.pid} -Force; Write-Output "stopped ${process.pid}"`],
        { encoding: 'utf8' },
      );
      console.log(out.trim());
    }
    console.log(
      `(stopped ${windows.length} root process(es): the dev host is one app instance, so this closes all its windows)`,
    );
  }
  console.log(clearState(HARNESS_DIR) ? `cleared ${STATE_FILE_PATH}` : 'no dual-window.json to clear');
}

// --- small helpers ------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

async function cdpReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(cdpVersionUrl(port));
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdpReady(port)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for CDP on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function workbenchIds(port: number): Promise<string[]> {
  return workbenchTargetIds(await cdpTargets(port).catch(() => []));
}

function reportSession(
  state: DualWindowState,
  processes: readonly DevHostProcess[],
  owners: ReturnType<typeof profileOwners>,
): void {
  const candidates = extensionHostCandidates(processes);
  console.log('');
  console.log(`session state: ${STATE_FILE_PATH}${state.launched ? '' : '  [LAUNCH FAILED]'}`);
  if (state.failure) console.log(`  failure:   ${state.failure} (at ${state.failedAt})`);
  console.log(`  profile:   ${state.profileDir}${owners.consistent ? '' : '  [MULTIPLE PROFILES SEEN]'}`);
  console.log(`  workspace: ${state.workspace}`);
  console.log(
    `  windows:   ${windowProcesses(processes).length} window process(es), ` +
      `${candidates.length} extension-host-shaped process(es)`,
  );
  if (!owners.consistent) {
    console.log(`  !! --user-data-dir values: ${owners.profiles.join(' | ')}`);
  }
  for (const label of DEFAULT_WINDOW_DIRS) {
    console.log(
      `  ${label}:    target ${state.targets[label] ?? '?'}, exthost ${state.exthosts[label] ?? '?'}` +
        (state.windowDirs[label] ? `, logs ${state.windowDirs[label]}` : ''),
    );
  }
  console.log('  next: dual verify | dual logs all --grep "MCP broker" | dual kill 2 | dual close');
}
