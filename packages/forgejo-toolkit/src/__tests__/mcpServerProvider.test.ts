import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
  registerMcpServerProvider,
  MCP_SERVER_DEFINITION_PROVIDER_ID,
  MCP_ENV_INSTANCE_URL,
  MCP_ENV_PROXY,
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
  } as unknown as import('vscode').ExtensionContext;

  const logger = { debug: vi.fn() } as unknown as Logger;

  registerMcpServerProvider(context, config, logger);
  const provider = registerSpy.mock.calls[0][1];
  return { registerSpy, provider, instanceListeners, instances };
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

  it('injects the first instance URL and token via environment only', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance(), makeInstance({ id: 'instance-2', url: 'https://other.example.com' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    expect(definition.command).toBe(process.execPath);
    expect(definition.args[0]).toContain('mcp-server.js');
    expect(definition.env[MCP_ENV_INSTANCE_URL]).toBe('https://forgejo.example.com');
    expect(definition.env[MCP_ENV_TOKEN]).toBe('secret-token');
    // The token must never appear outside the env channel.
    expect(definition.label).not.toContain('secret-token');
    expect(definition.args.join(' ')).not.toContain('secret-token');
  });

  it('returns no definitions when the instance has no stored token', async () => {
    const { provider, instances } = setup();
    instances.push(makeInstance({ token: '' }));
    const definitions = await provider.provideMcpServerDefinitions(new AbortController().signal as never);
    expect(definitions).toEqual([]);
  });

  it('uses a later instance when the first one has no token', async () => {
    // Picking strictly the first instance left the tools unregistered although a
    // usable one was configured.
    const { provider, instances } = setup();
    instances.push(makeInstance({ token: '' }), makeInstance({ id: 'instance-2', name: 'Second' }));

    const definitions = (await provider.provideMcpServerDefinitions(
      new AbortController().signal as never,
    )) as unknown as CapturedDefinition[];

    expect(definitions).toHaveLength(1);
    expect(definitions[0].env[MCP_ENV_TOKEN]).toBe('secret-token');
    expect(definitions[0].label).toContain('Second');
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
    expect(instanceListeners).toHaveLength(1);
    instanceListeners[0]([]);
    const emitter = vi.mocked(vscode.EventEmitter).mock.results[0].value as { fire: ReturnType<typeof vi.fn> };
    expect(emitter.fire).toHaveBeenCalledTimes(1);
  });
});
