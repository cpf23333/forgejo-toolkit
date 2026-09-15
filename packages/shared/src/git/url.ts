export function normalizeGitUrl(url: string): string {
  return url
    .replace(/\.git\/$/, '')
    .replace(/\.git$/, '')
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
