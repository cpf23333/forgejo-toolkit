<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMdeEditor from './EasyMdeEditor.vue';
import DateTimePicker from './DateTimePicker.vue';
import { createPendingUploads } from '../utils/pendingUploads';
import { labelStyle } from '../utils/labelColor';
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
  /**
   * The failure the repository's label / assignee / milestone list load ended
   * with (`repoLabelsKey` and friends). The host sends no toast, so without these
   * the picker rendered empty — the same thing the user sees when the repository
   * has none — and the form silently offered no choice at all.
   */
  labelsError?: string;
  assigneesError?: string;
  milestonesError?: string;
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
  labelsError: '',
  assigneesError: '',
  milestonesError: '',
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
  dirty: [dirty: boolean];
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

// Re-seed only when the contents change: the parent builds these arrays inline,
// so a re-render (including the one this form's `dirty` emit causes) produces a
// new identity and an identity-based watcher would undo the user's first toggle.
// See IssueForm for the same guard.
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

// Uploads started from the body editor are tracked so the submit handler can
// wait for them: the editor inserts the image markdown only when the upload
// returns, so saving first would submit a body without the image.
const pendingImageUploads = createPendingUploads();
// Reactive mirror of the tracker: an image still uploading disables the submit
// button and marks the form dirty, because the body does not contain its
// markdown yet.
const pendingUploadCount = ref(0);
/** Whether an image is still uploading; drives the submit button's disabled state. */
const uploadingImage = computed(() => pendingUploadCount.value > 0);

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

/**
 * The input this form would throw away when its dialog closes. An upload still
 * in flight counts as input of its own: the editor inserts its markdown into the
 * body only when the request returns, so closing meanwhile loses an image the
 * user already picked. The dialog's own `loading` no longer covers uploads (they
 * used to block closing for the whole request), so this is what makes closing ask
 * before dropping one. The PR edit dialog mirrors the upload count in its own
 * view as well, but with this covered it is no longer the only protection.
 * (`IssueForm` and `CommentTimeline`'s edit dialog carry the same guard.)
 */
const isDirty = computed(
  () =>
    uploadingImage.value ||
    title.value !== props.initialTitle ||
    body.value !== props.initialBody ||
    (base.value ?? '') !== props.initialBase ||
    (head.value ?? '') !== props.initialHead ||
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

async function handleSubmit() {
  // Wait for in-flight uploads: the body only gains the image markdown when
  // their request returns.
  if (pendingImageUploads.isPending()) {
    await pendingImageUploads.waitForIdle();
  }
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
        data-autofocus
        @input="title = ($event.target as HTMLInputElement).value"
        :placeholder="t('dashboard.form.titlePlaceholder')"
        :label="t('dashboard.form.title')"
      />
    </div>
    <div class="form-row">
      <div class="form-field">
        <label>{{ t('dashboard.form.base') }}</label>
        <vscode-single-select
          filter="fuzzy"
          :value="base"
          class="branch-select"
          :label="t('dashboard.form.base')"
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
          :label="t('dashboard.form.head')"
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
      <div v-if="assigneesError" class="form-field-error" role="status">
        {{ t('dashboard.form.assigneesLoadFailed', { message: assigneesError }) }}
      </div>
      <div class="option-list">
        <button
          v-for="login in assignees"
          :key="login"
          type="button"
          class="option-tag"
          :class="{ selected: selectedAssignees.includes(login) }"
          :aria-pressed="selectedAssignees.includes(login)"
          @click="toggleAssignee(login)"
        >
          {{ login }}
        </button>
      </div>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.labels') }}</label>
      <div v-if="labelsError" class="form-field-error" role="status">
        {{ t('dashboard.form.labelsLoadFailed', { message: labelsError }) }}
      </div>
      <div class="option-list">
        <button
          v-for="label in labels"
          :key="label.name ?? ''"
          type="button"
          class="option-tag label-option"
          :class="{ selected: selectedLabelIds.includes(label.id ?? -1) }"
          :style="labelStyle(label.color)"
          :aria-pressed="selectedLabelIds.includes(label.id ?? -1)"
          @click="toggleLabel(label.id ?? -1)"
        >
          {{ label.name }}
        </button>
      </div>
    </div>
    <div class="form-field">
      <label>{{ t('dashboard.form.milestone') }}</label>
      <div v-if="milestonesError" class="form-field-error" role="status">
        {{ t('dashboard.form.milestonesLoadFailed', { message: milestonesError }) }}
      </div>
      <vscode-single-select
        :value="selectedMilestoneId === undefined ? '' : String(selectedMilestoneId)"
        :label="t('dashboard.form.milestone')"
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
      <vscode-button
        type="submit"
        :disabled="loading || uploadingImage || !title.trim() || !base || (mode === 'create' && !head)"
      >
        {{ loading ? t('dashboard.form.saving') : submitLabel }}
      </vscode-button>
      <!-- Disabled while saving for the same reason as Submit: the save waits
           for in-flight image uploads, so a Cancel in that window would close a
           dialog whose edit is already on its way to the server. -->
      <vscode-button type="button" :disabled="loading" @click="emit('cancel')" secondary>
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

.form-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

/* A failed list load, shown at the picker it emptied (the form's own `error`
   line is for the save). */
.form-field-error {
  color: var(--vscode-errorForeground);
  font-size: 0.85em;
}

.form-actions {
  display: flex;
  gap: 12px;
}
</style>
