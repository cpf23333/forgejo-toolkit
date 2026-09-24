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

  it('reports both the declined and the failed deletions', () => {
    // The declined message used to win outright, so with one declined and two
    // failed the user was told only that they had cancelled and never learned
    // that two deletions errored out and left their attachments on the server.
    expect(attachmentDeleteNoticeFor({ declined: 1, failed: 2 })).toEqual({
      key: 'attachmentsNotDeletedAndFailed',
      count: 3,
    });
  });

  it('counts every surviving attachment in the mixed notice', () => {
    expect(attachmentDeleteNoticeFor({ declined: 2, failed: 5 })).toEqual({
      key: 'attachmentsNotDeletedAndFailed',
      count: 7,
    });
  });
});
