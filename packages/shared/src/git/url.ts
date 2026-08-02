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
      hostPath = `${parsed.host}${parsed.pathname}`;
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
