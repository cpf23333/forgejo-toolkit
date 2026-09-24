import * as vscode from 'vscode';
import { logger } from './logger';

export const WELCOME_SHOWN_KEY = 'forgejoToolkit.hasShownWelcome';

/**
 * Records that the first-run guide has been dealt with, so it is not opened
 * automatically again. Called when the user finishes the guide, and on the
 * first activation that already finds a configured instance. A failed write is
 * logged, not propagated: the worst case is the panel appearing once more.
 */
export async function markWelcomeOnboardingShown(context: vscode.ExtensionContext): Promise<void> {
  try {
    await context.globalState.update(WELCOME_SHOWN_KEY, true);
  } catch (error) {
    // A failed flag write must not suppress the guide; the worst case is the
    // panel appearing once more on the next activation.
    logger.error(
      `Failed to record welcome onboarding state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * First-run onboarding: opens the setup guide once when no instance is
 * configured yet. Returns true when the guide was shown.
 *
 * The flag is only written when instances exist, or when the user finished the
 * guide (which calls `markWelcomeOnboardingShown`). It used to be written on
 * the very first activation even if the user skipped the guide, and nothing
 * ever reopened it: a user who skipped with zero instances had to rediscover
 * the dashboard's empty-state button. Now the guide keeps offering itself until
 * an instance exists or the guide is actually completed.
 */
export async function maybeShowWelcomeOnboarding(
  context: vscode.ExtensionContext,
  hasInstances: boolean,
  showOnboarding: () => void,
): Promise<boolean> {
  if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY, false)) {
    return false;
  }
  if (hasInstances) {
    await markWelcomeOnboardingShown(context);
    return false;
  }
  showOnboarding();
  return true;
}
