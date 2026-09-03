import { describe, expect, it } from 'vitest';
import { computeTokenConflicts } from '../instanceImport';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function instance(id: string, token: string): ForgejoInstance {
  return { id, token, url: 'https://forgejo.example.com', name: id, username: 'user' };
}

describe('computeTokenConflicts', () => {
  it('flags an imported token that belongs to a different stored instance', () => {
    const imported = [instance('new-1', 'tok-a')];
    const existing = [instance('old-1', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
  });

  it('does not flag re-importing the unchanged token over its own instance', () => {
    const imported = [instance('inst-1', 'tok-a')];
    const existing = [instance('inst-1', 'tok-a'), instance('inst-2', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([false]);
  });

  it('flags a changed token that collides with another stored instance', () => {
    const imported = [instance('inst-1', 'tok-b')];
    const existing = [instance('inst-1', 'tok-a'), instance('inst-2', 'tok-b')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
  });

  it('does not flag tokens unknown to the stored instances', () => {
    const imported = [instance('new-1', 'tok-x'), instance('new-2', 'tok-y')];
    const existing = [instance('old-1', 'tok-a')];
    expect(computeTokenConflicts(imported, existing)).toEqual([false, false]);
  });

  it('treats empty tokens like any other string (matches the previous webview behavior)', () => {
    const imported = [instance('new-1', '')];
    const existing = [instance('old-1', '')];
    expect(computeTokenConflicts(imported, existing)).toEqual([true]);
    expect(computeTokenConflicts([instance('old-1', '')], existing)).toEqual([false]);
  });
});
