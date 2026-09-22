export interface AttachmentDeleteOutcome {
  /** Deletions the user declined at the host-side confirmation. */
  declined: number;
  /** Deletions that rejected (API/transport failure). */
  failed: number;
}

export interface AttachmentDeleteNotice {
  /** Message key below `dashboard.detail`. */
  key: 'attachmentsNotDeleted' | 'attachmentsDeleteFailed';
  count: number;
}

/**
 * Message for attachments that survived the delete list of a saved edit, or
 * `undefined` when every marked attachment was deleted. The host confirms each
 * delete separately, so a declined one (resolves `false`) or a failed one
 * (rejects) leaves the attachment in place — the user has to be told, otherwise
 * the edit dialog just closes and the mark disappears silently.
 *
 * A declined confirmation wins over a failure: the user chose that one, and
 * reporting their own cancel as a failure would be misleading.
 */
export function attachmentDeleteNoticeFor(outcome: AttachmentDeleteOutcome): AttachmentDeleteNotice | undefined {
  if (outcome.declined > 0) {
    return { key: 'attachmentsNotDeleted', count: outcome.declined };
  }
  if (outcome.failed > 0) {
    return { key: 'attachmentsDeleteFailed', count: outcome.failed };
  }
  return undefined;
}
