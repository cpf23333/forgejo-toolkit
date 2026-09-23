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
