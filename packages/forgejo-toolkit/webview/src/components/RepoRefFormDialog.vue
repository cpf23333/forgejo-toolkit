<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { VscodeButton, VscodeTextfield } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import ModalDialog from './ModalDialog.vue';
import EasyMdeEditor from './EasyMdeEditor.vue';
import { useAppState } from '../composables/useAppState';
import type { ForgejoRelease, ForgejoReleaseAttachment } from '../types/api';

export type RepoRefFormMode = 'branch' | 'tag' | 'release';

interface Props {
  mode: RepoRefFormMode;
  open: boolean;
  instanceId: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  loading?: boolean;
  error?: string;
  release?: ForgejoRelease;
  branches?: string[];
  tags?: string[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  submit: [data: Record<string, unknown>];
}>();

const { t } = useI18n();

const name = ref('');
const oldRef = ref(props.defaultBranch ?? '');
const tagTarget = ref(props.defaultBranch ?? '');
const tagMessage = ref('');
const releaseName = ref('');
const releaseTarget = ref('');
const releaseBody = ref('');
const releasePrerelease = ref(false);
const releaseDraft = ref(false);
const hideArchiveLinks = ref(false);
const attachments = ref<ForgejoReleaseAttachment[]>([]);
const attachmentError = ref<string>('');
const fileInputRef = ref<HTMLInputElement | null>(null);

const state = useAppState();

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
    }
  },
);

function reset() {
  attachmentError.value = '';
  if (props.mode === 'release' && props.release) {
    name.value = props.release.tag_name ?? '';
    releaseName.value = props.release.name ?? '';
    releaseTarget.value = targetOptionValue(props.defaultBranch ?? '');
    releaseBody.value = props.release.body ?? '';
    releasePrerelease.value = props.release.prerelease ?? false;
    releaseDraft.value = props.release.draft ?? false;
    hideArchiveLinks.value = false;
    attachments.value = props.release.assets ?? [];
    return;
  }
  name.value = '';
  oldRef.value = props.defaultBranch ?? '';
  tagTarget.value = props.defaultBranch ?? '';
  tagMessage.value = '';
  releaseName.value = '';
  releaseTarget.value = targetOptionValue(props.defaultBranch ?? '');
  releaseBody.value = '';
  releasePrerelease.value = false;
  releaseDraft.value = false;
  hideArchiveLinks.value = false;
  attachments.value = [];
}

function targetOptionValue(value: string): string {
  if (!value) {
    return '';
  }
  const allTargets = [...(props.branches ?? []), ...(props.tags ?? [])];
  return allTargets.includes(value) ? value : '';
}

function handleSubmit() {
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    return;
  }

  if (props.mode === 'branch') {
    emit('submit', {
      newBranchName: trimmedName,
      oldRefName: oldRef.value.trim() || undefined,
    });
    return;
  }

  if (props.mode === 'tag') {
    emit('submit', {
      tagName: trimmedName,
      target: tagTarget.value.trim() || undefined,
      message: tagMessage.value.trim() || undefined,
    });
    return;
  }

  emit('submit', {
    tagName: trimmedName,
    name: releaseName.value.trim() || undefined,
    targetCommitish: releaseTarget.value.trim() || undefined,
    body: releaseBody.value.trim() || undefined,
    prerelease: releasePrerelease.value,
    draft: releaseDraft.value,
    hideArchiveLinks: hideArchiveLinks.value,
  });
}

function submitWithDraft(draft: boolean) {
  releaseDraft.value = draft;
  handleSubmit();
}

async function handleAttachmentSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || props.mode !== 'release' || !props.release?.id) {
    return;
  }
  attachmentError.value = '';
  try {
    const buffer = await file.arrayBuffer();
    const attachment = await state.uploadReleaseAttachment(
      props.instanceId,
      props.owner,
      props.repo,
      props.release.id,
      file.name,
      new Uint8Array(buffer),
    );
    attachments.value.push(attachment);
  } catch (err) {
    attachmentError.value = err instanceof Error ? err.message : String(err);
  } finally {
    input.value = '';
  }
}

async function removeAttachment(attachment: ForgejoReleaseAttachment) {
  if (!props.release?.id || attachment.id === undefined) {
    return;
  }
  attachmentError.value = '';
  try {
    await state.deleteReleaseAttachment(props.instanceId, props.owner, props.repo, props.release.id, attachment.id);
    attachments.value = attachments.value.filter((a) => a.id !== attachment.id);
  } catch (err) {
    attachmentError.value = err instanceof Error ? err.message : String(err);
  }
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function title(): string {
  if (props.mode === 'release' && props.release) {
    return t('dashboard.repoRefs.editRelease');
  }
  switch (props.mode) {
    case 'branch':
      return t('dashboard.repoRefs.createBranch');
    case 'tag':
      return t('dashboard.repoRefs.createTag');
    case 'release':
      return t('dashboard.repoRefs.createRelease');
  }
}
</script>

<template>
  <ModalDialog :open="open" :title="title()" :loading="loading" @close="emit('close')">
    <form class="ref-form" @submit.prevent="handleSubmit">
      <div v-if="mode !== 'release'" class="form-field">
        <label>{{ t('dashboard.repoRefs.nameLabel') }}</label>
        <VscodeTextfield v-model="name" :placeholder="t('dashboard.repoRefs.nameLabel')" />
      </div>

      <template v-if="mode === 'branch'">
        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.createBranchFromPrompt') }}</label>
          <VscodeTextfield v-model="oldRef" :placeholder="defaultBranch ?? ''" />
        </div>
      </template>

      <template v-if="mode === 'tag'">
        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.createTagTargetPrompt') }}</label>
          <VscodeTextfield v-model="tagTarget" :placeholder="defaultBranch ?? ''" />
        </div>
        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.createTagMessagePrompt') }}</label>
          <VscodeTextfield v-model="tagMessage" />
        </div>
      </template>

      <template v-if="mode === 'release'">
        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.releaseTagNameLabel') }}</label>
          <div class="tag-target-row">
            <VscodeTextfield v-model="name" :placeholder="t('dashboard.repoRefs.nameLabel')" class="tag-name-input" />
            <span class="at-separator">@</span>
            <input
              v-model="releaseTarget"
              list="release-targets"
              class="ref-input target-input"
              :placeholder="t('dashboard.repoRefs.selectTarget')"
            />
            <datalist id="release-targets">
              <option v-for="branch in branches" :key="`branch-${branch}`" :value="branch" />
              <option v-for="tag in tags" :key="`tag-${tag}`" :value="tag" />
            </datalist>
          </div>
        </div>

        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.createReleaseNamePrompt') }}</label>
          <VscodeTextfield v-model="releaseName" />
        </div>

        <div class="form-field">
          <label>{{ t('dashboard.repoRefs.releaseBodyLabel') }}</label>
          <EasyMdeEditor v-model="releaseBody" :placeholder="t('dashboard.repoRefs.releaseBodyLabel')" />
        </div>

        <div v-if="release" class="form-field attachment-field">
          <label>{{ t('dashboard.repoRefs.attachmentsLabel') }}</label>
          <input ref="fileInputRef" type="file" hidden @change="handleAttachmentSelected" />
          <VscodeButton type="button" secondary @click="fileInputRef?.click()">
            {{ t('dashboard.repoRefs.addAttachment') }}
          </VscodeButton>
          <div v-if="attachmentError" class="attachment-error">{{ attachmentError }}</div>
          <ul v-if="attachments.length" class="attachment-list">
            <li v-for="att in attachments" :key="att.id" class="attachment-item">
              <a :href="att.browser_download_url" target="_blank" class="attachment-name">{{ att.name }}</a>
              <span class="attachment-size">{{ formatBytes(att.size) }}</span>
              <button type="button" class="attachment-delete" @click="removeAttachment(att)">×</button>
            </li>
          </ul>
        </div>

        <div class="form-field checkbox-field">
          <label class="checkbox-label">
            <input v-model="releasePrerelease" type="checkbox" />
            {{ t('dashboard.repoRefs.prerelease') }}
          </label>
        </div>

        <div class="form-field checkbox-field">
          <label class="checkbox-label">
            <input v-model="hideArchiveLinks" type="checkbox" />
            {{ t('dashboard.repoRefs.hideArchiveLinks') }}
          </label>
        </div>

        <div v-if="release" class="form-field checkbox-field">
          <label class="checkbox-label">
            <input v-model="releaseDraft" type="checkbox" />
            {{ t('dashboard.repoRefs.draft') }}
          </label>
        </div>
      </template>

      <div v-if="error" class="form-error">{{ t('dashboard.form.error', { message: error }) }}</div>

      <div class="form-actions">
        <template v-if="mode === 'release' && !release">
          <VscodeButton type="button" secondary :disabled="loading || !name.trim()" @click="submitWithDraft(true)">
            {{ loading ? t('dashboard.form.saving') : t('dashboard.repoRefs.saveDraft') }}
          </VscodeButton>
          <VscodeButton type="button" :disabled="loading || !name.trim()" @click="submitWithDraft(false)">
            {{ loading ? t('dashboard.form.saving') : t('dashboard.repoRefs.publishRelease') }}
          </VscodeButton>
        </template>
        <template v-else>
          <VscodeButton type="submit" :disabled="loading || !name.trim()">
            {{
              loading
                ? t('dashboard.form.saving')
                : props.release
                  ? t('dashboard.form.save')
                  : t('dashboard.form.create')
            }}
          </VscodeButton>
        </template>
        <VscodeButton type="button" secondary @click="emit('close')">
          {{ t('dashboard.form.cancel') }}
        </VscodeButton>
      </div>
    </form>
  </ModalDialog>
</template>

<style scoped>
.ref-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
.form-field > vscode-textarea,
.ref-input {
  width: 100%;
  display: block;
}

.ref-input {
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  padding: 4px 8px;
  font-size: 0.95em;
  min-height: 28px;
  box-sizing: border-box;
}

.tag-target-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tag-target-row .tag-name-input {
  flex: 1;
}

.tag-target-row .target-input {
  flex: 1;
}

.tag-target-row .at-separator {
  color: var(--vscode-descriptionForeground);
  font-size: 0.95em;
  flex-shrink: 0;
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.checkbox-label input[type='checkbox'] {
  margin: 0;
}

.form-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
}

.attachment-field {
  gap: 8px;
}

.attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  padding: 4px 6px;
  border-radius: 4px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.attachment-name {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-name:hover {
  text-decoration: underline;
}

.attachment-size {
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
}

.attachment-delete {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 1.1em;
  line-height: 1;
  padding: 0 4px;
}

.attachment-delete:hover {
  color: var(--vscode-testing-iconFailed);
}

.attachment-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.85em;
}

.form-actions {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}
</style>
