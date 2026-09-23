import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { missingPayloadNotice } from '../prFileSystemProvider';

describe('missingPayloadNotice', () => {
  it('explains the withheld payload and names its size', () => {
    const notice = missingPayloadNotice(12 * 1024 * 1024);
    expect(notice).toBeDefined();
    // The message is localized, so the size travels as a placeholder argument.
    // The message carries the unit, so the placeholder receives the bare number.
    expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith(expect.stringContaining('browser'), '12.0');
  });

  it('stays silent when the server reported no size (a genuinely empty file)', () => {
    expect(missingPayloadNotice(0)).toBeUndefined();
    expect(missingPayloadNotice(undefined)).toBeUndefined();
  });
});
