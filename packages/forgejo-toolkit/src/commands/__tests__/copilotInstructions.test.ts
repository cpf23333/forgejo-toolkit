import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  COMMAND_WRITE_COPILOT_INSTRUCTIONS,
  COPILOT_INSTRUCTIONS_RELATIVE_PATH,
  COPILOT_SECTION_END,
  COPILOT_SECTION_START,
  buildCopilotSection,
  mergeCopilotInstructions,
  registerWriteCopilotInstructionsCommand,
  writeCopilotInstructions,
} from '../copilotInstructions';
import type { ForgejoInstance } from '../../config';
import type { ConfigManager } from '../../config';

// Detection spawns git and probes the API; the command's own responsibility is
// what it does with the attribution it gets back.
const gitMocks = vi.hoisted(() => ({ detectLinkedRepositories: vi.fn() }));
vi.mock('../../worktree/gitOperations', () => gitMocks);

const LINKED_REPOSITORY = {
  instanceId: 'inst-1',
  owner: 'owner',
  repo: 'repo',
  localPath: '',
  remoteUrl: 'https://forgejo.example.com/owner/repo.git',
};

function makeInstance(overrides: Partial<ForgejoInstance> = {}): ForgejoInstance {
  return {
    id: 'inst-1',
    url: 'https://forgejo.example.com',
    token: 'secret-token',
    name: 'Example',
    username: 'demo-user',
    ...overrides,
  };
}

function createConfig(instances: ForgejoInstance[] = [makeInstance()]): ConfigManager {
  return { getInstances: () => instances } as unknown as ConfigManager;
}

/** Detection attributed `localPath` (this test's temp checkout) to `instanceId`. */
function mockLinkedRepository(localPath: string, instanceId = LINKED_REPOSITORY.instanceId): void {
  const linked = { ...LINKED_REPOSITORY, localPath, instanceId };
  gitMocks.detectLinkedRepositories.mockResolvedValue({ linked, all: [linked], unpublished: [] });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('writeCopilotInstructions', () => {
  let repoDir: string;
  let targetPath: string;

  beforeEach(() => {
    // A real directory: the command reads and writes actual files, and the
    // "never clobber" rules are about bytes on disk.
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-copilot-instructions-'));
    targetPath = path.join(repoDir, COPILOT_INSTRUCTIONS_RELATIVE_PATH);
    gitMocks.detectLinkedRepositories.mockReset();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showInformationMessage).mockClear();
  });

  it('writes nothing and says so when no workspace repository matches an instance', async () => {
    gitMocks.detectLinkedRepositories.mockResolvedValue({ linked: undefined, all: [], unpublished: [repoDir] });

    await writeCopilotInstructions(createConfig());

    expect(fs.existsSync(path.join(repoDir, '.github'))).toBe(false);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No linked Forgejo repository'),
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('writes nothing when the linked repository names an instance that is gone', async () => {
    mockLinkedRepository(repoDir, 'instance-that-was-removed');

    await writeCopilotInstructions(createConfig());

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Forgejo instance not found'),
    );
  });

  it('creates .github/copilot-instructions.md when the file does not exist', async () => {
    mockLinkedRepository(repoDir);

    await writeCopilotInstructions(createConfig());

    const written = fs.readFileSync(targetPath, 'utf8');
    // The mapping the agent needs, one marker pair around it, and the
    // read-only promise — never a claim the tools can write.
    expect(written).toContain('https://forgejo.example.com/owner/repo');
    expect(written).toContain(COPILOT_SECTION_START);
    expect(written).toContain(COPILOT_SECTION_END);
    expect(written).toContain('read-only MCP server named `forgejo-toolkit`');
    expect(written).toMatch(/read-only/i);
    expect(written).not.toMatch(/can (write|modify|create)/i);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Created'));
  });

  it('preserves an existing file and appends the section after its content', async () => {
    const existing = '# House rules\n\n- Always run the tests.\n';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, existing);
    mockLinkedRepository(repoDir);

    await writeCopilotInstructions(createConfig());

    const written = fs.readFileSync(targetPath, 'utf8');
    // Nothing of the user's text is lost, reordered, or joined without a
    // blank line.
    expect(written).toContain(existing.trimEnd());
    expect(written.indexOf('House rules')).toBeLessThan(written.indexOf(COPILOT_SECTION_START));
    expect(written).toContain(`\n\n${COPILOT_SECTION_START}`);
    expect(countOccurrences(written, COPILOT_SECTION_START)).toBe(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Appended'));
  });

  it('leaves a file whose section is already up to date unchanged', async () => {
    mockLinkedRepository(repoDir);
    await writeCopilotInstructions(createConfig());
    const first = fs.readFileSync(targetPath, 'utf8');

    await writeCopilotInstructions(createConfig());

    const second = fs.readFileSync(targetPath, 'utf8');
    expect(second).toBe(first);
    expect(countOccurrences(second, COPILOT_SECTION_START)).toBe(1);
    expect(vscode.window.showInformationMessage).toHaveBeenLastCalledWith(expect.stringContaining('already contains'));
  });

  it('updates its own section in place when the mapping changed', async () => {
    const stale = `${buildCopilotSection('https://forgejo.example.com', 'other', 'project')}\n`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `House rules\n\n${stale}`);
    mockLinkedRepository(repoDir);

    await writeCopilotInstructions(createConfig());

    const written = fs.readFileSync(targetPath, 'utf8');
    expect(written).toContain('House rules');
    expect(written).toContain('https://forgejo.example.com/owner/repo');
    expect(written).not.toContain('/other/project');
    expect(countOccurrences(written, COPILOT_SECTION_START)).toBe(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('never writes credentials from the instance URL into the workspace file', async () => {
    mockLinkedRepository(repoDir);

    await writeCopilotInstructions(
      createConfig([makeInstance({ url: 'https://alice:secret-token@forgejo.example.com' })]),
    );

    const written = fs.readFileSync(targetPath, 'utf8');
    expect(written).not.toContain('secret-token');
    expect(written).toContain('https://forgejo.example.com/owner/repo');
  });

  it('writes into the repository detection attributed, not the workspace root', async () => {
    // A nested repository wins attribution (longest path), and the file
    // belongs to that checkout, not to whichever folder happens to be listed
    // first in the workspace.
    const nested = path.join(repoDir, 'packages', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    mockLinkedRepository(nested);

    await writeCopilotInstructions(createConfig());

    expect(fs.existsSync(path.join(nested, COPILOT_INSTRUCTIONS_RELATIVE_PATH))).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});

describe('mergeCopilotInstructions', () => {
  const section = buildCopilotSection('https://forgejo.example.com', 'owner', 'repo');

  it('treats a missing file as a creation', () => {
    expect(mergeCopilotInstructions(undefined, section)).toEqual({
      action: 'created',
      content: `${section}\n`,
    });
  });

  it('treats an empty file as a creation', () => {
    expect(mergeCopilotInstructions('', section)).toEqual({ action: 'created', content: `${section}\n` });
  });

  it('appends with a blank line after content that already ends in a newline', () => {
    const merged = mergeCopilotInstructions('User text\n', section);
    expect(merged).toEqual({ action: 'appended', content: `User text\n\n${section}\n` });
  });

  it('adds the missing newline before appending', () => {
    const merged = mergeCopilotInstructions('User text', section);
    expect(merged).toEqual({ action: 'appended', content: `User text\n\n${section}\n` });
  });

  it('reports its own up-to-date section as unchanged', () => {
    const merged = mergeCopilotInstructions(`User text\n\n${section}\n`, section);
    expect(merged).toEqual({ action: 'unchanged', content: `User text\n\n${section}\n` });
  });

  it('replaces a stale section without touching the surrounding text', () => {
    const stale = buildCopilotSection('https://forgejo.example.com', 'old', 'name');
    const merged = mergeCopilotInstructions(`Before\n\n${stale}\n\nAfter\n`, section);
    expect(merged).toEqual({ action: 'updated', content: `Before\n\n${section}\n\nAfter\n` });
  });

  it('refuses a file with only one half of the marker pair', () => {
    // Appending would be just as wrong as replacing: a later run could then
    // read the stray marker as its own section start and swallow the text in
    // between, so the ambiguous file is left completely alone.
    expect(mergeCopilotInstructions(`${COPILOT_SECTION_START}\n`, section)).toEqual({ action: 'ambiguous' });
    expect(mergeCopilotInstructions(`${COPILOT_SECTION_END}\n`, section)).toEqual({ action: 'ambiguous' });
  });

  it('refuses a file carrying two complete sections', () => {
    expect(mergeCopilotInstructions(`${section}\n\n${section}\n`, section)).toEqual({ action: 'ambiguous' });
  });
});

describe('registerWriteCopilotInstructionsCommand', () => {
  afterEach(() => {
    vi.mocked(vscode.commands.registerCommand).mockClear();
  });

  it('registers the contributed command id', () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerWriteCopilotInstructionsCommand(context as never, createConfig());

    expect(context.subscriptions).toHaveLength(1);
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      COMMAND_WRITE_COPILOT_INSTRUCTIONS,
      expect.any(Function),
    );
  });

  it('reports a failed write with a View Log action instead of dropping it', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerWriteCopilotInstructionsCommand(context as never, createConfig());
    gitMocks.detectLinkedRepositories.mockRejectedValue(new Error('git exploded'));
    const handler = vi.mocked(vscode.commands.registerCommand).mock.calls[0][1] as () => void;

    handler();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('git exploded'), 'View Log');
  });
});
