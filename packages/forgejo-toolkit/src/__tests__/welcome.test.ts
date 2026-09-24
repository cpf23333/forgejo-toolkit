import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { maybeShowWelcomeOnboarding, markWelcomeOnboardingShown } from '../welcome';

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
  it('shows onboarding on an activation without instances and keeps offering it', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    // Skipping the guide (or closing it without adding anything) must not mark
    // it as seen: there would be no other way back to it with zero instances.
    expect(store.get(WELCOME_SHOWN_KEY)).toBeUndefined();
  });

  it('offers the guide again on the next activation while no instance exists', async () => {
    const { context } = createContext();
    const firstShow = vi.fn();
    const secondShow = vi.fn();

    await maybeShowWelcomeOnboarding(context, false, firstShow);
    const shownAgain = await maybeShowWelcomeOnboarding(context, false, secondShow);

    expect(firstShow).toHaveBeenCalledTimes(1);
    expect(shownAgain).toBe(true);
    expect(secondShow).toHaveBeenCalledTimes(1);
  });

  it('does not show onboarding when instances already exist, and records the flag', async () => {
    const { context, store } = createContext();
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, true, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(store.get(WELCOME_SHOWN_KEY)).toBe(true);
  });

  it('never shows again once the guide was completed', async () => {
    const { context } = createContext();
    await markWelcomeOnboardingShown(context);
    const show = vi.fn();

    const shown = await maybeShowWelcomeOnboarding(context, false, show);

    expect(shown).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it('does not show later when the first activation already had instances', async () => {
    const { context } = createContext();
    const laterShow = vi.fn();

    await maybeShowWelcomeOnboarding(context, true, vi.fn());
    // The user removes every instance afterwards: still no auto-open, because
    // the user did configure an instance at least once.
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

  it('does not swallow a failing flag write when the guide is completed', async () => {
    const { context } = createContext();
    vi.mocked(context.globalState.update).mockRejectedValue(new Error('storage gone'));

    // The completion path reports through the log, exactly like the automatic
    // one: a failed write must not reject the message handler.
    await expect(markWelcomeOnboardingShown(context)).resolves.toBeUndefined();
  });
});
