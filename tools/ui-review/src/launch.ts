// Launch an isolated VS Code Extension Development Host with CDP enabled.
// Isolated profile (--user-data-dir/--extensions-dir) so the user's own VS Code
// is never touched, and Chromium flags actually apply (a shared instance would
// swallow --remote-debugging-port).
//
// Usage: node --import tsx src/launch.ts [workspacePath] [--real-api] [--ai-mock]   (default workspace: D:\code\test)
//
// `--real-api` is the explicit opt-in for a run against the real instance(s)
// configured in the profile. Without it, a build that has no mock API compiled in
// is refused before anything is started — see src/apiMode.ts.
//
// `--ai-mock` starts the harness's own local OpenAI-compatible endpoint
// (src/aiMockServer.ts) and points the profile's AI settings at it, so the second
// model transport can be walked end to end over a real socket. It is orthogonal to
// `--real-api`: one is about the Forgejo API, the other about the model endpoint.
//
// This stays the one-profile-per-launch model. A second window *of that same
// profile* is a different thing — see src/dual.ts (design doc §10.2/§12.7).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_MOCK_PROVIDER_ID,
  defaultLaunchConfig,
  launchArgs,
  readConfiguredInstances,
  readMockApiSetting,
  seedProfileSettings,
  type AiEndpointSeed,
} from './config';
import { flagBool, flagNumber, parseArgs } from './cliArgs';
import { buildDirFor, requireApiMode } from './apiMode';
import { AI_MOCK_MODEL_ID, AI_MOCK_SCENARIOS } from './aiMockServer';
import { startAiMockServerForLaunch } from './aiMockRun';
import { cdpVersionUrl } from './windows';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
const parsed = parseArgs(process.argv.slice(2), {
  value: ['--ai-mock-port'],
  boolean: ['--real-api', '--ai-mock'],
});
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

// Started before the profile is written, because the profile has to name the port
// the endpoint actually bound — the whole point of asking for port 0 is that
// nobody knows it in advance.
let aiEndpoint: AiEndpointSeed | undefined;
if (flagBool(parsed, '--ai-mock')) {
  const { state, reused } = await startAiMockServerForLaunch({
    harnessDir: HARNESS_DIR,
    port: flagNumber(parsed, '--ai-mock-port', 0),
  });
  aiEndpoint = { baseUrl: `${state.url}/v1` };
  console.log(
    `AI mock endpoint: ${reused ? 'reusing the one already running at ' : ''}${state.url} (pid ${state.pid})`,
  );
  console.log(
    `  profile: provider "${AI_MOCK_PROVIDER_ID}" -> ${state.url}/v1, model "${AI_MOCK_MODEL_ID}", ` +
      'auth "none" (no credential is written anywhere)',
  );
  console.log(
    `  its log: ${state.logFile}   read it back: pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock requests`,
  );
  console.log(
    `  scenarios: ${AI_MOCK_SCENARIOS.join(', ')} (append "?scenario=NAME" to the base URL in the settings page)`,
  );
  console.log(`  stop it with 'pnpm kill' (stops the dev host too) or 'ai-mock stop'`);
}
seedProfileSettings(config.profileDir, {
  useMockApi: mode === 'mock',
  ...(aiEndpoint === undefined ? {} : { aiEndpoint }),
});

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
