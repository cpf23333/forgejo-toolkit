import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomically } from '../atomicWrite';

describe('writeFileAtomically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the target through a temporary sibling and leaves no part file behind', async () => {
    const target = path.join(tempDir, 'export.json');

    await writeFileAtomically(target, '{"version":2}');

    expect(fs.readFileSync(target, 'utf8')).toBe('{"version":2}');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('replaces an existing file only after the new content is complete', async () => {
    const target = path.join(tempDir, 'existing.json');
    fs.writeFileSync(target, 'previous export');

    await writeFileAtomically(target, 'new export');

    expect(fs.readFileSync(target, 'utf8')).toBe('new export');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('keeps the previous export intact when the rename fails, and cleans up the part file', async () => {
    const target = path.join(tempDir, 'failed.json');
    fs.writeFileSync(target, 'previous export');
    // The rename is the atomic step; a failure before it (a crash, a full disk,
    // a permission problem) must not have touched the target yet.
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    );

    await expect(writeFileAtomically(target, 'half-written export')).rejects.toThrow('EPERM');

    expect(fs.readFileSync(target, 'utf8')).toBe('previous export');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('leaves no target behind when the write itself fails', async () => {
    const target = path.join(tempDir, 'write-failed.json');
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    await expect(writeFileAtomically(target, 'data')).rejects.toThrow('ENOSPC');

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it('carries the existing target mode onto the replacement', async () => {
    // The rename replaces the target's inode, so without this a target the user
    // restricted (0600 on a token-bearing export) came back with the temporary
    // file's default mode.
    const target = path.join(tempDir, 'restricted.json');
    fs.writeFileSync(target, 'previous export');
    fs.chmodSync(target, 0o600);
    const expectedMode = fs.statSync(target).mode & 0o777;
    const chmod = vi.spyOn(fs.promises, 'chmod');

    await writeFileAtomically(target, 'new export');

    expect(chmod).toHaveBeenCalledWith(`${target}.part`, expectedMode);
    expect(fs.readFileSync(target, 'utf8')).toBe('new export');
  });

  it('preserves the target mode of a file that is already narrow', async () => {
    const target = path.join(tempDir, 'owner-only.json');
    fs.writeFileSync(target, 'previous export');
    fs.chmodSync(target, 0o600);
    const before = fs.statSync(target).mode & 0o777;

    await writeFileAtomically(target, 'new export');

    // On Windows Node reports only the read-only bit, so `before` is whatever
    // the platform calls 0600; the replacement must report the same.
    expect(fs.statSync(target).mode & 0o777).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).toBe('new export');
  });

  it('does not try to preserve a mode when the target does not exist yet', async () => {
    const target = path.join(tempDir, 'first-write.json');
    const chmod = vi.spyOn(fs.promises, 'chmod');

    await writeFileAtomically(target, 'first export');

    // No previous mode exists; the process default is the honest answer, and a
    // chmod would be an invented restriction.
    expect(chmod).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('first export');
  });

  it('flushes the temporary file before renaming it into place', async () => {
    // The rename is what makes the new bytes live under the target's name, so
    // the fsync has to happen first; otherwise a crash right after the rename
    // can leave that name pointing at data that never reached the disk.
    const target = path.join(tempDir, 'flushed.json');
    const order: string[] = [];
    const handle = {
      sync: vi.fn(async () => {
        order.push('sync');
      }),
      close: vi.fn(async () => undefined),
    };
    const open = vi.spyOn(fs.promises, 'open').mockResolvedValue(handle as never);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      order.push('rename');
      await fs.promises.writeFile(to as string, fs.readFileSync(from as string));
      await fs.promises.rm(from as string, { force: true });
    });

    await writeFileAtomically(target, 'new export');

    expect(order).toEqual(['sync', 'rename']);
    expect(handle.close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(`${target}.part`, 'r+');
    expect(fs.readFileSync(target, 'utf8')).toBe('new export');
    rename.mockRestore();
  });

  it('removes the part file when the flush fails, leaving the previous content', async () => {
    const target = path.join(tempDir, 'flush-failed.json');
    fs.writeFileSync(target, 'previous export');
    const handle = {
      sync: vi.fn(async () => {
        throw new Error('EIO: i/o error');
      }),
      close: vi.fn(async () => undefined),
    };
    vi.spyOn(fs.promises, 'open').mockResolvedValue(handle as never);

    await expect(writeFileAtomically(target, 'new export')).rejects.toThrow('EIO');

    expect(fs.readFileSync(target, 'utf8')).toBe('previous export');
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });
});
