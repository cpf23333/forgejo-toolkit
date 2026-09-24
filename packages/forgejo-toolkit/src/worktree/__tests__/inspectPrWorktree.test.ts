import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('child_process', async () => {
  const { promisify } = await import('node:util');
  // The real cp.exec/cp.execFile carry a promisify.custom that resolves with
  // { stdout, stderr }; plain promisify(mockFn) would resolve with the stdout
  // string only, so replicate the custom behavior here.
  const wrap = (mock: (...args: unknown[]) => void) =>
    Object.assign(() => undefined, {
      [promisify.custom]: (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          mock(...args, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        }),
    });
  return { exec: wrap(mocks.exec), execFile: wrap(mocks.execFile) };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discardStalePrWorktree, inspectPrWorktree } from '../gitOperations';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

let currentHeadSha: string | undefined;
let currentBranch: string | undefined;
let statusOutput = '';
let commitsAheadOutput = '0';

/**
 * Every git read involved in the stale path is layered onto one execFile
 * implementation: HEAD lookup inside the worktree, the branch checked out
 * there, `status --porcelain` (dirt), `rev-list --count` (local commits), and
 * success for everything else (worktree removal, branch deletion).
 */
function baseGitImplementation(removeFails: boolean) {
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      if (currentHeadSha === undefined) {
        const error = new Error('fatal: not a git repository') as Error & { stderr: string };
        error.stderr = 'fatal: not a git repository';
        callback(error, '', error.stderr);
      } else {
        callback(null, `${currentHeadSha}\n`, '');
      }
      return;
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      if (currentBranch === undefined) {
        const error = new Error('Command failed: git rev-parse') as Error & { stderr: string };
        error.stderr = 'fatal: ref HEAD is not a symbolic ref';
        callback(error, '', error.stderr);
      } else {
        callback(null, `${currentBranch}\n`, '');
      }
      return;
    }
    if (args[0] === 'status') {
      callback(null, statusOutput, '');
      return;
    }
    if (args[0] === 'rev-list') {
      callback(null, `${commitsAheadOutput}\n`, '');
      return;
    }
    if (removeFails && args[0] === 'worktree' && args[1] === 'remove') {
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'fatal: removal failed';
      callback(error, '', error.stderr);
      return;
    }
    callback(null, '', '');
  });
}

describe('inspectPrWorktree', () => {
  let tempRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    currentHeadSha = undefined;
    currentBranch = undefined;
    statusOutput = '';
    commitsAheadOutput = '0';
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-toolkit-wt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports "missing" when the directory does not exist', async () => {
    const worktreePath = path.join(tempRoot, 'gone');
    baseGitImplementation(false);

    await expect(inspectPrWorktree(worktreePath, 'abc1234')).resolves.toEqual({ state: 'missing' });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('reports "current" when HEAD matches the PR head sha', async () => {
    const worktreePath = path.join(tempRoot, 'current');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'abc1234';
    baseGitImplementation(false);

    await expect(inspectPrWorktree(worktreePath, 'abc1234')).resolves.toEqual({ state: 'current' });
    // Only the HEAD lookup ran — no inspection of local work, no removal.
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], expect.anything(), expect.any(Function));
  });

  it('reports stale without deleting anything when no local work would be lost', async () => {
    const worktreePath = path.join(tempRoot, 'stale-clean');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    baseGitImplementation(false);

    await expect(inspectPrWorktree(worktreePath, 'abc1234')).resolves.toEqual({
      state: 'stale',
      info: { branch: 'pr-1-abc1234', dirty: false, commitsAhead: 0 },
    });
    // Inspection must not remove the directory or the branch: the caller
    // decides (and confirms) whether discarding is acceptable.
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain('remove');
      expect(call[1]).not.toContain('branch');
      expect(call[1]).not.toContain('prune');
    }
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('reports uncommitted changes in a stale worktree', async () => {
    const worktreePath = path.join(tempRoot, 'stale-dirty');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    statusOutput = ' M src/index.ts\n?? scratch.txt\n';
    baseGitImplementation(false);

    const result = await inspectPrWorktree(worktreePath, 'abc1234');
    expect(result).toEqual({
      state: 'stale',
      info: { branch: 'pr-1-abc1234', dirty: true, commitsAhead: 0 },
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      // `--ignored` counts a worktree whose only content is gitignored (a .env,
      // build output) as dirty, so removing it still asks for confirmation.
      ['status', '--porcelain', '--ignored'],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
  });

  it('counts local commits that a discard would drop', async () => {
    const worktreePath = path.join(tempRoot, 'stale-ahead');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    commitsAheadOutput = '3';
    baseGitImplementation(false);

    const result = await inspectPrWorktree(worktreePath, 'abc1234');
    expect(result.state).toBe('stale');
    expect(result.state === 'stale' ? result.info.commitsAhead : undefined).toBe(3);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['rev-list', '--count', 'abc1234..HEAD'],
      expect.objectContaining({ cwd: worktreePath }),
      expect.any(Function),
    );
  });

  it('does not ask git to count commits for a non-sha expected ref', async () => {
    const worktreePath = path.join(tempRoot, 'stale-nonsha');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    baseGitImplementation(false);

    const result = await inspectPrWorktree(worktreePath, 'refs/heads/main');
    expect(result.state === 'stale' ? result.info.commitsAhead : undefined).toBe(0);
    for (const call of mocks.execFile.mock.calls) {
      expect(call[1]).not.toContain('rev-list');
    }
  });

  it('treats a detached HEAD as having no branch to clean up', async () => {
    const worktreePath = path.join(tempRoot, 'stale-detached');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    baseGitImplementation(false);

    const result = await inspectPrWorktree(worktreePath, 'abc1234');
    expect(result).toEqual({ state: 'stale', info: { branch: undefined, dirty: false, commitsAhead: 0 } });
  });

  it('fails closed when a worktree cannot be inspected but claims to be a repo', async () => {
    const worktreePath = path.join(tempRoot, 'unreadable');
    fs.mkdirSync(worktreePath);
    // A worktree checkout has a `.git` *file* pointing at the real gitdir.
    fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: /repo/.git/worktrees/x\n');
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        callback(null, { stdout: 'old-sha\n', stderr: '' } as unknown as string, '');
        return;
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        callback(null, { stdout: 'pr-1-abc1234\n', stderr: '' } as unknown as string, '');
        return;
      }
      // Everything else (including `status --porcelain`) fails: the repository
      // is unavailable, so the dirt cannot be determined.
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'fatal: not a git repository';
      callback(error, '', error.stderr);
    });

    const result = await inspectPrWorktree(worktreePath, 'abc1234');
    expect(result.state).toBe('stale');
    expect(result.state === 'stale' ? result.info.dirty : undefined).toBe(true);
  });

  it('treats an unreadable leftover without a .git entry as clean', async () => {
    const worktreePath = path.join(tempRoot, 'broken-leftover');
    fs.mkdirSync(worktreePath);
    currentHeadSha = 'old-sha';
    currentBranch = 'pr-1-abc1234';
    mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        callback(null, { stdout: 'old-sha\n', stderr: '' } as unknown as string, '');
        return;
      }
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'fatal: not a git repository';
      callback(error, '', error.stderr);
    });

    const result = await inspectPrWorktree(worktreePath, 'abc1234');
    expect(result.state).toBe('stale');
    expect(result.state === 'stale' ? result.info.dirty : undefined).toBe(false);
  });
});

describe('discardStalePrWorktree', () => {
  let tempRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    currentHeadSha = undefined;
    currentBranch = undefined;
    statusOutput = '';
    commitsAheadOutput = '0';
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-toolkit-wt-discard-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('removes the worktree and deletes the throwaway pr-<n>-<sha7> branch', async () => {
    const worktreePath = path.join(tempRoot, 'pr-1');
    fs.mkdirSync(worktreePath);
    baseGitImplementation(false);

    await discardStalePrWorktree('/repo', worktreePath, 'pr-1-abc1234');

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'pr-1-abc1234'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
  });

  it('never deletes a non-throwaway branch', async () => {
    const worktreePath = path.join(tempRoot, 'feature');
    fs.mkdirSync(worktreePath);
    baseGitImplementation(false);

    await discardStalePrWorktree('/repo', worktreePath, 'feature-user-work');

    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('skips branch cleanup for a detached worktree', async () => {
    const worktreePath = path.join(tempRoot, 'detached');
    fs.mkdirSync(worktreePath);
    baseGitImplementation(false);

    await discardStalePrWorktree('/repo', worktreePath, undefined);

    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('falls back to prune plus manual delete when git worktree remove fails', async () => {
    const worktreePath = path.join(tempRoot, 'broken');
    fs.mkdirSync(worktreePath);
    baseGitImplementation(true);

    await discardStalePrWorktree('/repo', worktreePath, undefined);

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'prune'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('rethrows the removal error when both git removal and the fallback fail', async () => {
    const worktreePath = path.join(tempRoot, 'stuck');
    fs.mkdirSync(worktreePath);
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'fatal: removal failed';
      callback(error, '', error.stderr);
    });

    await expect(discardStalePrWorktree('/repo', worktreePath, 'pr-1-old0000')).rejects.toThrow(
      'fatal: removal failed',
    );
    expect(mocks.execFile).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['branch']),
      expect.anything(),
      expect.any(Function),
    );
  });
});
