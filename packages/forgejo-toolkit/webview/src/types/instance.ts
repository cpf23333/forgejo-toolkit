// Instance data as seen by the webview. The access token stays in the
// extension host (SecretStorage) and is never sent here; only an opaque
// fingerprint of it travels, so the webview can notice that the credential
// behind an instance changed.
export interface ForgejoInstance {
  id: string;
  /**
   * The display value: the host masks credentials in it
   * (`https://***@forgejo.example.com/`), so it must never be handed to git or
   * opened in a browser. Use `functionalUrl` for anything the webview uses.
   */
  url: string;
  /**
   * The same URL with the credential split off, for links and clone URLs (see
   * `functionalInstanceUrl`). Optional because a payload from a host build that
   * predates the field does not carry it.
   */
  functionalUrl?: string;
  name: string;
  username: string;
  tokenFingerprint?: string;
  syncApiUrlsToInstanceUrl?: boolean;
  /**
   * The Forgejo version the user declared for this instance (`16.0.2`,
   * `16.0.2+gitea-1.22.0`), or absent when the instance uses the automatic
   * probe. The Settings editor is where it is typed, so the field has to travel
   * here; the host validates it on save and the feature gates read the stored
   * value in preference to the probe.
   */
  declaredServerVersion?: string;
}

export * from './api';
