// Launch an isolated VS Code Extension Development Host with CDP enabled.
// Isolated profile (--user-data-dir/--extensions-dir) so the user's own VS Code
// is never touched, and Chromium flags actually apply (a shared instance would
// swallow --remote-debugging-port).
//
// Usage: node --import tsx src/launch.ts [workspacePath] [--real-api]   (default workspace: D:\code\test)
//
// `--real-api` is the explicit opt-in for a run against the real instance(s)
// configured in the profile. Without it, a build that has no mock API compiled in
// is refused before anything is started — see src/apiMode.ts.
//
// This stays the one-profile-per-launch model. A second window *of that same
// profile* is a different thing — see src/dual.ts (design doc §10.2/§12.7).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultLaunchConfig,
  launchArgs,
  readConfiguredInstances,
  readMockApiSetting,
  seedProfileSettings,
} from './config';
import { flagBool, parseArgs } from './cliArgs';
import { buildDirFor, requireApiMode } from './apiMode';
import { cdpVersionUrl } from './windows';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const parsed = parseArgs(process.argv.slice(2), { value: [], boolean: ['--real-api'] });
const config = defaultLaunchConfig(HARNESS_DIR, parsed.positional[0]);

// Asked before anything is created or spawned: a build without the mock API would
// otherwise poll the profile's real instance without the operator saying so.
const mode = requireApiMode({
  buildDir: buildDirFor(config.extensionDevDir),
  profileDir: config.profileDir,
  instances: readConfiguredInstances(config.profileDir),
  mockApiSetting: readMockApiSetting(config.profileDir),
  realApiRequested: flagBool(parsed, '--real-api'),
});

fs.mkdirSync(config.profileDir, { recursive: true });
fs.mkdirSync(config.extensionsDir, { recursive: true });
seedProfileSettings(config.profileDir, { useMockApi: mode === 'mock' });

const child = spawn('code', launchArgs(config), { detached: true, stdio: 'ignore', shell: true });
child.unref();

// Wait for the CDP endpoint.
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    const res = await fetch(cdpVersionUrl(config.cdpPort));
    if (res.ok) {
      console.log('CDP ready:', await res.text());
      break;
    }
  } catch {}
  if (Date.now() > deadline) {
    console.error('Timed out waiting for CDP endpoint');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
