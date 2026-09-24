<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMdeEditor from './EasyMdeEditor.vue';

import DateTimePicker from './DateTimePicker.vue';
import { createPendingUploads } from '../utils/pendingUploads';
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
  instanceId?: string;
  owner?: string;
  repo?: string;
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
  dirty: [dirty: boolean];
}>();

const title = ref(props.initialTitle);
const body = ref(props.initialBody);
const selectedRef = ref<string | undefined>(props.initialRef || undefined);
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
  () => props.initialRef,
  (value) => {
    selectedRef.value = value || undefined;
  },
);

// Re-seed the selection only when the *contents* change. Parents pass
// `initial-label-ids` / `initial-assignees` as inline `.map().filter()` arrays,
// so every parent re-render hands the prop a new array identity — and the form's
// own `dirty` emit re-renders the parent (it drives the dialog's dirty state).
// Watching the array itself therefore wiped the user's first toggle; the
// serialized value is stable for equal contents.
watch(
  () => JSON.stringify(props.initialLabelIds),
  () => {
    selectedLabelIds.value = [...props.initialLabelIds];
  },
);

watch(
  () => JSON.stringify(props.initialAssignees),
  () => {
    selectedAssignees.value = [...props.initialAssignees];
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

function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
}

const isDirty = computed(
  () =>
    title.value !== props.initialTitle ||
    body.value !== props.initialBody ||
    (selectedRef.value ?? '') !== props.initialRef ||
    selectedMilestoneId.value !== props.initialMilestoneId ||
    (dueDate.value ?? '') !== (props.initialDueDate ?? '') ||
    !sameItems(selectedLabelIds.value, props.initialLabelIds) ||
    !sameItems(selectedAssignees.value, props.initialAssignees),
);

// Immediate so a freshly (re)mounted form also publishes its initial clean state.
watch(
  isDirty,
  (dirty) => {
    emit('dirty', dirty);
  },
  { immediate: true },
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

function handleRefChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  selectedRef.value = value || undefined;
}

function handleMilestoneChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  selectedMilestoneId.value = value === '' ? undefined : Number(value);
}

// Uploads started from the body editor are tracked so the submit handler can
// wait for them: the editor inserts the image markdown only when the upload
// returns, so saving first would submit a body without the image.
const pendingImageUploads = createPendingUploads();
// Reactive mirror of the tracker: the submit button is disabled while an image
// is still uploading, because the body does not contain its markdown yet.
const pendingUploadCount = ref(0);

function trackImageUpload(file: File, onSuccess: (url: string) => void, onError: (error: string) => void): void {
  const upload = pendingImageUploads.begin();
  pendingUploadCount.value += 1;
  const settle = () => {
    pendingImageUploads.end(upload);
    pendingUploadCount.value = Math.max(0, pendingUploadCount.value - 1);
  };
  props.uploadImage?.(
    file,
    (url) => {
      try {
        onSuccess(url);
      } finally {
        // The editor inserts the markdown inside `onSuccess`, so the tracked
        // upload must stay pending until that has happened.
        settle();
      }
    },
    (error) => {
      try {
        onError(error);
      } finally {
        // A failed upload releases the wait instead of hanging the save.
        settle();
      }
    },
  );
}

const trackedUploadImage = computed(() => (props.uploadImage ? trackImageUpload : undefined));
/** Number of images currently uploading; drives the submit button's disabled state. */
const uploadingImage = computed(() => pendingUploadCount.value > 0);

async function handleSubmit() {
  // Wait for in-flight uploads before serialising the body: the markdown they
  // insert lands in `body` only when their request returns, and the button is
  // disabled meanwhile, but a submit that still gets through (Enter in a field,
  // a programmatic click) must not save a body that misses the image.
  if (pendingImageUploads.isPending()) {
    await pendingImageUploads.waitForIdle();
  }
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
      <vscode-textfield
        :value="title"
        data-autofocus
        @input="title = ($event.target as HTMLInputElement).value"
        :placeholder="t('dashboard.form.titlePlaceholder')"
        :label="t('dashboard.form.title')"
      />
    </div>
    <div v-if="props.branches.length || props.tags.length" class="form-field">
      <label>{{ t('dashboard.form.ref') }}</label>
      <vscode-single-select :value="selectedRef ?? ''" :label="t('dashboard.form.ref')" @change="handleRefChange">
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
      </vscode-single-select>
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
          :aria-pressed="selectedLabelIds.includes(label.id ?? -1)"
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
          :aria-pressed="selectedAssignees.includes(login)"
          @click="toggleAssignee(login)"
        >
          {{ login }}
        </button>
      </div>
    </div>
    <div v-if="milestones.length" class="form-field">
      <label>{{ t('dashboard.form.milestone') }}</label>
      <vscode-single-select
        :value="String(selectedMilestoneId ?? '')"
        :label="t('dashboard.form.milestone')"
        @change="handleMilestoneChange"
      >
        <vscode-option value="">{{ t('dashboard.form.noMilestone') }}</vscode-option>
        <vscode-option
          v-for="milestone in milestones"
          :key="milestone.id ?? milestone.title"
          :value="String(milestone.id)"
          :selected="milestone.id === selectedMilestoneId"
        >
          {{ milestone.title }}
        </vscode-option>
      </vscode-single-select>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.dueDate') }}</label>
      <DateTimePicker v-model="dueDate" type="date" :label="t('dashboard.form.dueDate')" />
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.body') }}</label>
      <EasyMdeEditor
        v-model="body"
        :placeholder="t('dashboard.form.bodyPlaceholder')"
        :label="t('dashboard.form.body')"
        :upload-image="trackedUploadImage"
        :instance-id="instanceId"
        :owner="owner"
        :repo="repo"
      />
    </div>
    <div v-if="error" class="form-error">{{ t('dashboard.form.error', { message: error }) }}</div>
    <slot name="extra" />
    <div class="form-actions">
      <!-- Disabled while saving for the same reason as Submit: the save waits
           for in-flight image uploads, so a Cancel in that window would close a
           dialog whose edit is already on its way to the server. -->
      <vscode-button type="button" :disabled="loading" @click="emit('cancel')" secondary>
        {{ t('dashboard.form.cancel') }}
      </vscode-button>
      <vscode-button type="submit" :disabled="loading || uploadingImage || !title.trim()">
        {{ loading ? t('dashboard.form.saving') : submitLabel }}
      </vscode-button>
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
