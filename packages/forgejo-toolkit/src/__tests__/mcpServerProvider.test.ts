import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  registerMcpServerProvider,
  MCP_ENABLED_SETTING,
  MCP_SERVER_DEFINITION_PROVIDER_ID,
  MCP_ENV_BROKER_ONLY,
  MCP_ENV_INSTANCE_ID,
  MCP_ENV_INSTANCE_URL,
  MCP_ENV_PROXY,
  MCP_ENV_STATE_FILE,
  MCP_ENV_SYNC_API_URLS,
} from '../mcpServerProvider';
import {
  mcpInstanceRegistryFilePath,
  mcpServerShimFilePath,
  mcpWorkspaceStateFilePath,
  whenMcpStateWritesSettled,
} from '../mcpWorkspaceState';
import type { ConfigManager } from '../config';
import type { ForgejoInstance } from '../config';
import type { Logger } from '../logger';
import { MCP_ENV_WRITE_TOOLS } from '../../mcp/writeTools';

/**
 * A registration file for the broker this setup pretends to have started.
 * Written into the context's globalStorage, which is where the provider looks
 * (the real reader checks the recorded pid with `process.kill(pid, 0)`, and
 * `process.pid` is by definition alive, so a fake registration is enough to
 * make the provider publish definitions).
 *
 * Pids that are certainly dead are hard to produce portably, so the
 * unavailable-broker cases point `FORGEJO_MCP_DATA_DIR` at a directory with no
 * registration at all instead of at a dead pid.
 */
const BROKER_REGISTRATION_FILE = 'mcp-broker.json';

// The broker binds a real endpoint (a named pipe or a unix socket), so it is
// replaced here: what the provider must be shown to control is *when* it is
// started and stopped, not what it does when it runs.
const brokerMocks = vi.hoisted(() => ({
  startMcpBrokerIfFirst: vi.fn(() => Promise.resolve()),
  cleanupMcpBroker: vi.fn(() => Promise.resolve()),
}));
vi.mock('../mcpBroker', () => brokerMocks);

interface CapturedDefinition {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Every test setup leaves a fake broker registration behind so the provider
 * publishes definitions — the interesting subject of most of these tests. A
 * test that wants the "no broker" behaviour removes it (see
 * `removeBrokerRegistration`).
 */
function writeBrokerRegistration(context: { globalStorageUri: { fsPath: string } }): void {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  fs.writeFileSync(
    path.join(context.globalStorageUri.fsPath, BROKER_REGISTRATION_FILE),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      endpoint: process.platform === 'win32' ? '\\\\.\\pipe\\forgejo-toolkit-test-broker' : '/tmp/fake.sock',
      authToken: 'broker-handshake-secret',
      startedAt: new Date(0).toISOString(),
    }),
    'utf8',
  );
}

function removeBrokerRegistration(context: { globalStorageUri: { fsPath: string } }): void {
  fs.rmSync(path.join(context.globalStorageUri.fsPath, BROKER_REGISTRATION_FILE), { force: true });
}

/** Every context a setup() produced, drained (disposed) by afterEach. */
const createdContexts: { subscriptions: { dispose(): unknown }[] }[] = [];

const SHARED_GLOBAL_STORAGE = path.join(os.tmpdir(), `forgejo-mcp-provider-test-${process.pid}`);

/**
 * Points the (mocked) configuration at one value of the MCP switch. The proxy
 * read in provideMcpServerDefinitions goes through the same mock and must stay
 * unset.
 */
function setMcpEnabled(value: boolean): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string) => (key === 'mcpEnabled' ? value : undefined),
    update: vi.fn(),
  } as never);
}

/** Fires the configuration change event the way VS Code reports a settings edit. */
function changeSetting(
  configurationListener: ((event: import('vscode').ConfigurationChangeEvent) => unknown) | undefined,
  section: string,
): void {
  configurationListener?.({ affectsConfiguration: (candidate: string) => candidate === section } as never);
}

function setup(options: { mcpEnabled?: boolean; getterSubscriptions?: boolean } = {}) {
  const registerSpy = vi.fn((_id: string, _provider: import('vscode').McpServerDefinitionProvider) => ({
    dispose: vi.fn(),
  }));
  (vscode as unknown as { lm: unknown }).lm = { registerMcpServerDefinitionProvider: registerSpy };
  (vscode as unknown as { McpStdioServerDefinition: unknown }).McpStdioServerDefinition = class {
    constructor(
      public label: string,
      public command: string,
      public args: string[],
      public env: Record<string, string>,
    ) {}
  };

  const instanceListeners: ((instances: ForgejoInstance[]) => void)[] = [];
  // The dispose handle of each onInstancesChanged subscription, so a test can
  // tell "the listener was unregistered" from "it is still attached".
  const instanceListenerDisposals: ReturnType<typeof vi.fn>[] = [];
  const instances: ForgejoInstance[] = [];
  const config = {
    getInstances: () => instances,
    onInstancesChanged: (listener: (value: ForgejoInstance[]) => void) => {
      instanceListeners.push(listener);
      const dispose = vi.fn();
      instanceListenerDisposals.push(dispose);
      return { dispose };
    },
  } as unknown as ConfigManager;

  const contextSubscriptions: { dispose(): unknown }[] = [];
  const context = (options.getterSubscriptions
    ? // The real ExtensionContext exposes `subscriptions` as a getter-only
      // accessor, which is what the child context in startMcpSurface has to
      // work around. A plain writable array here would hide that.
      Object.defineProperty(
        {
          extensionUri: { fsPath: '/ext' },
          globalStorageUri: { fsPath: SHARED_GLOBAL_STORAGE },
        },
        'subscriptions',
        { get: () => contextSubscriptions, configurable: false, enumerable: true },
      )
    : {
        subscriptions: contextSubscriptions,
        extensionUri: { fsPath: '/ext' },
        // A real (writable) directory: the workspace-state sync this
        // registration starts writes its file here when a test fires a
        // trigger or lets the cold-start timer run.
        globalStorageUri: { fsPath: SHARED_GLOBAL_STORAGE },
      }) as unknown as import('vscode').ExtensionContext;
  createdContexts.push(context);

  const logger = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;

  if (options.mcpEnabled !== undefined) {
    setMcpEnabled(options.mcpEnabled);
  }
  // Written before registration, so the provider's own check (and every
  // resolution a test makes) sees a reachable broker. A test that is *about*
  // the missing broker removes it afterwards.
  writeBrokerRegistration(context);
  const configListenerCalls = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.length;
  registerMcpServerProvider(context, config, logger);
  const provider = registerSpy.mock.calls[0]?.[1] as import('vscode').McpServerDefinitionProvider;
  // The listener this call registered, not one left over from another setup().
  const configurationListener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[
    configListenerCalls
  ]?.[0];
  return {
    registerSpy,
    provider,
    instanceListeners,
    instanceListenerDisposals,
    instances,
    configurationListener,
    logger,
    context,
  };
}

function makeInstance(overrides: Partial<ForgejoInstance> = {}): ForgejoInstance {
  return {
    id: 'instance-1',
    url: 'https://forgejo.example.com',
    token: 'secret-token',
    name: 'Example',
    username: 'demo-user',
    ...overrides,
  };
}

describe('registerMcpServerProvider', () => {
  beforeEach(() => {
    vi.mocked(vscode.EventEmitter).mockClear();
    brokerMocks.startMcpBrokerIfFirst.mockClear();
    brokerMocks.cleanupMcpBroker.mockClear();
  });

  it('starts the surface on a context whose subscriptions is a getter, like the real one', () => {
    // VS Code's ExtensionContext exposes `subscriptions` as a getter-only
    // accessor, so assigning through the child context's prototype chain threw
    // `Cannot assign to read only property` in strict mode and took the whole
    // activation with it: the state sync and the broker are registered after
    // that point, and in a real window nothing MCP-related ever started.
    const { registerSpy } = setup({ getterSubscriptions: true });

    // Registration is the last thing the surface does, so reaching it proves the
    // child context was built and everything before it ran.
    expect(registerSpy).toHaveBeenCalled();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // A test that replaced the proxy configuration mock must not leak it into
    // the next setup().
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update: vi.fn() } as never);
    for (const context of createdContexts.splice(0)) {
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    }
    // The workspace-state sync writes into this real directory when a test
    // fires a trigger; do not leave the files behind. The registry write is
    // eager (fired at registration, no debounce), so the removal must first
    // wait out the in-flight write: its still-open `.part` handle makes a
    // directory removal fail with EPERM on Windows, and retrying only narrows
    // the race instead of closing it.
    await whenMcpStateWritesSettled();
    fs.rmSync(SHARED_GLOBAL_STORAGE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('registers the provider under the contributed id', () => {
    const { registerSpy } = setup();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy.mock.calls[0][0]).toBe(MCP_SERVER_DEFINITION_PROVIDER_ID);
  });

  it('does not register the provider while forgejoToolkit.mcpEnabled is off', () => {
    // The setting is the user's way of taking the whole MCP surface away from
    // clients; a definition provider that is never registered cannot hand one
    // out, and the contributed provider id simply stays unresolved.
    const { registerSpy, configurationListener } = setup({ mcpEnabled: false });

    expect(registerSpy).not.toHaveBeenCalled();
    expect(configurationListener).toBeDefined();
  });

  it('does no MCP work at all while off: no broker, no workspace state, no registry, no shim', async () => {
    const { context, instanceListeners, instances } = setup({ mcpEnabled: false });
    instances.push(makeInstance());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // "Not registered" must mean the supporting work is skipped too: the
    // registry and the shim are what a statically launched (third-party MCP
    // client) process discovers, and the state file is what answers
    // get_workspace_repository for it.
    expect(brokerMocks.startMcpBrokerIfFirst).not.toHaveBeenCalled();
    expect(instanceListeners).toHaveLength(0);
    await whenMcpStateWritesSettled();
    expect(fs.existsSync(mcpInstanceRegistryFilePath(context))).toBe(false);
    expect(fs.existsSync(mcpServerShimFilePath(context))).toBe(false);
    expect(fs.existsSync(mcpWorkspaceStateFilePath(context))).toBe(false);
  });

  it('maintains the broker, the registry and the shim while enabled', async () => {
    // The counterpart of the assertion above: with the switch on, the files do
    // appear — otherwise "absent while disabled" would pass for the wrong
    // reason.
    const { context, instances } = setup();
    instances.push(makeInstance());

    await whenMcpStateWritesSettled();

    expect(brokerMocks.startMcpBrokerIfFirst).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(mcpInstanceRegistryFilePath(context))).toBe(true);
    expect(fs.existsSync(mcpServerShimFilePath(context))).toBe(true);
  });

  it('withdraws the registration when the setting is turned off, and restores it when turned back on', async () => {
    const { registerSpy, configurationListener, instanceListenerDisposals } = setup();
    const registration = registerSpy.mock.results[0].value as { dispose: ReturnType<typeof vi.fn> };
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(instanceListenerDisposals).toHaveLength(2);

    setMcpEnabled(false);
    changeSetting(configurationListener, MCP_ENABLED_SETTING);

    expect(registration.dispose).toHaveBeenCalledTimes(1);
    // The supporting surface goes with it: the instance listeners that feed
    // the definitions and the state file are unregistered, and the broker
    // stops forwarding authenticated sessions.
    expect(instanceListenerDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(brokerMocks.cleanupMcpBroker).toHaveBeenCalledTimes(1);

    // ...and turning it back on needs no window reload: a fresh registration
    // plus a fresh broker are created.
    setMcpEnabled(true);
    changeSetting(configurationListener, MCP_ENABLED_SETTING);
    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(brokerMocks.startMcpBrokerIfFirst).toHaveBeenCalledTimes(2);
  });

  it('leaves the registration alone when an unrelated setting changes', () => {
    const { registerSpy, configurationListener } = setup();
    const registration = registerSpy.mock.results[0].value as { dispose: ReturnType<typeof vi.fn> };

    changeSetting(configurationListener, 'forgejoToolkit.notificationPollingEnabled');

    expect(registration.dispose).not.toHaveBeenCalled();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(brokerMocks.cleanupMcpBroker).not.toHaveBeenCalled();
  });

  it('skips registration on an editor without the MCP definition API instead of failing activation', () => {
    // VS Code forks are not required to implement vscode.lm: a missing API
    // must skip only the registration — the workspace-state sync the
    // static-config path consumes still starts, and activation survives.
    (vscode as unknown as { lm: unknown }).lm = undefined;
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      extensionUri: { fsPath: '/ext' },
      globalStorageUri: { fsPath: SHARED_GLOBAL_STORAGE },
    } as unknown as import('vscode').ExtensionContext;
    createdContexts.push(context);
    const config = {
      getInstances: () => [],
      onInstancesChanged: () => ({ dispose: vi.fn() }),
    } as unknown as ConfigManager;
    const logger = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;

    expect(() => registerMcpServerProvider(context, config, logger)).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('no MCP server definition API'));
  });

  it('returns no definitions when no instance is configured', async () => {
    const { provider } = setup();
    const definitions = await provider.provideMcpServerDefinitions(new AbortController().signal as never);
    expect(definitions).toEqual([]);
  });

  it('registers one definition per token-bearing instance', async () => {
    const { provider, instances } = setup();
    instances.push(
      makeInstance(),
      makeInstance({ id: 'instance-2', url: 'https://other.example.com', name: 'Other', token: 'second-token' }),
    );

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(2);
    const [first, second] = definitions;
    expect(first.command).toBe(process.execPath);
    expect(first.args[0]).toContain('mcp-server.mjs');
    expect(first.env[MCP_ENV_INSTANCE_URL]).toBe('https://forgejo.example.com');
    expect(first.env[MCP_ENV_INSTANCE_ID]).toBe('instance-1');
    // The definition says which instance its session is for and that the
    // extension host — not this child — holds the credential; the credential
    // itself is not part of the definition at all.
    expect(first.env[MCP_ENV_BROKER_ONLY]).toBe('true');
    expect(first.label).toBe('Forgejo: Example');
    expect(second.env[MCP_ENV_INSTANCE_URL]).toBe('https://other.example.com');
    expect(second.env[MCP_ENV_INSTANCE_ID]).toBe('instance-2');
    expect(second.label).toBe('Forgejo: Other');
  });

  it('hands VS Code a definition that contains no stored token anywhere', async () => {
    // The reason this matters is not hygiene, it is where the definition goes:
    // VS Code persists every registered definition — `env` included — in the
    // profile's workspace storage (state.vscdb), so a token in this struct is a
    // token at rest in cleartext beside SecretStorage. The whole definition is
    // therefore searched, not one field of it: a future change that smuggles
    // the secret into a label, an argument or a differently named variable has
    // to fail here, not only in a review.
    const { provider, instances } = setup();
    instances.push(
      makeInstance({ token: 'secret-token' }),
      makeInstance({ id: 'instance-2', url: 'https://other.example.com', token: 'second-token', username: 'bob' }),
    );

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(2);
    for (const [index, definition] of definitions.entries()) {
      const serialized = JSON.stringify(definition);
      const expectedToken = index === 0 ? 'secret-token' : 'second-token';
      expect(serialized).not.toContain(expectedToken);
      // The other instance's token must not leak either, and neither may the
      // token variable itself: an empty FORGEJO_MCP_TOKEN would still invite a
      // future fill-in, and the child must not be handed a token channel here.
      expect(serialized).not.toContain(index === 0 ? 'second-token' : 'secret-token');
      expect(serialized).not.toContain('FORGEJO_MCP_TOKEN');
      expect(Object.keys(definition.env)).not.toContain('FORGEJO_MCP_TOKEN');
      expect(Object.values(definition.env).some((value) => value.includes('token'))).toBe(false);
    }
  });

  it('withholds every definition while no broker is running, because no definition carries a token', async () => {
    // The failure direction this pins: with the broker gone there is no
    // authenticated route left, and the two alternatives are both worse — an
    // anonymous server the client believes is authenticated, or a child that
    // fails at startup. Nothing is published, and the log says why.
    const { provider, instances, logger, context } = setup();
    instances.push(makeInstance());
    removeBrokerRegistration(context);

    const definitions = await provider.provideMcpServerDefinitions(new AbortController().signal as never);

    expect(definitions).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('broker is not running'));
  });

  it('publishes again once a broker registration exists', async () => {
    // The counterpart of the assertion above: "absent" must be caused by the
    // missing broker, not by something else in the fixture.
    const { provider, instances, context } = setup();
    instances.push(makeInstance());
    removeBrokerRegistration(context);

    expect(await provider.provideMcpServerDefinitions(new AbortController().signal as never)).toEqual([]);

    writeBrokerRegistration(context);
    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];
    expect(definitions).toHaveLength(1);
    expect(definitions[0].env[MCP_ENV_BROKER_ONLY]).toBe('true');
  });

  it('ignores a broker registration whose owning pid is gone', async () => {
    // A crash-orphaned registration is exactly the state a stale file
    // produces, and `process.kill(pid, 0)` is what distinguishes it from a
    // live broker. pid 0 would target the whole process group, so the file is
    // written with a pid that cannot be ours and then shot down by the probe.
    const { provider, instances, context } = setup();
    instances.push(makeInstance());
    fs.writeFileSync(
      path.join(context.globalStorageUri.fsPath, BROKER_REGISTRATION_FILE),
      JSON.stringify({ version: 1, pid: process.pid, endpoint: 'x', authToken: 'y', startedAt: 'z' }),
      'utf8',
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      expect(await provider.provideMcpServerDefinitions(new AbortController().signal as never)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it('returns no definitions when the instance has no stored token', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance({ token: '' }));
    const definitions = await provider.provideMcpServerDefinitions(new AbortController().signal as never);
    expect(definitions).toEqual([]);
  });

  it('skips tokenless instances individually and logs each skip', async () => {
    // A tokenless instance used to hide every later, usable one; now it is
    // skipped on its own and the usable instance still gets a definition.
    const { provider, instances, logger } = setup();
    instances.push(makeInstance({ token: '', name: 'Tokenless' }), makeInstance({ id: 'instance-2', name: 'Second' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(1);
    expect(definitions[0].env[MCP_ENV_INSTANCE_ID]).toBe('instance-2');
    expect(definitions[0].label).toContain('Second');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Tokenless'));
  });

  it('keeps credential userinfo out of the server label and out of the definition', async () => {
    // A stored URL that embeds credentials (an import from an older version
    // could still carry one) must never reach the user-visible label, and the
    // environment that used to need the verbatim value no longer does: the
    // broker resolves the instance by id and holds the real URL itself.
    const { provider, instances } = setup();
    instances.push(makeInstance({ name: '', url: 'https://token-abc123@forgejo.example.com' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].label).not.toContain('token-abc123');
    expect(definitions[0].label).toContain('forgejo.example.com');
  });

  it('hands every definition this window’s workspace state file', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance(), makeInstance({ id: 'instance-2', url: 'https://other.example.com', name: 'Other' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    // One file per window, shared by every instance's server: the mapping
    // describes the workspace, not the instance. The name carries the pid and
    // a per-window nonce, so a recycled pid cannot read a dead window's file.
    const stateFile = definitions[0].env[MCP_ENV_STATE_FILE];
    expect(stateFile).toMatch(new RegExp(`mcp-workspace-${process.pid}-[0-9a-f]{8}\\.json$`));
    expect(definitions[1].env[MCP_ENV_STATE_FILE]).toBe(stateFile);
  });

  it('disambiguates duplicate labels with a stable discriminator, leaving unique labels alone', async () => {
    // Two accounts on one host often share the instance name; identical
    // labels would be indistinguishable in the MCP server list.
    const { provider, instances } = setup();
    instances.push(
      makeInstance({ id: 'instance-1', name: 'Work', username: 'alice' }),
      // No username on this one: the id is the fallback discriminator.
      makeInstance({ id: 'instance-2', name: 'Work', username: '' }),
      makeInstance({ id: 'instance-3', name: 'Personal', url: 'https://other.example.com' }),
    );

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions.map((definition) => definition.label)).toEqual([
      'Forgejo: Work (alice)',
      'Forgejo: Work (instance-2)',
      'Forgejo: Personal',
    ]);
  });

  it('passes the per-instance API URL sync flag to the child process', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance({ syncApiUrlsToInstanceUrl: false }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    // Without the flag the headless client would default to rewriting the
    // URLs it returns, contradicting the user's per-instance setting.
    expect(definitions[0].env[MCP_ENV_SYNC_API_URLS]).toBe('false');
  });

  it('defaults the API URL sync flag to enabled', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env[MCP_ENV_SYNC_API_URLS]).toBe('true');
  });

  it('never puts the write-tools marker in a definition while every write switch is off', async () => {
    // §5: the marker's *presence* is what tells the child (and, through the
    // broker's own answer, the session) that the extension host established
    // this launch for writing. While no switch is on there is nothing to
    // establish, and an empty value would be a lie — so the variable is absent.
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env).not.toHaveProperty(MCP_ENV_WRITE_TOOLS);
  });

  it('marks the definition with the write tool the window switched on', async () => {
    const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
    getConfiguration.mockReturnValue({
      get: (key: string) => (key === 'mcpWriteTools' ? { createIssueComment: true } : undefined),
      update: vi.fn(),
    } as never);
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    // The marker carries tool names, not setting keys: one spelling end to end.
    expect(definitions[0].env[MCP_ENV_WRITE_TOOLS]).toBe('create_issue_comment');
    // A switch that is off advertises nothing: the stage-2 tool is a separate
    // opt-in, and the marker is per session, not per feature.
    expect(definitions[0].env[MCP_ENV_WRITE_TOOLS]).not.toContain('submit_pull_review');
    // The token still never appears in a definition.
    expect(JSON.stringify(definitions[0].env)).not.toContain('secret-token');
  });

  it('advertises each write tool the window switched on, by tool name', async () => {
    // Both switches are independent (§13.2), so the marker is exactly the set
    // the window enabled — no more and no less.
    const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
    getConfiguration.mockReturnValue({
      get: (key: string) => (key === 'mcpWriteTools' ? { submitPullReview: true } : undefined),
      update: vi.fn(),
    } as never);
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env[MCP_ENV_WRITE_TOOLS]).toBe('submit_pull_review');

    getConfiguration.mockReturnValue({
      get: (key: string) =>
        key === 'mcpWriteTools' ? { createIssueComment: true, submitPullReview: true } : undefined,
      update: vi.fn(),
    } as never);
    const both = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];
    expect(both[0].env[MCP_ENV_WRITE_TOOLS]).toBe('create_issue_comment,submit_pull_review');
  });

  it('treats a non-boolean switch value as off', async () => {
    // A hand-edited settings.json can hold any JSON type under the key; only an
    // explicit `true` may enable a write tool.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => (key === 'mcpWriteTools' ? { createIssueComment: 'true', submitPullReview: 1 } : undefined),
      update: vi.fn(),
    } as never);
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env).not.toHaveProperty(MCP_ENV_WRITE_TOOLS);
  });

  it('forwards the editor proxy setting to the child process', async () => {
    // The child inherits this process's environment, so only the setting needs
    // forwarding; without it, MCP requests would connect directly while the
    // extension's own requests honour the proxy.
    const getConfiguration = vi.mocked(vscode.workspace.getConfiguration);
    getConfiguration.mockReturnValue({
      get: (key: string) => (key === 'proxy' ? 'proxy.example.com:3128' : undefined),
      update: vi.fn(),
    } as never);
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env[MCP_ENV_PROXY]).toBe('proxy.example.com:3128');
    getConfiguration.mockReset();
    getConfiguration.mockReturnValue({ get: vi.fn(), update: vi.fn() } as never);
  });

  it('ignores a non-string proxy setting instead of failing the whole resolution', async () => {
    // A hand-edited settings.json can store any JSON type under http.proxy;
    // calling .trim() on a number used to throw inside
    // provideMcpServerDefinitions and take every server definition down.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => (key === 'proxy' ? 3128 : undefined),
      update: vi.fn(),
    } as never);
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(1);
    expect(definitions[0].env[MCP_ENV_PROXY]).toBeUndefined();
  });

  it('omits the proxy variable when no proxy is configured', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance());

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].env[MCP_ENV_PROXY]).toBeUndefined();
  });

  it('re-resolves when the instance list changes', () => {
    const { instanceListeners } = setup();
    // Two listeners: the provider's own re-resolution and the workspace-state
    // sync's rewrite. The provider registers first.
    expect(instanceListeners).toHaveLength(2);
    instanceListeners[0]([]);
    const emitter = vi.mocked(vscode.EventEmitter).mock.results[0].value as { fire: ReturnType<typeof vi.fn> };
    expect(emitter.fire).toHaveBeenCalledTimes(1);
  });

  it('rewrites the workspace state file from the sync listener when the instance list changes', async () => {
    // The second listener belongs to registerMcpWorkspaceStateSync: it must
    // actually write, not merely be registered. Only setTimeout is faked, so
    // the debounce is controllable while the write's real fs work still runs.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { instanceListeners, context } = setup();

    instanceListeners[1]([]);
    await vi.advanceTimersByTimeAsync(300);

    // The workspace has no folders in this mock, so detection resolves to an
    // empty mapping; what matters is that the file appears at all.
    const stateFilePath = mcpWorkspaceStateFilePath(context);
    await vi.waitFor(() => {
      expect(fs.existsSync(stateFilePath)).toBe(true);
    });
    const written = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as { repositories: unknown[] };
    expect(written.repositories).toEqual([]);
  });

  it('re-resolves when the editor proxy setting changes so the child stops using a stale proxy', () => {
    // The proxy is read once per resolution, so without this the child spawned
    // before the change keeps connecting through the old (or no) proxy.
    const { configurationListener } = setup();
    expect(configurationListener).toBeDefined();

    configurationListener?.({ affectsConfiguration: (section: string) => section === 'http.proxy' } as never);

    const emitter = vi.mocked(vscode.EventEmitter).mock.results[0].value as { fire: ReturnType<typeof vi.fn> };
    expect(emitter.fire).toHaveBeenCalledTimes(1);
  });

  it('leaves definitions untouched when an unrelated setting changes', () => {
    const { configurationListener } = setup();
    configurationListener?.({ affectsConfiguration: () => false } as never);

    const emitter = vi.mocked(vscode.EventEmitter).mock.results[0].value as { fire: ReturnType<typeof vi.fn> };
    expect(emitter.fire).not.toHaveBeenCalled();
  });
});
