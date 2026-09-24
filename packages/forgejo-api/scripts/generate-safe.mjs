// Runs the client generator with its wipe hazard guarded.
//
// `kubb` deletes `src/generated` before writing, so a run that fails — a bad spec, a
// native crash — leaves the directory empty (it did exactly that on 2026-09-23). This
// wrapper refuses to start on a dirty generated tree and restores it from git when the
// run fails, so the generator can never take the client away.
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

function run(command) {
  execFileSync(command, { cwd: packageDir, stdio: 'inherit', shell: true });
}

try {
  run('pnpm exec kubb generate');
  run('node scripts/strip-ts-extensions.js');
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
