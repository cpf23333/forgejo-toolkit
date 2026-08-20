<script setup lang="ts">
import type { ForgejoInstance } from '../types/instance';

defineProps<{
  instances: ForgejoInstance[];
}>();

const emit = defineEmits<{
  (e: 'openExternal', url: string): void;
}>();
</script>

<template>
  <div class="instances">
    <h2 v-if="instances.length > 0">Connected Instances ({{ instances.length }})</h2>

    <ul v-if="instances.length > 0">
      <li v-for="instance in instances" :key="instance.id" class="instance-card">
        <div class="name">{{ instance.name }}</div>
        <div class="meta">
          <button type="button" class="link-button" @click="emit('openExternal', instance.url)">
            {{ instance.url }}
          </button>
        </div>
      </li>
    </ul>

    <div v-else class="empty">
      <p>No Forgejo instances configured.</p>
      <p>
        Use the command palette (<kbd>Ctrl+Shift+P</kbd>) and run
        <code>Forgejo Toolkit: Add Instance</code>.
      </p>
      <vscode-button @click="emit('openExternal', 'https://forgejo.org/')"> Learn more about Forgejo </vscode-button>
    </div>
  </div>
</template>
