<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMdeEditor from './EasyMdeEditor.vue';
import DateTimePicker from './DateTimePicker.vue';
import type { ForgejoLabel, ForgejoMilestone } from '../types/api';

const { t } = useI18n();

interface Props {
  mode?: 'create' | 'edit';
  initialTitle?: string;
  initialBody?: string;
  initialBase?: string;
  initialHead?: string;
  initialLabelIds?: number[];
  initialAssignees?: string[];
  initialMilestoneId?: number;
  initialDueDate?: string;
  branches?: string[];
  labels?: ForgejoLabel[];
  assignees?: string[];
  milestones?: ForgejoMilestone[];
  submitLabel: string;
  loading?: boolean;
  error?: string;
  uploadImage?: (file: File, onSuccess: (url: string) => void, onError: (error: string) => void) => void;
  instanceId?: string;
  owner?: string;
  repo?: string;
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'create',
  initialTitle: '',
  initialBody: '',
  initialBase: '',
  initialHead: '',
  initialLabelIds: () => [],
  initialAssignees: () => [],
  labels: () => [],
  assignees: () => [],
  milestones: () => [],
  branches: () => [],
  loading: false,
  error: '',
});

const emit = defineEmits<{
  submit: [
    data: {
      title: string;
      body: string;
      base?: string;
      head?: string;
      assignees: string[];
      labels: number[];
      milestone?: number;
      dueDate?: string;
    },
  ];
  cancel: [];
}>();

const title = ref(props.initialTitle);
const body = ref(props.initialBody);
const base = ref<string | undefined>(props.initialBase || undefined);
const head = ref<string | undefined>(props.initialHead || undefined);
const selectedLabelIds = ref<number[]>([...props.initialLabelIds]);
const selectedAssignees = ref<string[]>([...props.initialAssignees]);
const selectedMilestoneId = ref<number | undefined>(props.initialMilestoneId);
const dueDate = ref<string | null>(props.initialDueDate ?? null);

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
    base.value = value || undefined;
  },
);

watch(
  () => props.initialHead,
  (value) => {
    head.value = value || undefined;
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
    dueDate.value = value ?? null;
  },
);

function toggleLabel(id: number) {
  const idx = selectedLabelIds.value.indexOf(id);
  if (idx >= 0) {
    selectedLabelIds.value.splice(idx, 1);
  } else {
    selectedLabelIds.value.push(id);
  }
}

function toggleAssignee(login: string) {
  const idx = selectedAssignees.value.indexOf(login);
  if (idx >= 0) {
    selectedAssignees.value.splice(idx, 1);
  } else {
    selectedAssignees.value.push(login);
  }
}

function handleSubmit() {
  emit('submit', {
    title: title.value,
    body: body.value,
    base: base.value,
    head: props.mode === 'create' ? head.value : undefined,
    assignees: selectedAssignees.value,
    labels: selectedLabelIds.value,
    milestone: selectedMilestoneId.value,
    dueDate: dueDate.value || undefined,
  });
}
</script>

<template>
  <form class="pr-form" @submit.prevent="handleSubmit">
    <div class="form-field">
      <label>{{ t('dashboard.form.title') }}</label>
      <vscode-textfield
        :value="title"
        @input="title = ($event.target as HTMLInputElement).value"
        :placeholder="t('dashboard.form.titlePlaceholder')"
      />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label>{{ t('dashboard.form.base') }}</label>
        <vscode-single-select
          filter="fuzzy"
          :value="base"
          class="branch-select"
          @change="base = ($event.target as HTMLInputElement).value"
        >
          <vscode-option v-for="branch in branches" :key="branch" :value="branch" :selected="branch === base">
            {{ branch }}
          </vscode-option>
        </vscode-single-select>
      </div>
      <div v-if="mode === 'create'" class="form-field">
        <label>{{ t('dashboard.form.head') }}</label>
        <vscode-single-select
          filter="fuzzy"
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
      <label>{{ t('dashboard.form.assignees') }}</label>
      <div class="option-list">
        <button
          v-for="login in assignees"
          :key="login"
          type="button"
          class="option-tag"
          :class="{ selected: selectedAssignees.includes(login) }"
          @click="toggleAssignee(login)"
        >
          {{ login }}
        </button>
      </div>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.labels') }}</label>
      <div class="option-list">
        <button
          v-for="label in labels"
          :key="label.name ?? ''"
          type="button"
          class="option-tag label-option"
          :class="{ selected: selectedLabelIds.includes(label.id ?? -1) }"
          :style="label.color ? `background-color: #${label.color};` : ''"
          @click="toggleLabel(label.id ?? -1)"
        >
          {{ label.name }}
        </button>
      </div>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.milestone') }}</label>
      <vscode-single-select
        :value="selectedMilestoneId === undefined ? '' : String(selectedMilestoneId)"
        @change="
          selectedMilestoneId =
            ($event.target as HTMLSelectElement).value === ''
              ? undefined
              : Number(($event.target as HTMLSelectElement).value)
        "
      >
        <vscode-option value="">{{ t('dashboard.form.noMilestone') }}</vscode-option>
        <vscode-option
          v-for="milestone in milestones"
          :key="milestone.id"
          :value="String(milestone.id)"
          :selected="milestone.id === selectedMilestoneId"
        >
          {{ milestone.title }}
        </vscode-option>
      </vscode-single-select>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.dueDate') }}</label>
      <DateTimePicker v-model="dueDate" type="date" />
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.body') }}</label>
      <EasyMdeEditor
        v-model="body"
        :placeholder="t('dashboard.form.bodyPlaceholder')"
        :upload-image="uploadImage"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
      />
    </div>
    <div v-if="error" class="form-error">{{ t('dashboard.form.error', { message: error }) }}</div>
    <slot name="extra" />
    <div class="form-actions">
      <vscode-button type="submit" :disabled="loading || !title.trim() || !base || (mode === 'create' && !head)">
        {{ loading ? t('dashboard.form.saving') : submitLabel }}
      </vscode-button>
      <vscode-button type="button" secondary @click="emit('cancel')">
        {{ t('dashboard.form.cancel') }}
      </vscode-button>
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
  grid-template-columns: 1fr;
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

.option-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.option-tag {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  background-color: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 0.85em;
  cursor: pointer;
}

.option-tag.selected {
  border-color: var(--vscode-button-background);
  outline: 1px solid var(--vscode-button-background);
}

.label-option {
  color: #fff;
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
