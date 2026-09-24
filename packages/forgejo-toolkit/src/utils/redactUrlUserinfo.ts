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
 *
 * Masking is only ever right for a value a human reads. `stripUrlUserinfo`
 * below serves the other half — a URL the extension (or git) then *uses* — and
 * `hasUrlUserinfo` answers the storage boundary's question of whether a URL
 * carries a credential at all.
 */
export function redactUrlUserinfo(url: string): string {
  return rewriteUserinfo(url, (parsed) => {
    if (parsed.password) {
      parsed.password = '***';
    } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // The username is the only userinfo here, so it is the functional
      // equivalent of a password (a Forgejo access token).
      parsed.username = '***';
    }
  });
}

/**
 * A URL with its credentials removed entirely, for a URL that is *used* rather
 * than displayed: a permalink on the clipboard, a `DocumentLink` target, an
 * issue body, or a clone URL handed to git.
 *
 * `redactUrlUserinfo` masks the credential (`https://alice:***@host`), which is
 * right for a log line or a label but wrong for anything functional: `***` is
 * not a credential, and Node's `fetch` refuses to build a request from a URL
 * that carries credentials at all. Such a URL either fails outright or — for
 * `git clone`, which persists the URL it cloned as `remote.origin.url` — writes
 * the credential to disk. So the whole userinfo is dropped, and the URL stays
 * usable against a server that authenticates its caller some other way (the
 * `Authorization` header, or the user's own git credential helper).
 *
 * A URL with no userinfo is returned untouched, so this helper never rewrites
 * the spelling of the ordinary case. Like the redaction rule, the credential
 * ends up in the username position of an http(s) URL that carries no password
 * (`https://<token>@host`); both positions are dropped.
 */
export function stripUrlUserinfo(url: string): string {
  return rewriteUserinfo(url, (parsed) => {
    parsed.username = '';
    parsed.password = '';
  });
}

/**
 * True when `url` is an absolute http(s) URL carrying credentials as userinfo.
 *
 * The storage boundary uses this to refuse such a URL rather than persist one
 * that can never work: Node's `fetch` refuses to construct a request from a URL
 * with credentials, so the instance fails every call with a transport error the
 * API layer classifies as `network` — a message blaming the instance's
 * availability for what is really a credential in the wrong field (the access
 * token belongs in the token field, where it is stored in SecretStorage and
 * sent as a header).
 */
export function hasUrlUserinfo(url: string): boolean {
  if (!url.includes('@')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: the scp-like `user@host:path` form carries no
    // password, and it is not an instance URL anyway.
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return Boolean(parsed.username) || Boolean(parsed.password);
}

/**
 * The parse-and-rewrite core shared by both helpers: a URL with no `@` at all,
 * an unparseable value, or one whose userinfo is already empty is returned
 * exactly as given (so a scp-style remote or a local path is never mangled).
 */
function rewriteUserinfo(url: string, rewrite: (parsed: URL) => void): string {
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
  rewrite(parsed);
  return parsed.toString();
}
