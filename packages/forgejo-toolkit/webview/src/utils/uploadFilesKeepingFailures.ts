/**
 * Uploads `files` concurrently and returns the ones that failed, so a caller
 * that has already created its issue/pull request/comment can retry only the
 * remainder instead of creating a duplicate.
 *
 * Never rejects: the resource exists by the time this runs, so one failed
 * upload must not abort the others or hide their outcome.
 */
export async function uploadFilesKeepingFailures(
  files: File[],
  upload: (file: File) => Promise<unknown>,
): Promise<File[]> {
  const remaining: File[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        await upload(file);
      } catch {
        remaining.push(file);
      }
    }),
  );
  return remaining;
}
