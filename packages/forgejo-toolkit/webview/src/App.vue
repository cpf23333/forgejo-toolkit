<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { ForgejoInstance } from '../../../src/config';
import { vscode } from './composables/vscode.ts';
import InstanceList from './components/InstanceList.vue';

const instances = ref<ForgejoInstance[]>([]);

function handleMessage(event: MessageEvent) {
  const message = event.data;
  if (message.command === 'instances') {
    instances.value = message.data ?? [];
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
  vscode.postMessage({ command: 'getInstances' });
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});

function openExternal(url: string) {
  vscode.postMessage({ command: 'openExternal', url });
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <h1>Forgejo Toolkit</h1>
    </header>
    <main>
      <InstanceList :instances="instances" @open-external="openExternal" />
    </main>
  </div>
</template>
