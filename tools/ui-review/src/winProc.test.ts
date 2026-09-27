// Unit tests for dev-host process selection: which Code.exe is a window, which
// processes merely *look* like an extension host, how the two windows' extension
// hosts are paired, and that the kill command can only ever target one of them.
//
// The process tables are hand-written from what `Get-CimInstance Win32_Process`
// actually returned on this machine on 2026-09-27 — including the shape where the
// extension host is a `--type=utility --utility-sub-type=node.mojom.NodeService`
// process with no per-window marker, which is why pairing goes through each
// window's own `exthost.log` pid. `listDevHostProcesses` itself needs a running
// dev host and is exercised by `dual verify`, not here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyProcess,
  escapeRegex,
  extensionHostCandidates,
  isPidAlive,
  killTargetFor,
  normalizeWinPath,
  pairExtensionHosts,
  parseCommandLine,
  profileOwners,
  stopProcessCommand,
  toDevHostProcess,
  windowProcesses,
  type DevHostProcess,
  type ExthostRef,
} from './winProc';

const HARNESS = 'D:\\code\\forgejo-toolkit\\tools\\ui-review';
const PROFILE = `${HARNESS}\\profile`;

interface RawProcess {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string;
  CreationDate?: string;
}

function toProcess(raw: RawProcess): DevHostProcess {
  return toDevHostProcess(raw);
}

const CODE = '"C:\\Program Files\\Microsoft VS Code\\Code.exe"';

/** A window root, as measured: the root does *not* carry `--user-data-dir`. */
function windowRoot(pid: number, createdAt: string): RawProcess {
  return {
    ProcessId: pid,
    ParentProcessId: 1000,
    CommandLine: `${CODE} --user-data-dir="${PROFILE}" --extensions-dir="${HARNESS}\\extensions" --remote-debugging-port=9222 --new-window "D:\\code\\test"`,
    CreationDate: createdAt,
  };
}

/**
 * The extension host as this build spawns it: a NodeService utility process with
 * no `--logsPath`, no `--user-data-dir` and nothing else that names its window.
 */
function nodeService(pid: number, createdAt: string): RawProcess {
  return {
    ProcessId: pid,
    ParentProcessId: 10128,
    CommandLine: `${CODE} --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US --service-sandbox-type=none --user-data-dir="${PROFILE}"`,
    CreationDate: createdAt,
  };
}

/** The older shape, still recognised. */
function classicExthost(pid: number, createdAt: string, logsPath?: string): RawProcess {
  return {
    ProcessId: pid,
    ParentProcessId: 1000,
    CommandLine:
      `${CODE} --type=extensionHost --transformURIs --useHostProxy=false` +
      (logsPath ? ` --logsPath "${logsPath}"` : ''),
    CreationDate: createdAt,
  };
}

test('a root process is a window, an extension host is one of two shapes', () => {
  assert.equal(classifyProcess({ type: null, utilitySubType: null }), 'window');
  assert.equal(classifyProcess({ type: 'extensionHost', utilitySubType: null }), 'extensionHost');
  assert.equal(classifyProcess({ type: 'ExtensionHost', utilitySubType: null }), 'extensionHost');
  assert.equal(classifyProcess({ type: 'utility', utilitySubType: 'node.mojom.NodeService' }), 'extensionHost');
  assert.equal(classifyProcess({ type: 'utility', utilitySubType: 'NODE.MOJOM.NODESERVICE' }), 'extensionHost');
  // Other utility processes are not candidates at all.
  assert.equal(classifyProcess({ type: 'utility', utilitySubType: 'network.mojom.NetworkService' }), 'other');
  assert.equal(classifyProcess({ type: 'utility', utilitySubType: null }), 'other');
  assert.equal(classifyProcess({ type: 'renderer', utilitySubType: null }), 'other');
  assert.equal(classifyProcess({ type: 'gpu-process', utilitySubType: null }), 'other');
});

test('command lines are parsed in both flag spellings', () => {
  const parsed = parseCommandLine(
    `${CODE} --type=utility --utility-sub-type=node.mojom.NodeService --logsPath "D:\\logs\\window1" --user-data-dir=D:\\profile --extensionDevelopmentPath="D:\\repo\\packages\\forgejo-toolkit"`,
  );
  assert.equal(parsed.type, 'utility');
  assert.equal(parsed.utilitySubType, 'node.mojom.nodeservice');
  assert.equal(parsed.logsPath, 'D:\\logs\\window1');
  assert.equal(parsed.userDataDir, 'D:\\profile');
  assert.equal(parsed.extensionDevelopmentPath, 'D:\\repo\\packages\\forgejo-toolkit');

  const spaced = parseCommandLine(`${CODE} --type extensionHost --no-sandbox`);
  assert.equal(spaced.type, 'extensionhost');
  assert.equal(spaced.utilitySubType, null);
  assert.equal(parseCommandLine(`${CODE}`).type, null);
});

test("this build: six NodeService processes, two of them are the windows' extension hosts", () => {
  // Reproduced from the measured session: every NodeService carries the harness
  // profile, so the command line cannot say which window any of them belongs to.
  const processes = [
    toProcess(windowRoot(10128, '2026-09-27T19:14:36.0085640+08:00')),
    toProcess(nodeService(50068, '2026-09-27T19:14:37.0442530+08:00')),
    toProcess(nodeService(21416, '2026-09-27T19:14:37.3840810+08:00')),
    toProcess(nodeService(30116, '2026-09-27T19:14:37.4397850+08:00')),
    toProcess(nodeService(49840, '2026-09-27T19:14:37.5437870+08:00')),
    toProcess(nodeService(43592, '2026-09-27T19:14:40.4459020+08:00')),
    toProcess(nodeService(25824, '2026-09-27T19:14:40.5013150+08:00')),
  ];
  assert.equal(extensionHostCandidates(processes).length, 6);
  assert.equal(windowProcesses(processes).length, 1, 'the root is the only window-shaped process here');

  // Without log pids, six candidates cannot be paired — refuse rather than guess.
  assert.throws(() => pairExtensionHosts(processes), /found 6 extension-host-shaped processes/);

  // With the pids each window's exthost.log names, the pairing is exact.
  const pairing = pairExtensionHosts(
    processes,
    new Map([
      ['window1', [49840]],
      ['window2', [25824]],
    ]),
  );
  assert.equal(pairing.window1.pid, 49840);
  assert.equal(pairing.window2.pid, 25824);
  assert.equal(pairing.window1.source, 'log');
  assert.equal(pairing.window1.alive, true);
  assert.equal(pairing.window1.process?.utilitySubType, 'node.mojom.nodeservice');
});

test('the older shape still pairs from the process table when no log pids are given', () => {
  const processes = [
    toProcess(classicExthost(44400, '2026-09-27T16:45:09.0000000+08:00')),
    toProcess(classicExthost(52888, '2026-09-27T16:46:05.0000000+08:00')),
  ];
  const pairing = pairExtensionHosts(processes);
  assert.equal(pairing.window1.pid, 44400, 'the older extension host is the window that was already open');
  assert.equal(pairing.window2.pid, 52888);
  assert.equal(pairing.window1.source, 'process-table');

  // A --logsPath hint is still honoured when the build provides one; here it is
  // carried by the pid the log named, so the log wins.
  const hinted = pairExtensionHosts(
    processes,
    new Map([
      ['window1', [52888]],
      ['window2', [44400]],
    ]),
  );
  assert.equal(hinted.window1.pid, 52888);
  assert.equal(hinted.window2.pid, 44400);
});

test('a window whose log names an already-exited pid is reported, not silently re-paired', () => {
  const processes = [
    toProcess(nodeService(49840, '2026-09-27T19:14:37.5437870+08:00')),
    toProcess(nodeService(25824, '2026-09-27T19:14:40.5013150+08:00')),
  ];
  // window2's last recorded host is gone (killed, or reloaded and not restarted).
  const pairing = pairExtensionHosts(
    processes,
    new Map([
      ['window1', [49840]],
      ['window2', [999_999]],
    ]),
  );
  assert.equal(pairing.window1.pid, 49840);
  assert.equal(pairing.window2.pid, 999_999);
  assert.equal(pairing.window2.alive, false);
  assert.equal(pairing.window2.process, null);

  // A window that reloaded has several pids in its log: the live one wins.
  const reloaded = pairExtensionHosts(
    processes,
    new Map([
      ['window1', [49840]],
      ['window2', [111_111, 25824]],
    ]),
  );
  assert.equal(reloaded.window2.pid, 25824);
  assert.equal(reloaded.window2.alive, true);
});

test('the two windows must not resolve to the same extension host', () => {
  const processes = [toProcess(nodeService(49840, '2026-09-27T19:14:37.5437870+08:00'))];
  assert.throws(
    () =>
      pairExtensionHosts(
        processes,
        new Map([
          ['window1', [49840]],
          ['window2', [49840]],
        ]),
      ),
    /both windows' logs name the same extension host pid/,
  );
});

test('a window with no extension host in its log is an error in the fallback path', () => {
  const processes = [toProcess(nodeService(49840, '2026-09-27T19:14:37.5437870+08:00'))];
  assert.throws(
    () =>
      pairExtensionHosts(
        processes,
        new Map([
          ['window1', [49840]],
          ['window2', []],
        ]),
      ),
    /only one candidate extension host is running and no exthost.log pid/,
  );
  assert.throws(() => pairExtensionHosts([]), /no extension host process found/);
});

test('the kill command names exactly one extension host, and refuses anything else', () => {
  const processes = [
    toProcess(windowRoot(10128, '2026-09-27T19:14:36.0085640+08:00')),
    toProcess(nodeService(49840, '2026-09-27T19:14:37.5437870+08:00')),
    toProcess(nodeService(25824, '2026-09-27T19:14:40.5013150+08:00')),
  ];
  const pairing = pairExtensionHosts(
    processes,
    new Map([
      ['window1', [49840]],
      ['window2', [25824]],
    ]),
  );

  const killWindow2 = killTargetFor('window2', pairing.window2, processes);
  assert.equal(killWindow2.command, 'Stop-Process -Id 25824 -Force');
  assert.equal(killWindow2.type, 'utility');

  const killWindow1 = killTargetFor('window1', pairing.window1, processes);
  assert.equal(killWindow1.command, 'Stop-Process -Id 49840 -Force');
  assert.notEqual(killWindow1.pid, killWindow2.pid);

  // A window *root* pid must never be killed: that closes the window rather than
  // simulating an extension-host crash.
  const rootRef: ExthostRef = { pid: 10128, source: 'process-table', process: processes[0], alive: true };
  assert.throws(() => killTargetFor('window1', rootRef, processes), /refusing to kill pid 10128/);
  // A dead pid is refused instead of reporting a kill that killed nothing.
  const deadRef: ExthostRef = { pid: 4242, source: 'log', process: null, alive: false };
  assert.throws(() => killTargetFor('window2', deadRef, processes), /is not running any more/);
  // A pid that vanished between the two reads is refused too.
  const vanishedRef: ExthostRef = { pid: 999, source: 'log', process: null, alive: true };
  assert.throws(() => killTargetFor('window2', vanishedRef, processes), /not a process of this dev host any more/);
  // No pid in the log at all.
  const noPidRef: ExthostRef = { pid: null, source: 'log', process: null, alive: false };
  assert.throws(() => killTargetFor('window1', noPidRef, processes), /no extension host pid recorded/);
  // And no command is ever built for a nonsense pid.
  assert.throws(() => stopProcessCommand(0), /refusing to build a kill command/);
  assert.throws(() => stopProcessCommand(-1), /refusing to build a kill command/);
});

test('the pid liveness probe answers for this process and a dead one', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  // A pid that has certainly exited (the runner's own parent chain is not reused
  // this quickly on Windows); if it were alive the probe would still be correct.
  const dead = findDeadPid();
  assert.equal(isPidAlive(dead), false);
});

function findDeadPid(): number {
  for (let candidate = 4_000_000; candidate < 4_000_100; candidate += 1) {
    if (!isPidAlive(candidate)) return candidate;
  }
  throw new Error('no dead pid found to probe');
}

test('two different --user-data-dir values are reported as inconsistent', () => {
  const processes = [
    toProcess(windowRoot(100, '2026-09-27T16:45:09.0000000+08:00')),
    toProcess({ ProcessId: 400, ParentProcessId: 1000, CommandLine: `${CODE} --user-data-dir="D:\\other\\profile"` }),
  ];
  const owners = profileOwners(processes);
  assert.equal(owners.consistent, false);
  assert.equal(owners.profiles.length, 2);
  // Trailing separators and slashes are the same directory, not two.
  assert.equal(normalizeWinPath('D:\\profile\\'), normalizeWinPath('d:/profile'));
  assert.equal(profileOwners(processes.slice(0, 1)).consistent, true);
});

test('the process-list marker is escaped for a .NET regex', () => {
  // `-match` is a regex, so a path with metacharacters must not be inserted raw —
  // and a path backslash must stay a literal backslash rather than becoming an
  // escape for the character that follows it.
  const bs = String.fromCharCode(92);
  assert.equal(escapeRegex(HARNESS), HARNESS.split(bs).join(`${bs}${bs}`));
  assert.ok(new RegExp(escapeRegex(HARNESS), 'i').test(`--user-data-dir="${HARNESS}${bs}profile"`));
  assert.ok(new RegExp(escapeRegex(HARNESS), 'i').test(`--user-data-dir=${HARNESS}`));

  assert.equal(escapeRegex('tools/ui-review'), 'tools/ui-review');
  assert.ok(new RegExp(escapeRegex('tools.ui-review'), 'i').test('tools.ui-review'));
  assert.ok(!new RegExp(escapeRegex('tools.ui-review'), 'i').test('toolsXui-review'), 'the dot must be literal');
});
