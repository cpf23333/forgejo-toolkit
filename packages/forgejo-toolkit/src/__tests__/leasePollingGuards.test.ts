import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The structural guards of stage 2 — the release that lets the lease suppress a
 * window's polling, and therefore the first stage where such a guard has to
 * *bound* a channel instead of proving one does not exist.
 *
 * Stage 1 could pin "the possibility of suppression does not exist": no import
 * in either direction, no export that could stop anything. Stage 2 needs the
 * opposite shape, and it is a smaller surface than it sounds:
 *
 * - exactly **one** module may be imported by `notifications/**` from the lease
 *   tree, and it is `leasePollingGate.ts` — a two-method type with no runtime
 *   export, no IO and no editor API, so the poller can ask the question without
 *   reaching the election's filesystem, decision table or timers;
 * - the supervisor still imports nothing that could reach a poller (§10.1.12's
 *   reverse guard, kept verbatim);
 * - the diagnostics dump's redaction rule is pinned in the source: the module
 *   that assembles it may not mention secret storage, an `Authorization`
 *   header, or an instance token at all;
 * - the setting and the command are contributed for real: `package.json` plus
 *   both `package.nls*` files, with the default stage 2 decided (`true`).
 *
 * Like the stage-0/1 guards, the source assertions are deliberately blunt
 * substring checks: they fail on a *mention*, because the point is that the
 * code path must not exist.
 */

const SRC_DIR = path.join(__dirname, '..');
const PACKAGE_ROOT = path.join(SRC_DIR, '..');
const NOTIFICATIONS_DIR = path.join(SRC_DIR, 'notifications');
const LEASE_DIR = path.join(SRC_DIR, 'lease');
const SUPERVISOR = path.join(LEASE_DIR, 'leaseSupervisor.ts');
const GATE = path.join(LEASE_DIR, 'leasePollingGate.ts');
const DIAGNOSTICS = path.join(LEASE_DIR, 'pollingDiagnostics.ts');
const DIAGNOSTICS_COMMAND = path.join(SRC_DIR, 'commands', 'copyPollingDiagnostics.ts');
const EXTENSION = path.join(SRC_DIR, 'extension.ts');

async function typescriptFilesUnder(directory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typescriptFilesUnder(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(SRC_DIR, file).replace(/\\/g, '/');
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('the lease reaches the poller through one door, and only one (§8, §11.1 stage 2)', () => {
  it('lets notifications import nothing from the lease tree but the gate type', async () => {
    const files = await typescriptFilesUnder(NOTIFICATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await fs.promises.readFile(file, 'utf8');
      const leaseImports = importSpecifiers(text).filter((specifier) => specifier.includes('lease'));
      for (const specifier of leaseImports) {
        expect(specifier, `${relative(file)} imports ${specifier}`).toBe('../lease/leasePollingGate');
      }
      // A type-only import is the whole point: the poller must not be able to
      // *construct* anything from the lease tree.
      if (leaseImports.length > 0) {
        expect(text, `${relative(file)} must import the gate as a type only`).toMatch(
          /import type \{[^}]*LeasePollingGate[^}]*\} from '\.\.\/lease\/leasePollingGate';/,
        );
      }
      // The election's own modules stay unreachable from here.
      expect(text, `${relative(file)} must not reach the supervisor or the store`).not.toMatch(
        /leaseSupervisor|leaseStore|leaseDecision|leaseConstants/,
      );
    }
  });

  it('is a contract with no runtime surface at all', async () => {
    const module = await import('../lease/leasePollingGate');
    // Nothing to call, nothing to hold: the gate cannot write, time out or
    // elect anyone, so "the poller consults the lease" stays a question.
    expect(Object.keys(module)).toEqual([]);
    const text = await fs.promises.readFile(GATE, 'utf8');
    expect(importSpecifiers(text)).toEqual([]);
    expect(text).not.toMatch(/from '(vscode|fs|crypto|path)'/);
    expect(text).not.toMatch(/setInterval|setTimeout|readFile|writeFile/);
  });

  it('exposes the gate and the election, and nothing that could quietly stop polling elsewhere', async () => {
    const module = await import('../lease/leaseSupervisor');
    expect(Object.keys(module).sort()).toEqual([
      'LEASE_ENABLED_SETTING',
      'LeaseSupervisor',
      'demotionReason',
      'disposePollingLease',
      'formatLeaseLogLine',
      'isMultiWindowLeaseEnabled',
      'startPollingLease',
      'takeoverReason',
      'vscodeWindowLeaseHost',
    ]);
    const text = await fs.promises.readFile(SUPERVISOR, 'utf8');
    expect(text).not.toMatch(/stopPolling|pausePolling|suppressNotification/i);
  });

  it('keeps the supervisor unable to reach a poller (the stage-1 reverse guard, unchanged)', async () => {
    const text = await fs.promises.readFile(SUPERVISOR, 'utf8');
    const allowed = new Set(['vscode', 'crypto', 'fs', 'path']);
    for (const specifier of importSpecifiers(text)) {
      if (specifier.startsWith('./')) {
        continue;
      }
      expect(allowed.has(specifier), `leaseSupervisor.ts imports an unexpected module: ${specifier}`).toBe(true);
    }
    expect(text).not.toMatch(/from '\.\.\/notifications/);
    expect(text).not.toMatch(/from '\.\.\/mcp/);
  });

  it('keeps every lease module out of notifications/', async () => {
    const files = await typescriptFilesUnder(LEASE_DIR);
    expect(files.map((file) => path.basename(file)).sort()).toEqual([
      'leaseConstants.ts',
      'leaseDecision.ts',
      'leaseDegradedNotice.ts',
      'leasePollingGate.ts',
      'leaseStore.ts',
      'leaseSupervisor.ts',
      'leaseTypes.ts',
      'pollingDiagnostics.ts',
    ]);
    for (const file of files) {
      const text = await fs.promises.readFile(file, 'utf8');
      expect(text, `${relative(file)} must not reach into notifications/`).not.toMatch(/from '\.\.\/notifications/);
    }
  });
});

describe('the activation site wires the mechanism, and nothing else does (§11.1 stage 2)', () => {
  it('starts the lease from extension.ts and nowhere else', async () => {
    const files = (await typescriptFilesUnder(SRC_DIR)).filter(
      (file) => !file.endsWith('.test.ts') && !file.startsWith(path.join(SRC_DIR, '__tests__')) && file !== SUPERVISOR,
    );
    const starters = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      // The *call*, not the import: the diagnostics command legitimately holds
      // the supervisor as a type, and must not be able to start one.
      return text.includes('startPollingLease(') || text.includes('disposePollingLease(');
    });
    expect(starters.map(relative)).toEqual(['extension.ts']);
  });

  it('feeds the record from the activation site and hands the gate to the poller', async () => {
    const text = await fs.promises.readFile(EXTENSION, 'utf8');
    const startCall = /startPollingLease\(\s*\{([\s\S]*?)\},\s*logger,?\s*\)/.exec(text)?.[1] ?? '';
    expect(startCall).toContain('appVersion: context.extension.packageJSON.version');
    expect(startCall).toMatch(/instanceIds: \(\) =>\s*config\.getInstances\(\)\.map\(\(instance\) => instance\.id\)/);
    expect(startCall).toContain('onDegraded:');
    // The gate is the supervisor itself, passed as the poller's fifth argument,
    // and the lease is started before the poller so the gate exists first.
    expect(text).toMatch(
      /new NotificationPoller\(\s*config,\s*viewProvider,\s*context,\s*logger,\s*leaseSupervisor,?\s*\)/,
    );
    expect(text.indexOf('startPollingLease(')).toBeLessThan(text.indexOf('new NotificationPoller('));
    expect(text).toContain('disposePollingLease(');
    // §7.1's notice and §11.1's diagnostics entry point are wired here too.
    expect(text).toContain('createLeaseDegradedNotifier(');
    expect(text).toContain('registerCopyPollingDiagnosticsCommand(');
    // The wiring may not reach for the store, the decision layer or the
    // constants directly: it starts the supervisor, notices and the command.
    expect(text).not.toMatch(/leaseStore|leaseDecision|leaseConstants|LeaseStore/);
  });

  it('never grows a second owner for the diagnostics command', async () => {
    const files = (await typescriptFilesUnder(SRC_DIR)).filter((file) => !file.endsWith('.test.ts'));
    const registrations = files.filter((file) =>
      fs.readFileSync(file, 'utf8').includes('registerCommand(COPY_POLLING_DIAGNOSTICS_COMMAND'),
    );
    expect(registrations.map(relative)).toEqual(['commands/copyPollingDiagnostics.ts']);
  });
});

describe('the diagnostics dump cannot carry a credential (§11.1 stage 2)', () => {
  /**
   * Comments are stripped first: the *rule* has to be documented in these
   * modules ("no `Authorization` header, no secret-storage value"), and the
   * assertion is about code. Everything that reaches the clipboard is code.
   */
  function code(file: string): string {
    const text = fs.readFileSync(file, 'utf8');
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('names no secret surface and no instance token in the modules that build it', () => {
    for (const file of [DIAGNOSTICS, DIAGNOSTICS_COMMAND]) {
      const text = code(file);
      expect(text, `${relative(file)} must not mention secret storage`).not.toMatch(/SecretStorage|secrets\./);
      // The header name reaches code as a string or a property, so that is what
      // is forbidden. (The lowercase word inside `containsCredentialField`'s
      // own pattern is the *detector* for credential-shaped field names — the
      // opposite of a violation — and a case-sensitive check allows it while
      // still failing on `'Authorization'`/`Authorization:`.)
      expect(text, `${relative(file)} must not name an authorization header`).not.toMatch(
        /['"]Authorization['"]|Authorization\s*:/,
      );
      expect(text, `${relative(file)} must not read an instance token`).not.toMatch(/\.token\b/);
      // And no "token exists" boolean either: the design's hard constraint.
      expect(text, `${relative(file)} must not report whether a token exists`).not.toMatch(
        /hasToken|tokenPresent|tokenExists/i,
      );
    }
  });

  it('redacts instance URLs with the existing rule, never with a second one', async () => {
    const text = await fs.promises.readFile(DIAGNOSTICS, 'utf8');
    expect(text).toContain("import { redactInstanceUrl } from '../api/versionProbe';");
    expect(text).toContain('url: redactInstanceUrl(instance.url)');
  });

  it('keeps the raw lease text out by construction', async () => {
    const text = await fs.promises.readFile(DIAGNOSTICS, 'utf8');
    // The payload declares it, and nothing reads the file's raw text: a
    // hand-edited lease file can hold anything, so its bytes never travel.
    expect(text).toContain('rawTextIncluded: false');
    expect(text).not.toMatch(/readFile/);
  });
});

describe('the setting and the command are contributed, not just implemented (§2.1, §11.1 stage 2)', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { type?: string; default?: unknown; description?: string }> };
      commands: { command: string; title: string }[];
    };
  };
  const nlsEn = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.nls.json'), 'utf8')) as Record<
    string,
    string
  >;
  const nlsZh = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.nls.zh-cn.json'), 'utf8')) as Record<
    string,
    string
  >;

  it('declares forgejoToolkit.multiWindowLease with the decided default', () => {
    const setting = packageJson.contributes.configuration.properties['forgejoToolkit.multiWindowLease'];
    expect(setting?.type).toBe('boolean');
    // §2 decision 6: default on, and the escape hatch is a one-line change.
    expect(setting?.default).toBe(true);
    expect(setting?.description).toBe('%config.multiWindowLease.description%');
  });

  it('ships the drafted bilingual description in both locale files', () => {
    const key = 'config.multiWindowLease.description';
    expect(nlsEn[key]).toBe(
      'Poll Forgejo instances and raise notification alerts from only one VS Code window at a time instead of every open window, handing that job to whichever window you are working in. The other windows stay quiet but still load notifications when you open the view. Turn this off to let every window poll and alert on its own, which uses more requests but is the behaviour before this setting existed.',
    );
    expect(nlsZh[key]).toBe(
      '同一时间只让一个 VS Code 窗口轮询 Forgejo 实例并弹出通知提示，并把这个角色交给你正在使用的窗口；其余窗口保持安静，但手动打开通知视图时仍会即时读取。关闭后每个窗口各自轮询与提示——请求更多，但那是此设置存在之前的行为。',
    );
  });

  it('contributes the diagnostics command with a title in both locales', () => {
    const command = packageJson.contributes.commands.find(
      (entry) => entry.command === 'forgejoToolkit.copyPollingDiagnostics',
    );
    expect(command?.title).toBe('%command.copyPollingDiagnostics.title%');
    for (const bundle of [nlsEn, nlsZh]) {
      expect((bundle['command.copyPollingDiagnostics.title'] ?? '').trim()).not.toBe('');
    }
  });
});
