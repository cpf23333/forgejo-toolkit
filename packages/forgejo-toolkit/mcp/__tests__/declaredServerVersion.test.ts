import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ForgejoClient } from '../../src/api/client';
import { clearServerVersions } from '../../src/api/serverVersion';
import type { McpInstanceRegistryFile } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import { registerDeclaredServerVersions, type AutoConfigOptions } from '../autoConfig';
import { createMcpServer } from '../mcpServer';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../src/test/mocks/server';
import { removeTempDirSync } from '../../src/__tests__/tempDir';

/**
 * The declared server version on the **no-broker route**.
 *
 * A launch the extension provides forwards into the host's broker, and the host
 * resolves the declaration from the instance record. A launch that builds its
 * own client — the static `mcp.json` / Agents-window route when no broker is
 * reachable — has no instance record, so the declaration reaches it only through
 * the instance registry (`mcp-instances.json`). These tests drive that route end
 * to end: a registry on disk, the resolver it installs, and the real
 * `ForgejoClient` Actions gate (and one tool call) on top of it.
 *
 * The three behaviours that must not change are pinned too: an instance with no
 * declaration probes exactly as before, and a carried value that cannot be a
 * version is ignored — never a failed startup, never a version in a gate.
 */

const INSTANCE_URL = 'https://forgejo.example.com';

/** Counts `/api/v1/version` requests without disturbing the other mocks. */
function countVersionProbes(version: string): () => number {
  let probes = 0;
  mockServer.use(
    http.get('https://*/api/v1/version', () => {
      probes += 1;
      return HttpResponse.json({ version });
    }),
  );
  return () => probes;
}

function writeRegistry(dataDir: string, payload: unknown): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'mcp-instances.json'), JSON.stringify(payload), 'utf8');
}

function registryPayload(declaredServerVersion?: string): McpInstanceRegistryFile {
  return {
    updatedAt: '2026-01-01T00:00:00.000Z',
    instances: [
      {
        id: 'instance-1',
        url: INSTANCE_URL,
        name: 'Example',
        ...(declaredServerVersion !== undefined ? { declaredServerVersion } : {}),
      },
    ],
  };
}

/** A tool call over an in-memory client/server pair, as `server.ts` wires it. */
async function callActionTool(): Promise<{ isError?: boolean; text: string }> {
  const server = createMcpServer(new ForgejoClient(INSTANCE_URL, 'mock-token'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({
      name: 'list_action_runs',
      arguments: { owner: 'demo-user', repo: 'demo-repo' },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    return { isError: result.isError, text: result.content[0]?.text ?? '' };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('the declared server version on the no-broker route', () => {
  let tempDir: string;
  let dataDir: string;

  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-mcp-declared-route-'));
    dataDir = path.join(tempDir, 'globalStorage');
    // The declared-version resolver and the process-local probe map are module
    // state shared with every other suite in this worker.
    clearServerVersions();
  });

  afterEach(() => {
    clearServerVersions();
    resetMockServer();
    removeTempDirSync(tempDir);
  });

  /** The discovery options a statically launched child would use. */
  function options(): AutoConfigOptions {
    return { cwd: tempDir, env: { FORGEJO_MCP_DATA_DIR: dataDir }, platform: process.platform, homeDir: os.homedir() };
  }

  it('refuses a gated Actions call when the registry declares a version below the floor', async () => {
    writeRegistry(dataDir, registryPayload('1.18.0'));
    await registerDeclaredServerVersions(options());
    const probes = countVersionProbes('17.0.0');

    const client = new ForgejoClient(INSTANCE_URL, 'mock-token');
    await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(/you declared version 1\.18\.0/);

    // The declaration is not probed: the whole point is an instance whose
    // `/api/v1/version` is unreadable.
    expect(probes()).toBe(0);
  });

  it('refuses the same call at the tool layer, naming the declaration', async () => {
    // The tool surface is what an agent actually reaches, so the refusal has to
    // be visible there as the ordinary error result — not a crashed session.
    writeRegistry(dataDir, registryPayload('1.18.0'));
    await registerDeclaredServerVersions(options());
    const probes = countVersionProbes('17.0.0');

    const result = await callActionTool();

    expect(result.isError).toBe(true);
    expect(result.text).toContain('declared version 1.18.0');
    expect(result.text).not.toContain('this server reports');
    expect(probes()).toBe(0);
  });

  it('allows the call when the registry declares a version above the floor', async () => {
    writeRegistry(dataDir, registryPayload('17.0.0'));
    await registerDeclaredServerVersions(options());
    const probes = countVersionProbes('1.18.0');

    const client = new ForgejoClient(INSTANCE_URL, 'mock-token');
    await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();

    // A probe would have answered 1.18.0 and refused the call: the declaration
    // is what opened the gate, and it cost no request.
    expect(probes()).toBe(0);
  });

  it('probes when the registry carries no declaration for the instance', async () => {
    writeRegistry(dataDir, registryPayload());
    await registerDeclaredServerVersions(options());
    const probes = countVersionProbes('16.0.5');

    const client = new ForgejoClient(INSTANCE_URL, 'mock-token');
    await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();

    expect(probes()).toBe(1);
  });

  it('probes when no registry exists at all', async () => {
    // The state a test run or a machine where the extension never ran is in.
    await expect(registerDeclaredServerVersions(options())).resolves.toEqual(new Map());
    const probes = countVersionProbes('16.0.5');

    const client = new ForgejoClient(INSTANCE_URL, 'mock-token');
    await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();

    expect(probes()).toBe(1);
  });

  it('ignores a carried value that cannot be a version and probes instead', async () => {
    writeRegistry(dataDir, {
      updatedAt: '2026-01-01T00:00:00.000Z',
      instances: [{ id: 'instance-1', url: INSTANCE_URL, name: 'Example', declaredServerVersion: 'garbage' }],
    });
    await registerDeclaredServerVersions(options());
    const probes = countVersionProbes('1.18.0');

    const client = new ForgejoClient(INSTANCE_URL, 'mock-token');
    // The probe's own answer gates the call: the carried junk neither started a
    // failure nor acted as a version.
    await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(
      /this server reports version 1\.18\.0/,
    );

    expect(probes()).toBe(1);
  });
});
