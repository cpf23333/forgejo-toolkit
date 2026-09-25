import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  registerMcpServerProvider,
  MCP_SERVER_DEFINITION_PROVIDER_ID,
  MCP_ENV_INSTANCE_URL,
  MCP_ENV_PROXY,
  MCP_ENV_STATE_FILE,
  MCP_ENV_SYNC_API_URLS,
  MCP_ENV_TOKEN,
} from '../mcpServerProvider';
import type { ConfigManager } from '../config';
import type { ForgejoInstance } from '../config';
import type { Logger } from '../logger';

interface CapturedDefinition {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

function setup() {
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
  const instances: ForgejoInstance[] = [];
  const config = {
    getInstances: () => instances,
    onInstancesChanged: (listener: (value: ForgejoInstance[]) => void) => {
      instanceListeners.push(listener);
      return { dispose: vi.fn() };
    },
  } as unknown as ConfigManager;

  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    extensionUri: { fsPath: '/ext' },
    // A real (writable) directory: the workspace-state sync this registration
    // starts writes its file here when a test fires a trigger or lets the
    // cold-start timer run.
    globalStorageUri: { fsPath: path.join(os.tmpdir(), `forgejo-mcp-provider-test-${process.pid}`) },
  } as unknown as import('vscode').ExtensionContext;

  const logger = { debug: vi.fn() } as unknown as Logger;

  const configListenerCalls = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.length;
  registerMcpServerProvider(context, config, logger);
  const provider = registerSpy.mock.calls[0][1];
  // The listener this call registered, not one left over from another setup().
  const configurationListener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls[
    configListenerCalls
  ]?.[0];
  return { registerSpy, provider, instanceListeners, instances, configurationListener, logger };
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
  });

  it('registers the provider under the contributed id', () => {
    const { registerSpy } = setup();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy.mock.calls[0][0]).toBe(MCP_SERVER_DEFINITION_PROVIDER_ID);
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
    expect(first.args[0]).toContain('mcp-server.js');
    expect(first.env[MCP_ENV_INSTANCE_URL]).toBe('https://forgejo.example.com');
    expect(first.env[MCP_ENV_TOKEN]).toBe('secret-token');
    expect(first.label).toBe('Forgejo: Example');
    expect(second.env[MCP_ENV_INSTANCE_URL]).toBe('https://other.example.com');
    expect(second.env[MCP_ENV_TOKEN]).toBe('second-token');
    expect(second.label).toBe('Forgejo: Other');
    // The tokens must never appear outside the env channel.
    for (const definition of definitions) {
      expect(definition.label).not.toContain('token');
      expect(definition.args.join(' ')).not.toContain('token');
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
    expect(definitions[0].env[MCP_ENV_TOKEN]).toBe('secret-token');
    expect(definitions[0].label).toContain('Second');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Tokenless'));
  });

  it('keeps credential userinfo out of the server label', async () => {
    // The label is user-visible in the MCP server list; the environment keeps
    // the real URL, which the child needs to authenticate.
    const { provider, instances } = setup();
    instances.push(makeInstance({ name: '', url: 'https://token-abc123@forgejo.example.com' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions[0].label).not.toContain('token-abc123');
    expect(definitions[0].label).toContain('forgejo.example.com');
    expect(definitions[0].env[MCP_ENV_INSTANCE_URL]).toBe('https://token-abc123@forgejo.example.com');
  });

  it('hands every definition this window’s workspace state file', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance(), makeInstance({ id: 'instance-2', url: 'https://other.example.com', name: 'Other' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    // One file per window, shared by every instance's server: the mapping
    // describes the workspace, not the instance.
    const stateFile = definitions[0].env[MCP_ENV_STATE_FILE];
    expect(stateFile).toContain(`mcp-workspace-${process.pid}.json`);
    expect(definitions[1].env[MCP_ENV_STATE_FILE]).toBe(stateFile);
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
