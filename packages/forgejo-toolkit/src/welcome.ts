import * as vscode from 'vscode';

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
  await context.globalState.update(WELCOME_SHOWN_KEY, true);
  if (hasInstances) {
    return false;
  }
  showOnboarding();
  return true;
}
