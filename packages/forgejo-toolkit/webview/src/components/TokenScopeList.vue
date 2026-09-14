<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

// Scope names are technical identifiers (identical in every locale), so only
// the descriptions are translated. The list mirrors the API surface used by
// the extension host client; Forgejo has no "pull" scope — pull request
// endpoints fall under the repository category.
const readScopes: Array<{ scope: string; descriptionKey: string }> = [
  { scope: 'read:user', descriptionKey: 'settings.tokenScopes.readUser' },
  { scope: 'read:repository', descriptionKey: 'settings.tokenScopes.readRepository' },
  { scope: 'read:issue', descriptionKey: 'settings.tokenScopes.readIssue' },
  { scope: 'read:notification', descriptionKey: 'settings.tokenScopes.readNotification' },
];
const writeScopes: Array<{ scope: string; descriptionKey: string }> = [
  { scope: 'write:repository', descriptionKey: 'settings.tokenScopes.writeRepository' },
  { scope: 'write:issue', descriptionKey: 'settings.tokenScopes.writeIssue' },
  { scope: 'write:notification', descriptionKey: 'settings.tokenScopes.writeNotification' },
];
</script>

<template>
  <div class="token-scopes">
    <p class="token-scopes-title">{{ t('settings.tokenScopes.title') }}</p>
    <p class="token-scopes-header">{{ t('settings.tokenScopes.readHeader') }}</p>
    <ul>
      <li v-for="item in readScopes" :key="item.scope">
        <code>{{ item.scope }}</code> — {{ t(item.descriptionKey) }}
      </li>
    </ul>
    <p class="token-scopes-header">{{ t('settings.tokenScopes.writeHeader') }}</p>
    <ul>
      <li v-for="item in writeScopes" :key="item.scope">
        <code>{{ item.scope }}</code> — {{ t(item.descriptionKey) }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.token-scopes {
  margin-top: 4px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.token-scopes-title {
  margin: 0 0 4px;
}

.token-scopes-header {
  margin: 6px 0 2px;
  font-weight: 600;
}

.token-scopes ul {
  margin: 0;
  padding-left: 18px;
}

.token-scopes li {
  margin: 2px 0;
}

.token-scopes code {
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15));
  padding: 0 4px;
  border-radius: 3px;
}
</style>
