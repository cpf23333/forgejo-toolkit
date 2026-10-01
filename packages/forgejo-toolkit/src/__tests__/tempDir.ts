import * as fs from 'fs';

/**
 * Removal options for a temporary directory a test created with
 * `fs.mkdtempSync(os.tmpdir(), …)`.
 *
 * Without `maxRetries` a single `EPERM`/`EBUSY`/`ENOTEMPTY` aborts the removal,
 * and on Windows that is exactly what a concurrent reader or a just-released
 * handle under the tree produces: the two vitest suites here are routinely run
 * side by side, and a child process or a `readdir` one tick behind makes `rmdir`
 * fail against a path whose files were already deleted. Node retries precisely
 * those transient codes when it is given the two options.
 *
 * The retry is a backstop, not the fix: a test that knows a handle or a child
 * could still be alive has to await or close it first (see the credential-flow
 * case in `viewProviderDispatch.test.ts`, which waits for the mocked clone's own
 * async work and for the flow's terminal reply before the directory goes away).
 */
export const tempDirRemovalOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const satisfies fs.RmOptions;

/**
 * Removes a `mkdtemp` directory without tripping over a handle still closing.
 * Meant for `afterEach`/`finally`; a test that knows the handle outlives that
 * has to close it first.
 */
export function removeTempDirSync(dir: string): void {
  fs.rmSync(dir, tempDirRemovalOptions);
}

/** Async counterpart of `removeTempDirSync`, for `afterEach(async …)`. */
export async function removeTempDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, tempDirRemovalOptions);
}
