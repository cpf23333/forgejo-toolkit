import { describe, expect, it } from 'vitest';
import { attachmentDeleteNoticeFor } from './attachmentDeleteNotice';

describe('attachmentDeleteNoticeFor', () => {
  it('stays silent when every marked attachment was deleted', () => {
    expect(attachmentDeleteNoticeFor({ declined: 0, failed: 0 })).toBeUndefined();
  });

  it('reports declined confirmations with their count', () => {
    expect(attachmentDeleteNoticeFor({ declined: 2, failed: 0 })).toEqual({ key: 'attachmentsNotDeleted', count: 2 });
  });

  it('reports failures when nothing was declined', () => {
    expect(attachmentDeleteNoticeFor({ declined: 0, failed: 3 })).toEqual({ key: 'attachmentsDeleteFailed', count: 3 });
  });

  it('prefers the declined message when both happened', () => {
    // Cancelling is the user's own choice: it must not be reported as a failure.
    expect(attachmentDeleteNoticeFor({ declined: 1, failed: 2 })).toEqual({ key: 'attachmentsNotDeleted', count: 1 });
  });
});
