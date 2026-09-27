// Launch an isolated VS Code Extension Development Host with CDP enabled.
// Isolated profile (--user-data-dir/--extensions-dir) so the user's own VS Code
// is never touched, and Chromium flags actually apply (a shared instance would
// swallow --remote-debugging-port).
//
// Usage: node --import tsx src/launch.ts [workspacePath]   (default: D:\code\test)
//
// This stays the one-profile-per-launch model. A second window *of that same
// profile* is a different thing — see src/dual.ts (design doc §10.2/§12.7).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultLaunchConfig, launchArgs, seedProfileSettings } from './config';
import { cdpVersionUrl } from './windows';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const config = defaultLaunchConfig(HARNESS_DIR, process.argv[2]);

fs.mkdirSync(config.profileDir, { recursive: true });
fs.mkdirSync(config.extensionsDir, { recursive: true });
seedProfileSettings(config.profileDir);

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
