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
//
// This runner chains the three steps a generation needs to be trustworthy:
// `generate` (which now formats its own output, so the diff is reviewable),
// then a workspace-wide type check, which is what catches a renamed or reshaped
// generated type in the hand-written client that consumes it.
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

// The generator ran, so the tree holds the new output — which is only useful if
// it type-checks. The check covers the whole workspace, not just this package:
// the generated names are consumed by `forgejo-toolkit`'s hand-written client,
// so a rename or a changed shape breaks there first. A failure here does NOT
// restore: the diff is the evidence of what changed, and it is what has to be
// reviewed or fixed.
console.error('\ngenerate:safe: type-checking the workspace against the new output…');
try {
  execFileSync('pnpm -w run check', { cwd: packageDir, stdio: 'inherit', shell: true });
  console.error('generate:safe: done — generation, formatting and type-checking all passed.');
} catch (error) {
  console.error(
    '\ngenerate:safe: the generated output does not type-check. The files are left in place so the diff can be reviewed; fix the consuming code (or the spec/pins) and re-run.\n',
  );
  process.exit(typeof error?.status === 'number' ? error.status : 1);
}
