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
import { validatePrWorktree } from '../gitOperations';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

let currentHeadSha: string | undefined;

function mockHeadSha(sha: string | undefined) {
  currentHeadSha = sha;
}

// getCurrentCommitSha now runs `git rev-parse HEAD` through execFile too, so
// every helper layers its behavior onto a single execFile implementation.
function baseGitImplementation(removeFails: boolean) {
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    if (args[0] === 'rev-parse') {
      if (currentHeadSha === undefined) {
        callback(new Error('fatal: not a git repository'), '', '');
      } else {
        callback(null, `${currentHeadSha}\n`, '');
      }
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

function mockGitSuccess() {
  baseGitImplementation(false);
}

function mockGitRemoveFails() {
  baseGitImplementation(true);
}

describe('validatePrWorktree', () => {
  let tempRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    currentHeadSha = undefined;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forgejo-toolkit-wt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns "missing" when the directory does not exist', async () => {
    const worktreePath = path.join(tempRoot, 'gone');
    mockGitSuccess();

    await expect(validatePrWorktree('/repo', worktreePath, 'abc1234')).resolves.toBe('missing');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('returns "current" when HEAD matches the PR head sha', async () => {
    const worktreePath = path.join(tempRoot, 'current');
    fs.mkdirSync(worktreePath);
    mockHeadSha('abc1234');
    mockGitSuccess();

    await expect(validatePrWorktree('/repo', worktreePath, 'abc1234')).resolves.toBe('current');
    // Only the HEAD lookup ran — no worktree removal.
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], expect.anything(), expect.any(Function));
  });

  it('returns "stale" and removes the worktree via git when HEAD differs', async () => {
    const worktreePath = path.join(tempRoot, 'stale');
    fs.mkdirSync(worktreePath);
    mockHeadSha('old-sha');
    mockGitSuccess();

    await expect(validatePrWorktree('/repo', worktreePath, 'abc1234')).resolves.toBe('stale');
    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
  });

  it('falls back to prune plus manual delete when git worktree remove fails', async () => {
    const worktreePath = path.join(tempRoot, 'broken');
    fs.mkdirSync(worktreePath);
    mockHeadSha('old-sha');
    mockGitRemoveFails();

    await expect(validatePrWorktree('/repo', worktreePath, 'abc1234')).resolves.toBe('stale');
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
    mockHeadSha('old-sha');
    mocks.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'fatal: removal failed';
      callback(error, '', error.stderr);
    });

    await expect(validatePrWorktree('/repo', worktreePath, 'abc1234')).rejects.toThrow('fatal: removal failed');
  });
});
