export interface AttachmentDeleteOutcome {
  /** Deletions the user declined at the host-side confirmation. */
  declined: number;
  /** Deletions that rejected (API/transport failure). */
  failed: number;
}

export interface AttachmentDeleteNotice {
  /** Message key below `dashboard.detail`. */
  key: 'attachmentsNotDeleted' | 'attachmentsDeleteFailed' | 'attachmentsNotDeletedAndFailed';
  count: number;
}

/**
 * Message for attachments that survived the delete list of a saved edit, or
 * `undefined` when every marked attachment was deleted. The host confirms each
 * delete separately, so a declined one (resolves `false`) or a failed one
 * (rejects) leaves the attachment in place — the user has to be told, otherwise
 * the edit dialog just closes and the mark disappears silently.
 *
 * A decline and a failure are two different facts and both are reported. The
 * declined confirmation used to win outright, which hid the deletions that
 * actually failed: with one declined and two failed the user read only that
 * they had cancelled, and never learned two attachments were left on the server
 * by an error. The mixed outcome therefore gets its own sentence naming both
 * causes, counted as every attachment that survived (which is what the user
 * sees still marked). A single-cause outcome keeps the sentence for that cause,
 * so the user's own cancel is never reported as a failure.
 */
export function attachmentDeleteNoticeFor(outcome: AttachmentDeleteOutcome): AttachmentDeleteNotice | undefined {
  if (outcome.declined > 0 && outcome.failed > 0) {
    return { key: 'attachmentsNotDeletedAndFailed', count: outcome.declined + outcome.failed };
  }
  if (outcome.declined > 0) {
    return { key: 'attachmentsNotDeleted', count: outcome.declined };
  }
  if (outcome.failed > 0) {
    return { key: 'attachmentsDeleteFailed', count: outcome.failed };
  }
  return undefined;
}
