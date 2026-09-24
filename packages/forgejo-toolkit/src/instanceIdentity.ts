/**
 * Build the id a Forgejo instance is stored under.
 *
 * The id keys both the saved configuration and the secret holding the access
 * token (see config.ts), so two instances that compute the same id silently
 * overwrite each other: https://host/a and https://host/b are different
 * instances but used to collapse into `host-login`. A root-path URL keeps that
 * plain id - re-keying existing installations would orphan the token stored
 * under the old id - while a sub-path appends a stable slug, so both coexist.
 */
export function instanceIdFor(normalizedUrl: string, login: string): string {
  const parsed = new URL(normalizedUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path === '') {
    return `${parsed.host}-${login}`;
  }
  const slug = path
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${parsed.host}-${slug}-${login}`;
}

/**
 * The display name an instance is stored under: `<login>@<host><sub-path>`.
 *
 * Must be derived the same way by every entry point that saves an instance.
 * `name` is part of the webview's instance cache identity
 * (`webview/src/composables/useAppState.ts`), so a form that drops the
 * sub-path rewrites the identity of an extra-path instance on a plain edit and
 * makes the view discard every payload cached for it.
 */
export function instanceNameFor(normalizedUrl: string, login: string): string {
  const parsed = new URL(normalizedUrl);
  return `${login}@${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}
