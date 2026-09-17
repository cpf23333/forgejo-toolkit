import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { maybeShowWelcomeOnboarding } from '../welcome';

const WELCOME_SHOWN_KEY = 'forgejoToolkit.hasShownWelcome';

function createContext() {
  const store = new Map<string, unknown>();
  const context = {
    globalState: {
      get: vi.fn((key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue)),
      update: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
  } as unknown as vscode.ExtensionContext;
  return { context, store };
}

describe('maybeShowWelcomeOnboarding', () => {
  it('shows onboarding on first activation without instances and records the flag', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(store.get(WELCOME_SHOWN_KEY)).toBe(true);
  });

  it('does not show onboarding when instances already exist, but still records the flag', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, true, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(store.get(WELCOME_SHOWN_KEY)).toBe(true);
  });

  it('never shows again after the first activation', async () => {
    const { context } = createContext();
    const firstShow = vi.fn();
    const secondShow = vi.fn();

    await maybeShowWelcomeOnboarding(context, false, firstShow);
    const shownAgain = await maybeShowWelcomeOnboarding(context, false, secondShow);

    expect(firstShow).toHaveBeenCalledTimes(1);
    expect(shownAgain).toBe(false);
    expect(secondShow).not.toHaveBeenCalled();
  });

  it('does not show later when the first activation already had instances', async () => {
    const { context } = createContext();
    const laterShow = vi.fn();

    await maybeShowWelcomeOnboarding(context, true, vi.fn());
    // The user removes every instance afterwards: still no auto-open.
    const shown = await maybeShowWelcomeOnboarding(context, false, laterShow);

    expect(shown).toBe(false);
    expect(laterShow).not.toHaveBeenCalled();
  });

  it('still shows onboarding when recording the flag fails', async () => {
    const { context } = createContext();
    vi.mocked(context.globalState.update).mockRejectedValue(new Error('storage gone'));
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    // The failure is logged, not propagated: a storage hiccup must not
    // suppress the first-run guide (nor reject the activation promise).
    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
