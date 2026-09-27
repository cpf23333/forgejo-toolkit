import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The structural half of the stage-1 shadow invariant, plus the reverse guards
 * §10.1.12 asks for.
 *
 * The behavioural half — every decision, `step-down` and `yield` and
 * `degraded-to-full-speed` included, still logs `polling=unchanged` — lives in
 * `leaseSupervisor.test.ts`. What is pinned here is that the *possibility* of
 * suppression does not exist yet: no channel from the lease to the poller in
 * either direction, no export that could stop anything, and exactly one place
 * that starts the supervisor.
 *
 * Like the stage-0 guards, the source assertions are deliberately blunt
 * substring checks: they fail on a mention, because the point is that the code
 * path must not exist.
 */

const SRC_DIR = path.join(__dirname, '..');
const NOTIFICATIONS_DIR = path.join(SRC_DIR, 'notifications');
const LEASE_DIR = path.join(SRC_DIR, 'lease');
const SUPERVISOR = path.join(LEASE_DIR, 'leaseSupervisor.ts');
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

describe('the lease still cannot stop a window from polling (§11.1 stage 1)', () => {
  it('is not imported by anything under notifications/ yet', async () => {
    const files = await typescriptFilesUnder(NOTIFICATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await fs.promises.readFile(file, 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of imports) {
        expect(specifier.includes('lease'), `${relative(file)} imports ${specifier}`).toBe(false);
      }
      expect(text, `${relative(file)} must not mention the lease at all`).not.toMatch(/leaseSupervisor|leaseDecision/);
    }
  });

  it('is started from extension.ts and nowhere else', async () => {
    const files = (await typescriptFilesUnder(SRC_DIR)).filter(
      (file) => !file.endsWith('.test.ts') && !file.startsWith(path.join(SRC_DIR, '__tests__')) && file !== SUPERVISOR,
    );
    const starters = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return text.includes("from './lease/leaseSupervisor'") || text.includes("from '../lease/leaseSupervisor'");
    });
    expect(starters.map(relative)).toEqual(['extension.ts']);
  });

  it('imports nothing that could reach a poller', async () => {
    const text = await fs.promises.readFile(SUPERVISOR, 'utf8');
    const allowed = new Set(['vscode', 'crypto', 'fs', 'path']);
    for (const specifier of [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')) {
      if (specifier.startsWith('./')) {
        continue;
      }
      expect(allowed.has(specifier), `leaseSupervisor.ts imports an unexpected module: ${specifier}`).toBe(true);
    }
    expect(text).not.toMatch(/from '\.\.\/notifications/);
    expect(text).not.toMatch(/from '\.\.\/mcp/);
  });

  it('exposes no API that could suppress anything', async () => {
    // A new export is how a "stop polling" surface would arrive. The allowlist
    // is the stage-1 contract; adding to it is a deliberate act, and the
    // behavioural sweep has to pass with it.
    const module = await import('../lease/leaseSupervisor');
    expect(Object.keys(module).sort()).toEqual([
      'LeaseShadowSupervisor',
      'disposeLeaseShadowMode',
      'formatLeaseShadowLine',
      'startLeaseShadowMode',
      'vscodeWindowLeaseHost',
    ]);
    const text = await fs.promises.readFile(SUPERVISOR, 'utf8');
    // The pure layer's "does this decision poll locally?" helper is the one
    // function a stage-2 wiring will consume; stage 1 must not look at it.
    expect(text).not.toMatch(/decisionPollsLocally/);
    expect(text).not.toMatch(/stopPolling|pausePolling|suppressNotification/i);
  });

  it('leaves extension.ts with the start and dispose calls and nothing else', async () => {
    const text = await fs.promises.readFile(EXTENSION, 'utf8');
    const leaseImports = [...text.matchAll(/from '([^']*lease[^']*)'/g)].map((match) => match[1] ?? '');
    expect(leaseImports).toEqual(['./lease/leaseSupervisor']);
    expect(text).toContain('startLeaseShadowMode(');
    expect(text).toContain('disposeLeaseShadowMode(');
    // The wiring may not reach for the store, the decision layer or the
    // constants directly: it only starts and disposes the supervisor.
    expect(text).not.toMatch(/leaseStore|leaseDecision|leaseConstants|LeaseStore/);
  });

  it('feeds the record from the activation site: the running version and the config instance ids', async () => {
    // §3.2/§3.3: the record's `appVersion` and `instancesFingerprint` come from
    // the one place that has the extension context and the config manager, so
    // the lease module never invents a second notion of either.
    const text = await fs.promises.readFile(EXTENSION, 'utf8');
    const startCall = /startLeaseShadowMode\(\s*\{([\s\S]*?)\},\s*logger,?\s*\)/.exec(text)?.[1] ?? '';
    expect(startCall).toContain('appVersion: context.extension.packageJSON.version');
    expect(startCall).toMatch(/instanceIds: \(\) =>\s*config\.getInstances\(\)\.map\(\(instance\) => instance\.id\)/);
  });

  it('keeps the lease module and the notification module graph apart', async () => {
    const files = await typescriptFilesUnder(LEASE_DIR);
    expect(files.map((file) => path.basename(file)).sort()).toEqual([
      'leaseConstants.ts',
      'leaseDecision.ts',
      'leaseStore.ts',
      'leaseSupervisor.ts',
      'leaseTypes.ts',
    ]);
    for (const file of files) {
      const text = await fs.promises.readFile(file, 'utf8');
      expect(text, `${relative(file)} must not reach into notifications/`).not.toMatch(/from '\.\.\/notifications/);
    }
  });
});
