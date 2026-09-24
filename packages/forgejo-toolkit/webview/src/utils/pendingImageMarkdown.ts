/**
 * Removes a pending body image that will never be uploaded from a markdown body.
 *
 * The editor inserts `![image](<objectUrl>)` when the user picks an image
 * (`EasyMdeEditor`'s `imageUploadFunction`), and the create flow later swaps that
 * `blob:` URL for the uploaded attachment URL. If the user removes the image from
 * the pending attachment list before submitting, no upload happens, so the
 * session-only `blob:` URL must not reach the server: the saved issue or pull
 * request would render a broken image forever.
 *
 * The URL is removed wherever it appears (the user may have edited the alt text
 * or reused the URL in a link), and the image syntax it leaves behind —
 * `![image]()` — is dropped with it.
 */
export function removePendingImageFromBody(body: string, objectUrl: string): string {
  if (!body || !objectUrl) {
    return body;
  }
  return body.replaceAll(objectUrl, '').replace(/!\[[^\]]*\]\(\s*\)/g, '');
}
