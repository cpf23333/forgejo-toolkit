import * as vscode from 'vscode';
import { logger } from './logger';

const WELCOME_SHOWN_KEY = 'forgejoToolkit.hasShownWelcome';

/**
 * First-run onboarding: opens the setup guide once, on the first activation
 * that finds no configured instance. The flag is written on the first
 * activation regardless, so the panel never pops up later (e.g. after the
 * user removes every instance). Returns true when the guide was shown.
 */
export async function maybeShowWelcomeOnboarding(
  context: vscode.ExtensionContext,
  hasInstances: boolean,
  showOnboarding: () => void,
): Promise<boolean> {
  if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY, false)) {
    return false;
  }
  try {
    await context.globalState.update(WELCOME_SHOWN_KEY, true);
  } catch (error) {
    // A failed flag write must not suppress the guide; the worst case is the
    // panel appearing once more on the next activation.
    logger.error(
      `Failed to record welcome onboarding state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (hasInstances) {
    return false;
  }
  showOnboarding();
  return true;
}
