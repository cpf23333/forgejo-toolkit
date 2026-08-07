<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import { VscodeTextfield } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import EasyMdeEditor from './EasyMdeEditor.vue';
import { VscodeDateField, VscodeSingleSelect } from '../vscode-controls';
import type { ForgejoLabel, ForgejoMilestone } from '../types/api';

const { t } = useI18n();

interface Props {
  mode?: 'create' | 'edit';
  initialTitle?: string;
  initialBody?: string;
  initialRef?: string;
  initialLabelIds?: number[];
  initialAssignees?: string[];
  initialMilestoneId?: number;
  initialDueDate?: string;
  labels?: ForgejoLabel[];
  assignees?: string[];
  milestones?: ForgejoMilestone[];
  branches?: string[];
  tags?: string[];
  submitLabel: string;
  loading?: boolean;
  error?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'create',
  initialTitle: '',
  initialBody: '',
  initialRef: '',
  initialLabelIds: () => [],
  initialAssignees: () => [],
  labels: () => [],
  assignees: () => [],
  milestones: () => [],
  branches: () => [],
  tags: () => [],
  loading: false,
  error: '',
});

const emit = defineEmits<{
  submit: [
    data: {
      title: string;
      body: string;
      ref?: string;
      labels: number[];
      assignees: string[];
      milestone?: number;
      dueDate?: string;
    },
  ];
  cancel: [];
}>();

const title = ref(props.initialTitle);
const body = ref(props.initialBody);
const selectedRef = ref<string | undefined>(props.initialRef || undefined);
const selectedLabelIds = ref<number[]>([...props.initialLabelIds]);
const selectedAssignees = ref<string[]>([...props.initialAssignees]);
const selectedMilestoneId = ref<number | undefined>(props.initialMilestoneId);
const dueDate = ref<string | undefined>(props.initialDueDate);

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
  () => props.initialRef,
  (value) => {
    selectedRef.value = value || undefined;
  },
);

watch(
  () => props.initialLabelIds,
  (value) => {
    selectedLabelIds.value = [...value];
  },
);

watch(
  () => props.initialAssignees,
  (value) => {
    selectedAssignees.value = [...value];
  },
);

watch(
  () => props.initialMilestoneId,
  (value) => {
    selectedMilestoneId.value = value;
  },
);

watch(
  () => props.initialDueDate,
  (value) => {
    dueDate.value = value;
  },
);

function toggleLabel(id: number) {
  const index = selectedLabelIds.value.indexOf(id);
  if (index >= 0) {
    selectedLabelIds.value.splice(index, 1);
  } else {
    selectedLabelIds.value.push(id);
  }
}

function toggleAssignee(login: string) {
  const index = selectedAssignees.value.indexOf(login);
  if (index >= 0) {
    selectedAssignees.value.splice(index, 1);
  } else {
    selectedAssignees.value.push(login);
  }
}

function labelStyle(color?: string): string {
  if (!color) {
    return '';
  }
  return `background-color: #${color}; color: ${isLightColor(color) ? '#000' : '#fff'};`;
}

function isLightColor(hex: string): boolean {
  const normalized = hex.replace('#', '');
  const r = parseInt(normalized.substring(0, 2), 16) / 255;
  const g = parseInt(normalized.substring(2, 4), 16) / 255;
  const b = parseInt(normalized.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  return luminance > 0.5;
}

function channelLuminance(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function handleMilestoneChange(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);
  selectedMilestoneId.value = Number.isNaN(value) ? undefined : value;
}

function handleSubmit() {
  emit('submit', {
    title: title.value,
    body: body.value,
    ref: selectedRef.value || undefined,
    labels: selectedLabelIds.value,
    assignees: selectedAssignees.value,
    milestone: selectedMilestoneId.value,
    dueDate: dueDate.value || undefined,
  });
}
</script>

<template>
  <form class="issue-form" @submit.prevent="handleSubmit">
    <div class="form-field">
      <label>{{ t('dashboard.form.title') }}</label>
      <VscodeTextfield v-model="title" :placeholder="t('dashboard.form.titlePlaceholder')" />
    </div>
    <div v-if="props.branches.length || props.tags.length" class="form-field">
      <label>{{ t('dashboard.form.ref') }}</label>
      <VscodeSingleSelect v-model="selectedRef">
        <vscode-option value="">{{ t('dashboard.form.noRef') }}</vscode-option>
        <vscode-option
          v-for="branch in props.branches"
          :key="`branch-${branch}`"
          :value="branch"
          :selected="branch === selectedRef"
        >
          {{ t('dashboard.form.branchPrefix', { branch }) }}
        </vscode-option>
        <vscode-option v-for="tag in props.tags" :key="`tag-${tag}`" :value="tag" :selected="tag === selectedRef">
          {{ t('dashboard.form.tagPrefix', { tag }) }}
        </vscode-option>
      </VscodeSingleSelect>
    </div>
    <div v-if="labels.length" class="form-field">
      <label>{{ t('dashboard.form.labels') }}</label>
      <div class="option-list">
        <button
          v-for="label in labels"
          :key="label.id ?? label.name"
          type="button"
          class="option-chip label-chip"
          :class="{ selected: selectedLabelIds.includes(label.id ?? -1) }"
          :style="labelStyle(label.color)"
          @click="toggleLabel(label.id ?? -1)"
        >
          {{ label.name }}
        </button>
      </div>
    </div>
    <div v-if="assignees.length" class="form-field">
      <label>{{ t('dashboard.form.assignees') }}</label>
      <div class="option-list">
        <button
          v-for="login in assignees"
          :key="login"
          type="button"
          class="option-chip assignee-chip"
          :class="{ selected: selectedAssignees.includes(login) }"
          @click="toggleAssignee(login)"
        >
          {{ login }}
        </button>
      </div>
    </div>
    <div v-if="milestones.length" class="form-field">
      <label>{{ t('dashboard.form.milestone') }}</label>
      <VscodeSingleSelect v-model="selectedMilestoneId">
        <vscode-option value="">{{ t('dashboard.form.noMilestone') }}</vscode-option>
        <vscode-option
          v-for="milestone in milestones"
          :key="milestone.id ?? milestone.title"
          :value="milestone.id"
          :selected="milestone.id === selectedMilestoneId"
        >
          {{ milestone.title }}
        </vscode-option>
      </VscodeSingleSelect>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.dueDate') }}</label>
      <VscodeDateField v-model="dueDate" />
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.body') }}</label>
      <EasyMdeEditor v-model="body" :placeholder="t('dashboard.form.bodyPlaceholder')" :upload-image="uploadImage" />
    </div>
    <div v-if="error" class="form-error">{{ t('dashboard.form.error', { message: error }) }}</div>
    <slot name="extra" />
    <div class="form-actions">
      <VscodeButton type="button" variant="secondary" @click="emit('cancel')">
        {{ t('dashboard.form.cancel') }}
      </VscodeButton>
      <VscodeButton type="submit" variant="primary" :disabled="loading || !title.trim()">
        {{ loading ? t('dashboard.form.saving') : submitLabel }}
      </VscodeButton>
    </div>
  </form>
</template>

<style scoped>
.issue-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.option-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.option-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid var(--vscode-panel-border);
  background-color: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 0.85em;
  cursor: pointer;
}

.option-chip:hover {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

.option-chip.selected {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.label-chip:not([style*='background-color']) {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.form-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--vscode-panel-border);
}
</style>
