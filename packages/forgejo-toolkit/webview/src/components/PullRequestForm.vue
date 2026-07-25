<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import { VscodeTextfield } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import EasyMdeEditor from './EasyMdeEditor.vue';

const { t } = useI18n();

interface Props {
  initialTitle?: string;
  initialBody?: string;
  initialBase?: string;
  initialHead?: string;
  branches?: string[];
  submitLabel: string;
  loading?: boolean;
  error?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
}

const props = withDefaults(defineProps<Props>(), {
  initialTitle: '',
  initialBody: '',
  initialBase: '',
  initialHead: '',
  branches: () => [],
  loading: false,
  error: '',
});

const emit = defineEmits<{
  submit: [title: string, body: string, base: string, head: string];
  cancel: [];
}>();

const title = ref(props.initialTitle);
const body = ref(props.initialBody);
const base = ref(props.initialBase);
const head = ref(props.initialHead);

watch(
  () => props.initialTitle,
  (value) => {
    title.value = value;
  },
);

watch(
  () => props.initialBody,
  (value) => {
    body.value = value;
  },
);

watch(
  () => props.initialBase,
  (value) => {
    base.value = value;
  },
);

watch(
  () => props.initialHead,
  (value) => {
    head.value = value;
  },
);

function handleSubmit() {
  emit('submit', title.value, body.value, base.value, head.value);
}
</script>

<template>
  <form class="pr-form" @submit.prevent="handleSubmit">
    <div class="form-field">
      <label>{{ t('dashboard.form.title') }}</label>
      <VscodeTextfield v-model="title" :placeholder="t('dashboard.form.titlePlaceholder')" />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label>{{ t('dashboard.form.base') }}</label>
        <vscode-single-select
          filter
          :value="base"
          class="branch-select"
          @change="base = ($event.target as HTMLInputElement).value"
        >
          <vscode-option v-for="branch in branches" :key="branch" :value="branch" :selected="branch === base">
            {{ branch }}
          </vscode-option>
        </vscode-single-select>
      </div>
      <div class="form-field">
        <label>{{ t('dashboard.form.head') }}</label>
        <vscode-single-select
          filter
          :value="head"
          class="branch-select"
          @change="head = ($event.target as HTMLInputElement).value"
        >
          <vscode-option v-for="branch in branches" :key="branch" :value="branch" :selected="branch === head">
            {{ branch }}
          </vscode-option>
        </vscode-single-select>
      </div>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.body') }}</label>
      <EasyMdeEditor v-model="body" :placeholder="t('dashboard.form.bodyPlaceholder')" :upload-image="uploadImage" />
    </div>
    <div v-if="error" class="form-error">{{ t('dashboard.form.error', { message: error }) }}</div>
    <slot name="extra" />
    <div class="form-actions">
      <VscodeButton type="submit" :disabled="loading || !title.trim() || !base || !head">
        {{ loading ? t('dashboard.form.saving') : submitLabel }}
      </VscodeButton>
      <VscodeButton type="button" secondary @click="emit('cancel')">
        {{ t('dashboard.form.cancel') }}
      </VscodeButton>
    </div>
  </form>
</template>

<style scoped>
.pr-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-field label {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.form-field > vscode-textfield,
.form-field .easy-mde-editor,
.form-field > vscode-single-select {
  width: 100%;
  display: block;
}

.branch-select {
  min-width: 0;
}

.form-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.form-actions {
  display: flex;
  gap: 12px;
}
</style>
