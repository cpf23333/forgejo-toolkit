import * as vscode from 'vscode';
import { logger } from './logger';
import { createWelcomeMarker } from './welcomeMarker';

/**
 * The permanent record that this profile has dealt with the first-run guide, in
 * the editor's state store. It is written exactly where it always was — when the
 * user finishes the guide, and on the first activation that finds an instance —
 * and it is what keeps the guide from coming back once the user is past the
 * first-run step. What it cannot do is arbitrate *concurrent* offers, because
 * its read-then-write is not atomic across windows; that is the marker token's
 * job (`welcomeMarker.ts`), and it is temporary by design. See
 * `maybeShowWelcomeOnboarding` for how the two interact.
 */
export const WELCOME_SHOWN_KEY = 'forgejoToolkit.hasShownWelcome';

/**
 * Records that the first-run guide has been dealt with, so it is not opened
 * automatically again. Called when the user finishes the guide, and by
 * `maybeShowWelcomeOnboarding` on the first activation that finds an instance. A
 * failed write is logged, not propagated: the worst case is the panel appearing
 * once more, which is the pre-marker behaviour.
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
 * Two records, two jobs — the whole point of the split:
 *
 * - **The legacy flag (`WELCOME_SHOWN_KEY`) is the permanent record**, written
 *   exactly where it always was: when the user finishes the guide
 *   (`markWelcomeOnboardingShown`, called from the onboarding panel) and on the
 *   first activation that finds an instance. Once it is set, the guide is never
 *   offered automatically again.
 * - **The marker token (`welcomeMarker.ts`) is an in-flight offer**, not a
 *   record: the window that creates it opens the guide, and the other windows of
 *   the profile stay silent *while that offer is plausibly live* (the owner
 *   process exists and the token is fresh). A token whose owner is gone or whose
 *   offer expired is taken over by the next activation, so the guide keeps
 *   offering itself — on every activation — until an instance exists or the user
 *   completes it, which is the behaviour this guide has always had.
 *
 * So there are four outcomes, and only the first shows the guide:
 *
 * - This window created the token → show the guide, and do *not* write the flag:
 *   showing is not completing, and the flag would then silence the guide forever
 *   for a user who skipped it with nothing configured.
 * - Another window's offer is live → stay silent.
 * - A token that could not be created or taken over (a read-only profile
 *   directory, a denied create) → show the guide anyway. The token is an
 *   optimization; it must never be the reason the guide does not appear.
 * - The flag is already set, or an instance exists → do not show, exactly as
 *   before the token existed.
 */
export async function maybeShowWelcomeOnboarding(
  context: vscode.ExtensionContext,
  hasInstances: boolean,
  showOnboarding: () => void,
): Promise<boolean> {
  if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY, false)) {
    // The user finished the guide, or an earlier activation found an instance:
    // the permanent record already says "dealt with", and the upgrade that adds
    // the token must not bring the guide back. No token is written either — this
    // window is not offering the guide, so it has no offer to publish.
    return false;
  }
  if (hasInstances) {
    // An instance is configured, so the guide has served its purpose. This is
    // the transition the permanent record exists for.
    await markWelcomeOnboardingShown(context);
    return false;
  }
  const outcome = await createWelcomeMarker(context);
  if (outcome === 'live') {
    // Another window of this profile is showing the guide right now. Staying
    // silent here is the entire reason the token exists — windows restored
    // together used to open one panel each.
    return false;
  }
  // Either this window's create won, or the token could not be created or taken
  // over. Both mean the guide appears in this window; a token that cannot be
  // written must never suppress the first-run guide.
  showOnboarding();
  return true;
}
