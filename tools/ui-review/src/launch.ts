// Launch an isolated VS Code Extension Development Host with CDP enabled.
// Isolated profile (--user-data-dir/--extensions-dir) so the user's own VS Code
// is never touched, and Chromium flags actually apply (a shared instance would
// swallow --remote-debugging-port).
//
// Usage: node --import tsx src/launch.ts [workspacePath]   (default: D:\code\test)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(HERE, '..', '..');
const PROFILE = path.join(HERE, 'profile');
const EXTS = path.join(HERE, 'extensions');
const EXTENSION_DEV = path.join(ROOT, 'packages', 'forgejo-toolkit');
const WORKSPACE = process.argv[2] || 'D:\\code\\test';
const PORT = Number(process.env.CDP_PORT || 9222);
// Optional UI locale for screenshot runs (e.g. UI_LOCALE=zh-cn). Requires the
// matching language pack in the isolated extensions dir.
const LOCALE = process.env.UI_LOCALE;

fs.mkdirSync(path.join(PROFILE, 'User'), { recursive: true });
fs.mkdirSync(EXTS, { recursive: true });

// Pre-seed settings: enable the MSW mock API so the UI works offline.
const settingsPath = path.join(PROFILE, 'User', 'settings.json');
const settings: Record<string, unknown> = fs.existsSync(settingsPath)
  ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
  : {};
settings['forgejoToolkit.useMockApi'] ??= true;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

const args = [
  `--user-data-dir=${PROFILE}`,
  `--extensions-dir=${EXTS}`,
  `--extensionDevelopmentPath=${EXTENSION_DEV}`,
  `--remote-debugging-port=${PORT}`,
  '--new-window',
  '--skip-welcome',
  '--skip-release-notes',
  ...(LOCALE ? [`--locale=${LOCALE}`] : []),
  WORKSPACE,
];

const child = spawn('code', args, { detached: true, stdio: 'ignore', shell: true });
child.unref();

// Wait for the CDP endpoint.
const deadline = Date.now() + 30_000;
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
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
