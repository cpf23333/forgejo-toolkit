<script setup lang="ts">
import type { ForgejoInstance } from '../types/instance';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';

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
          <a href="#" @click.prevent="emit('openExternal', instance.url)">
            {{ instance.url }}
          </a>
        </div>
      </li>
    </ul>

    <div v-else class="empty">
      <p>No Forgejo instances configured.</p>
      <p>
        Use the command palette (<kbd>Ctrl+Shift+P</kbd>) and run
        <code>Forgejo Toolkit: Add Instance</code>.
      </p>
      <VscodeButton variant="primary" @click="emit('openExternal', 'https://forgejo.org/')">
        Learn more about Forgejo
      </VscodeButton>
    </div>
  </div>
</template>
