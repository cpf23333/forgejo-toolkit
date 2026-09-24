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
});
