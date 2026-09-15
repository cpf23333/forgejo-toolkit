export function normalizeGitUrl(url: string): string {
  return url
    .replace(/\.git\/$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
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
