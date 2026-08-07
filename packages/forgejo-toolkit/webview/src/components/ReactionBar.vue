<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ForgejoReaction } from '../types/api';

const { t } = useI18n();

interface Props {
  reactions: ForgejoReaction[];
  currentUsername?: string;
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  currentUsername: '',
  loading: false,
});

const emit = defineEmits<{
  toggle: [content: string, add: boolean];
}>();

const availableReactions: { content: string; emoji: string }[] = [
  { content: '+1', emoji: '👍' },
  { content: '-1', emoji: '👎' },
  { content: 'laugh', emoji: '😄' },
  { content: 'hooray', emoji: '🎉' },
  { content: 'confused', emoji: '😕' },
  { content: 'heart', emoji: '❤️' },
  { content: 'rocket', emoji: '🚀' },
  { content: 'eyes', emoji: '👀' },
];

const reactionMap = new Map(availableReactions.map((r) => [r.content, r.emoji]));

const groupedReactions = computed(() => {
  const groups = new Map<string, { count: number; hasSelf: boolean }>();
  for (const reaction of props.reactions) {
    const content = reaction.content ?? '';
    if (!content) {
      continue;
    }
    const existing = groups.get(content) ?? { count: 0, hasSelf: false };
    existing.count += 1;
    if (reaction.user?.login === props.currentUsername) {
      existing.hasSelf = true;
    }
    groups.set(content, existing);
  }
  return Array.from(groups.entries())
    .map(([content, data]) => ({ content, ...data }))
    .sort(
      (a, b) =>
        availableReactions.findIndex((r) => r.content === a.content) -
        availableReactions.findIndex((r) => r.content === b.content),
    );
});

const remainingReactions = computed(() => {
  const used = new Set(groupedReactions.value.filter((g) => g.hasSelf).map((g) => g.content));
  return availableReactions.filter((r) => !used.has(r.content));
});

function emojiFor(content: string): string {
  return reactionMap.get(content) ?? content;
}

function toggleReaction(content: string, hasSelf: boolean) {
  emit('toggle', content, !hasSelf);
}
</script>

<template>
  <div class="reaction-bar">
    <button
      v-for="group in groupedReactions"
      :key="group.content"
      type="button"
      class="reaction-chip"
      :class="{ active: group.hasSelf }"
      :disabled="loading"
      :title="group.hasSelf ? t('dashboard.detail.removeReaction') : t('dashboard.detail.addReaction')"
      @click="toggleReaction(group.content, group.hasSelf)"
    >
      <span class="reaction-emoji">{{ emojiFor(group.content) }}</span>
      <span class="reaction-count">{{ group.count }}</span>
    </button>
    <div class="reaction-add">
      <button type="button" class="reaction-add-button" :disabled="loading" :title="t('dashboard.detail.addReaction')">
        <svg class="reaction-add-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="8" cy="8" r="6.5" />
          <circle cx="5.75" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="10.25" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
          <path d="M5.2 9.5c0.6 1.5 2.5 2.3 4.2 1.7 0.9 -0.3 1.5 -1.1 1.6 -2" stroke-linecap="round" />
        </svg>
      </button>
      <div class="reaction-picker">
        <button
          v-for="reaction in remainingReactions"
          :key="reaction.content"
          type="button"
          class="reaction-picker-item"
          :disabled="loading"
          @click="toggleReaction(reaction.content, false)"
        >
          {{ reaction.emoji }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  border: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  font-size: 0.85em;
}

.reaction-chip:hover {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

.reaction-chip.active {
  border-color: var(--vscode-textLink-foreground);
  background-color: var(--vscode-textLink-activeForeground);
  color: var(--vscode-button-foreground);
}

.reaction-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.reaction-emoji {
  line-height: 1;
}

.reaction-count {
  font-size: 0.85em;
}

.reaction-add {
  position: relative;
  display: inline-flex;
}

.reaction-add-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--vscode-panel-border);
  background-color: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.reaction-add-button:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.reaction-add-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.reaction-add-icon {
  width: 14px;
  height: 14px;
}

.reaction-picker {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  margin-top: 4px;
  padding: 6px;
  background-color: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  gap: 4px;
}

.reaction-add:hover .reaction-picker,
.reaction-add:focus-within .reaction-picker {
  display: flex;
}

.reaction-picker-item {
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1.1em;
  line-height: 1;
}

.reaction-picker-item:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}
</style>
