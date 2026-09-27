// Runs the client generator with its wipe hazard guarded.
//
// `kubb` deletes `src/generated` before writing (`output.clean: true`), so a run
// that fails — a bad spec, a native crash — leaves the directory empty. This runner
// delegates to the `generate` script (so the two steps stay in sync), refuses to
// start on a dirty generated tree, and restores it from git when the run fails.
//
// If every plugin fails with `null byte is not allowed in input` naming some
// unrelated executable (a CLI harness, an editor, an SDK manager), the cause is
// the *environment*, not the spec: kubb's configuration loader reads variables
// that such tools inject (their own install paths, sometimes with characters a
// parser rejects), and one of them derails every plugin. Run the generator with a
// cleaned environment — drop the tool's own variables and any `PATH` entry that
// points at its installation — and it succeeds. Also remember that the generated
// sources are formatted: a fresh run looks like a thousands-of-files diff until
// `pnpm format:fix` has run, and then it should be a no-op on an up-to-date tree.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: packageDir, encoding: 'utf8' }).trim();

const dirty = git(['status', '--porcelain', '--', 'src/generated']);
if (dirty) {
  console.error('generate:safe: src/generated has local changes; commit or restore them first:');
  console.error(dirty);
  process.exit(1);
}

try {
  execFileSync('pnpm run generate', { cwd: packageDir, stdio: 'inherit', shell: true });
} catch (error) {
  console.error('\ngenerate:safe: the generator failed — restoring src/generated from git.');
  try {
    git(['restore', '--source=HEAD', '--worktree', '--', 'src/generated']);
    console.error('generate:safe: restored; fix the generator before retrying.');
  } catch {
    console.error(
      'generate:safe: restore failed; run `git restore --source=HEAD --worktree -- packages/forgejo-api/src/generated` yourself.',
    );
  }
  process.exit(typeof error?.status === 'number' ? error.status : 1);
}
