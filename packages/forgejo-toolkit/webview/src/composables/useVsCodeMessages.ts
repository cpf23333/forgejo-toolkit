import { ref, onMounted, onUnmounted } from 'vue';
import { vscode } from './vscode.ts';

export function useVsCodeMessages() {
  const messages = ref<unknown[]>([]);

  function postMessage(message: unknown) {
    vscode.postMessage(message);
  }

  function handler(event: MessageEvent) {
    messages.value.push(event.data);
  }

  onMounted(() => window.addEventListener('message', handler));
  onUnmounted(() => window.removeEventListener('message', handler));

  return {
    messages,
    postMessage,
  };
}
