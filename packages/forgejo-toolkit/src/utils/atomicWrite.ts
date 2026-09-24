import * as fs from 'fs';

/**
 * Write a file through a temporary sibling and rename it into place, so an
 * interrupted write can never destroy the file that is already there: the
 * target is replaced atomically by the rename (same directory, so the rename
 * does not cross a filesystem boundary), and a failure before that leaves the
 * previous content untouched.
 *
 * The `.part` suffix matches the artifact download (`api/client.ts`): a partial
 * export sits next to its target with the same recognizable name. The caller is
 * responsible for the data being complete in memory; nothing here streams.
 *
 * Two properties the plain rename would otherwise lose:
 *
 * - The target's mode is copied onto the temporary file. A rename replaces the
 *   target's inode, so a target the user restricted (0600 on a token-bearing
 *   export, say) came back with the temporary file's default mode — silently
 *   widening access to a file the user had narrowed. `chmod` is used rather than
 *   `writeFile`'s `mode` option because that option only applies when the file is
 *   created (a leftover `.part` from a crashed write would keep its own mode) and
 *   because the process umask would be applied a second time to a mode that
 *   already had it applied.
 * - The temporary file is flushed to the storage device before the rename. The
 *   rename is what makes the new content live under the target's name, so
 *   without the flush a crash right after it can leave that name pointing at
 *   data that never reached the disk.
 *
 * On failure the temporary file is removed (best effort — the original error is
 * what matters) and the error is re-thrown, so the caller reports the real
 * reason instead of a successful write.
 */
export async function writeFileAtomically(targetPath: string, data: string): Promise<void> {
  const tempPath = `${targetPath}.part`;
  try {
    // `stat` on a target that does not exist yet is the ordinary first write:
    // there is no mode to preserve, so the process default applies.
    const existingMode = await fs.promises
      .stat(targetPath)
      .then((stats) => stats.mode & 0o777)
      .catch(() => undefined);
    await fs.promises.writeFile(tempPath, data, 'utf8');
    if (existingMode !== undefined) {
      await fs.promises.chmod(tempPath, existingMode);
    }
    await syncFile(tempPath);
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Flush one file's contents to the storage device.
 *
 * The handle is opened read-write: `fsync` maps to `FlushFileBuffers` on
 * Windows, which fails on a handle without write access.
 */
async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
