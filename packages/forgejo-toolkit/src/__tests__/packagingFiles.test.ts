import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The `.vsix` is packaged from `packages/forgejo-toolkit`, so the files a
 * distribution must carry live there as copies of their repository-root
 * originals. A copy that drifts is worse than none (it ships a stale license or
 * changelog), so the copies are compared byte for byte here.
 *
 * Line endings are normalized first: the repository stores LF, but a Windows
 * checkout may hand them over as CRLF.
 */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

function read(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

describe('packaged metadata files', () => {
  it.each(['LICENSE', 'CHANGELOG.md'])('ships %s as an exact copy of the root file', (name) => {
    expect(read(path.join(packageRoot, name))).toBe(read(path.join(repoRoot, name)));
  });

  it('attributes the bundled third-party work in NOTICE', () => {
    const notice = read(path.join(packageRoot, 'NOTICE'));
    // Codicons is vendored as a font file, and DOMPurify is the one bundled
    // dependency that is not MIT, so both must stay attributed.
    expect(notice).toContain('vscode-codicons');
    expect(notice).toContain('dompurify');
    expect(notice).toContain('Apache-2.0');
  });
});
