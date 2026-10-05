// The dev-host launch configuration, shared by `launch.ts` (one isolated profile
// per launch) and `dual.ts` (that same launch, then a second window of the same
// profile). Keeping it in one place is what makes "the dual-window mode is the
// same first window as today" checkable instead of a copy that can drift.
import fs from 'node:fs';
import path from 'node:path';
import { AI_MOCK_MODEL_ID, AI_MOCK_MODEL_NAME } from './aiMockServer';
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

/**
 * The provider id `--ai-mock` seeds, and the binding it writes. The *model* id is
 * not repeated here: it is `aiMockServer.ts`'s `AI_MOCK_MODEL_ID`, because the
 * endpoint that answers and the profile that names it must not be able to drift.
 */
export const AI_MOCK_PROVIDER_ID = 'ui-review-mock';

/** The provider's display name in the consent sentence, the log and the settings page. */
export const AI_MOCK_PROVIDER_NAME = 'Local mock endpoint (tools/ui-review)';

/**
 * What an `--ai-mock` launch writes into the profile so the dev host can reach the
 * local endpoint without anyone editing a file by hand.
 *
 * **No credential is written, here or anywhere else.** The endpoint needs no auth
 * (`auth: 'none'`), so there is nothing to seed: a key could only live in the
 * editor's `SecretStorage`, which is not a file this harness may write, and a
 * provider whose key is missing would refuse every run. A key typed into the
 * settings page by hand (an obvious dummy, see the README) still works — the mock
 * endpoint accepts any `Authorization` header and never looks at it.
 */
export interface AiEndpointSeed {
  /** The endpoint's base URL, used as written (the transport trims a trailing slash). */
  baseUrl: string;
  providerId?: string;
  providerName?: string;
  modelId?: string;
  modelName?: string;
}

/**
 * Pre-seed settings so the walkthroughs work offline (mock API on by default).
 *
 * `useMockApi` is only seeded when it is absent (`??=`), exactly as before. The
 * one thing that overrides it is an explicit `--real-api` run, which pins it to
 * `false`: the opt-in has to actually take effect, or a mock-inclusive build
 * would intercept the requests the operator just asked to send for real. The
 * caller says which mode it is (`seedProfileSettings(dir, { useMockApi })`) so
 * the profile always describes the run it was last used for.
 *
 * `aiEndpoint` is additive and orthogonal to that switch: it points the AI
 * transport at a local endpoint (see {@link AiEndpointSeed}). It is written as the
 * settings the extension itself reads, and it touches only entries this harness
 * owns — another provider, or another feature's binding, is left exactly as it was
 * — so a profile that also holds a real endpoint keeps it.
 */
export function seedProfileSettings(
  profileDir: string,
  options: { useMockApi?: boolean; aiEndpoint?: AiEndpointSeed } = {},
): void {
  const userDir = path.join(profileDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, 'settings.json');
  const settings: Record<string, unknown> = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
    : {};
  if (options.useMockApi === undefined) {
    settings['forgejoToolkit.useMockApi'] ??= true;
  } else {
    settings['forgejoToolkit.useMockApi'] = options.useMockApi;
  }
  if (options.aiEndpoint !== undefined) {
    seedAiEndpointSettings(settings, options.aiEndpoint);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/** The entries one {@link AiEndpointSeed} becomes, merged into an existing settings object. */
function seedAiEndpointSettings(settings: Record<string, unknown>, seed: AiEndpointSeed): void {
  const providerId = seed.providerId ?? AI_MOCK_PROVIDER_ID;
  const modelId = seed.modelId ?? AI_MOCK_MODEL_ID;
  const provider = {
    id: providerId,
    name: seed.providerName ?? AI_MOCK_PROVIDER_NAME,
    baseUrl: seed.baseUrl,
    models: [{ id: modelId, name: seed.modelName ?? AI_MOCK_MODEL_NAME }],
    // The mock endpoint authenticates nothing. `none` is what keeps every
    // credential out of this file and out of the run.
    auth: 'none',
    headers: [],
    // True, and it holds: the endpoint binds the loopback address only. Writing it
    // also exercises the provider-level half of the local-only policy.
    localOnly: true,
  };

  const providers = Array.isArray(settings['forgejoToolkit.aiProviders'])
    ? (settings['forgejoToolkit.aiProviders'] as unknown[])
    : [];
  settings['forgejoToolkit.aiProviders'] = [
    ...providers.filter((entry) => (entry as { id?: unknown } | null)?.id !== providerId),
    provider,
  ];

  // The egress switch is off by default and a configured endpoint is not enabled by
  // configuration alone, so the run would refuse without this.
  settings['forgejoToolkit.aiProvidersEnabled'] = true;
  // The binding decides on its own (it is the most specific statement there is);
  // the transport choice is written beside it so the profile also says which route
  // is wanted if the binding is ever removed.
  settings['forgejoToolkit.aiTransport'] = 'openai-compatible';
  settings['forgejoToolkit.aiPreReview'] = true;

  const bindings = Array.isArray(settings['forgejoToolkit.aiModelBindings'])
    ? (settings['forgejoToolkit.aiModelBindings'] as unknown[])
    : [];
  settings['forgejoToolkit.aiModelBindings'] = [
    ...bindings.filter((entry) => (entry as { feature?: unknown } | null)?.feature !== 'aiPreReview'),
    { feature: 'aiPreReview', providerId, modelId },
  ];

  // `forgejoToolkit.aiPreReviewPromptScope` is deliberately **not** written: its
  // default `ask` is the consent question the walkthrough is about, and seeding an
  // answer would skip the one step a human has to perform.
}

/** The profile's `forgejoToolkit.useMockApi`, or `undefined` when it is not set. */
export function readMockApiSetting(profileDir: string): boolean | undefined {
  const settingsPath = path.join(profileDir, 'User', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const value = settings['forgejoToolkit.useMockApi'];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The extension id, which is also its `globalStorage` directory name. */
export const EXTENSION_ID = 'cpf23333.forgejo-toolkit';

/** A configured instance as far as the launcher may print it: **no token**. */
export interface ConfiguredInstance {
  id: string;
  url: string;
  name?: string;
}

/**
 * The instances the profile has configured, read from the extension's own
 * `mcp-instances.json` (the same stable-path file the MCP shim consumes).
 *
 * Only `id`, `url` and `name` are copied out — never the whole record — because
 * this value is printed in the launcher's warning and a token must not be able
 * to reach the log through it (the file carries none today, and that must not
 * become load-bearing).
 */
export function readConfiguredInstances(profileDir: string): ConfiguredInstance[] {
  const file = path.join(profileDir, 'User', 'globalStorage', EXTENSION_ID, 'mcp-instances.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list = (parsed as { instances?: unknown }).instances;
  if (!Array.isArray(list)) return [];
  const instances: ConfiguredInstance[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.url !== 'string') continue;
    instances.push({
      id: record.id,
      url: record.url,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
    });
  }
  return instances;
}

export function logsRootFor(config: LaunchConfig): string {
  return path.join(config.profileDir, 'logs');
}
