export function normalizeGitUrl(url: string): string {
  // The suffix checks run before the final lowercasing and are case-insensitive:
  // a remote written `…/repo.GIT` is the same repository as `…/repo.git`, and
  // leaving the suffix in place produced the repo name `repo.git`, which misses
  // every API route, `sameRepositoryUrl` comparison and revert target. Only a
  // *trailing* suffix is removed, so the forms already handled keep their
  // behaviour (`…/repo.git/` → `…/repo`, `…/repo/` → `…/repo`).
  return url
    .replace(/\.git\/$/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * True when the remote uses an SSH/git transport (ssh://, git://, or
 * scp-style git@host:path). Ports on those URLs are transport-level and have
 * no relation to the web port of a configured instance (a self-hosted server
 * commonly serves SSH on 2222 while the web UI runs on 3000), so instance
 * matching compares them against the instance host without its port.
 */
export function isSshOrGitRemote(url: string): boolean {
  const cleaned = url.trim().toLowerCase();
  return cleaned.startsWith('git@') || cleaned.startsWith('ssh://') || cleaned.startsWith('git://');
}

/**
 * Normalize a git remote URL to a lowercase `host/owner/repo` form and split
 * out the owner and repository names; returns `undefined` for input that is
 * not a parseable remote or has no owner/repo path.
 *
 * Not called by the toolkit's production code today: the active implementation
 * lives in the extension host's `worktree/gitOperations.ts`
 * (`parseRemoteUrl`/`remoteComparisonKeys`), which inherits this function's
 * structural rules — scp-style `git@host:path` syntax, transport-level
 * ssh/git ports stripped, http(s) ports kept, `.git` suffix and trailing
 * slashes removed, lowercase comparison form. Kept exported as a public
 * utility API of the shared package.
 */
export function normalizeGitRemote(url: string): { normalized: string; owner: string; repo: string } | undefined {
  const cleaned = url.trim();
  let hostPath: string | undefined;

  if (cleaned.startsWith('git@')) {
    const match = cleaned.match(/^git@([^:]+):(.+)$/);
    if (match) {
      hostPath = `${match[1]}/${match[2]}`;
    }
  } else {
    try {
      const parsed = new URL(cleaned);
      // ssh:// and git:// ports are transport-level (self-hosted servers often
      // serve SSH on 2222 while HTTPS stays on 443), so they can never match
      // the http(s) port of a configured instance; strip them. http(s) ports
      // stay: an instance may genuinely run on a non-default web port, and
      // parsed.host already drops the default 80/443.
      const host = parsed.protocol === 'ssh:' || parsed.protocol === 'git:' ? parsed.hostname : parsed.host;
      hostPath = `${host}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }

  if (!hostPath) {
    return undefined;
  }

  const normalized = normalizeGitUrl(hostPath);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 3) {
    return undefined;
  }

  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  return { normalized, owner, repo };
}
