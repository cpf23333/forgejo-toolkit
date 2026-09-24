/**
 * A URL with its credentials removed, for display and logging.
 *
 * A configured instance URL or a repository remote may embed credentials
 * (`https://user:token@host`, `https://<token>@host`), and the values reach the
 * extension's output channel, the MCP server's stderr, and the webview. Only
 * credential material is replaced: a password, and the username of an http(s)
 * URL that carries no password, where a token is commonly written in the
 * username position (`https://<token>@host/owner/repo.git`). A plain ssh user
 * (`ssh://git@host/...`) names the login, not a secret, and stays visible, as do
 * the host and path a user needs to recognise the URL.
 *
 * This is the single implementation of that rule, kept in a module that imports
 * nothing — least of all `vscode` — because the API client and the MCP bundle
 * log instance URLs and must stay free of the extension host's module graph.
 * `redactRemoteUrl` in `worktree/gitOperations.ts` and `redactInstanceUrl` in
 * `api/versionProbe.ts` re-export or delegate to it.
 */
export function redactUrlUserinfo(url: string): string {
  if (!url.includes('@')) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: the scp-like `user@host:path` form carries no
    // password, so there is nothing to strip.
    return url;
  }
  if (!parsed.username && !parsed.password) {
    return url;
  }
  if (parsed.password) {
    parsed.password = '***';
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // The username is the only userinfo here, so it is the functional
    // equivalent of a password (a Forgejo access token).
    parsed.username = '***';
  }
  return parsed.toString();
}
