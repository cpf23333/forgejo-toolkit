import type { AiPreReviewPanel } from './aiPreReviewPanel';

/**
 * The open AI pre-review panels, keyed by the id each one mints for itself.
 *
 * The contributed context-menu items on a suggestion card have to reach **the panel the
 * card belongs to**, and that panel is not a singleton: `AiPreReviewPanel.createOrShow`
 * unconditionally creates a new editor-area panel, so two runs can leave two panels open
 * at once (deliberately — each carries its own run's candidates and its own decision).
 * A "whichever panel is current" reference would therefore route an item to the newest
 * panel rather than to the card that was right-clicked, which is why the identity travels
 * with the marker and this registry resolves it.
 *
 * The registry is scoped to the extension host process, which is the scope the commands
 * run in, and it is a **registry by identity, not by recency**: a lookup with an id that
 * is not in it returns `undefined`, and the command then refuses with a sentence instead
 * of acting on some other panel. A panel joins here when it is created and leaves when it
 * is disposed (see `AiPreReviewPanel`), so a closed tab leaves nothing behind.
 */
const panels = new Map<string, AiPreReviewPanel>();

/** Records one open panel under the id it minted. */
export function registerAiPreReviewPanel(id: string, panel: AiPreReviewPanel): void {
  panels.set(id, panel);
}

/** Forgets one panel, by the id it was registered under. */
export function unregisterAiPreReviewPanel(id: string): void {
  panels.delete(id);
}

/**
 * The open panel an id names, or `undefined` when nothing is registered under it.
 *
 * The argument is whatever the context-menu marker carried, so it is checked for being a
 * string here rather than at every call site.
 */
export function findAiPreReviewPanel(id: unknown): AiPreReviewPanel | undefined {
  return typeof id === 'string' && id !== '' ? panels.get(id) : undefined;
}

/** How many panels are registered — the registry's own leak check, and its tests'. */
export function registeredAiPreReviewPanelCount(): number {
  return panels.size;
}
