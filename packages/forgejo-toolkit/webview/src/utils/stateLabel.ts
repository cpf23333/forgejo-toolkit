import type { useI18n } from 'vue-i18n';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * Localized label for an issue/PR state. Falls back to the raw value for
 * states outside the open/closed set so future server states stay readable.
 */
export function stateLabel(state: string | undefined, t: Translate): string {
  if (state === 'open') {
    return t('dashboard.state.open');
  }
  if (state === 'closed') {
    return t('dashboard.state.closed');
  }
  return state ?? '';
}
