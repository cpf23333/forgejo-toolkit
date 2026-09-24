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
 * On failure the temporary file is removed (best effort — the original error is
 * what matters) and the error is re-thrown, so the caller reports the real
 * reason instead of a successful write.
 */
export async function writeFileAtomically(targetPath: string, data: string): Promise<void> {
  const tempPath = `${targetPath}.part`;
  try {
    await fs.promises.writeFile(tempPath, data, 'utf8');
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
