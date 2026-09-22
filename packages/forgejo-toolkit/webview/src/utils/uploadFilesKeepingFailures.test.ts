import { describe, expect, it, vi } from 'vitest';
import { uploadFilesKeepingFailures } from './uploadFilesKeepingFailures';

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

describe('uploadFilesKeepingFailures', () => {
  it('returns nothing when every upload succeeds', async () => {
    const upload = vi.fn(async () => undefined);
    await expect(uploadFilesKeepingFailures([file('a.png'), file('b.png')], upload)).resolves.toEqual([]);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('returns only the failed files and keeps uploading the rest', async () => {
    const upload = vi.fn(async (candidate: File) => {
      if (candidate.name === 'b.png') {
        throw new Error('boom');
      }
    });

    const remaining = await uploadFilesKeepingFailures([file('a.png'), file('b.png'), file('c.png')], upload);

    expect(remaining.map((entry) => entry.name)).toEqual(['b.png']);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('does not reject when every upload fails', async () => {
    const upload = vi.fn(async () => {
      throw new Error('boom');
    });

    const remaining = await uploadFilesKeepingFailures([file('a.png'), file('b.png')], upload);

    expect(remaining.map((entry) => entry.name)).toEqual(['a.png', 'b.png']);
  });

  it('handles an empty queue', async () => {
    const upload = vi.fn(async () => undefined);
    await expect(uploadFilesKeepingFailures([], upload)).resolves.toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });
});
