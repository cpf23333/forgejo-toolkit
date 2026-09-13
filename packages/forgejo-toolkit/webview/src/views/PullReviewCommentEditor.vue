<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import type { PullReviewCommentContext } from '../types/config';
import type { PullReviewSubmitEvent } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { postMessage } from '../composables/vscode';
import { useAppState } from '../composables/useAppState';

const props = defineProps<{
  context: PullReviewCommentContext;
}>();

const { t } = useI18n();
const state = useAppState();

const body = ref('');
// Stays true from the moment a request is posted until the host answers with
// the matching completion message (success, failure, or a declined confirm);
// postMessage is fire-and-forget, so resetting earlier would allow duplicates.
const submitting = ref(false);
const pendingReviewId = ref<number | undefined>(props.context.pendingReviewId);
const reviewEvent = ref<PullReviewSubmitEvent>('COMMENT');

const mode = ref<'single' | 'review'>(props.context.mode);

const isReviewMode = computed(() => mode.value === 'review');
const hasPendingReview = computed(() => typeof pendingReviewId.value === 'number');

function handleMessage(event: MessageEvent) {
  const command = event.data?.command;
  if (
    command === 'pullReviewCommentSubmitted' ||
    command === 'pullReviewSubmitted' ||
    command === 'pullReviewDeleted'
  ) {
    submitting.value = false;
    return;
  }
  // The host asks before reusing this singleton panel for another line/PR;
  // a non-empty body is a draft the user may want to keep.
  if (command === 'queryPullReviewCommentDraft') {
    postMessage({ command: 'pullReviewCommentDraftState', dirty: body.value.trim().length > 0 });
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleMessage);
});

const title = computed(() => {
  if (isReviewMode.value && hasPendingReview.value) {
    return t('pullReviewCommentEditor.titleAddToReview');
  }
  if (isReviewMode.value) {
    return t('pullReviewCommentEditor.titleStartReview');
  }
  return t('pullReviewCommentEditor.titleSingleComment');
});

function closePanel() {
  postMessage({ command: 'closePullReviewCommentPanel' });
}

function submit(modeToUse: 'single' | 'review') {
  const text = body.value.trim();
  if (!text || submitting.value) {
    return;
  }
  submitting.value = true;
  postMessage({
    command: 'submitPullReviewComment',
    instanceId: props.context.instanceId,
    owner: props.context.owner,
    repo: props.context.repo,
    index: props.context.index,
    path: props.context.path,
    position: props.context.position,
    isBase: props.context.isBase,
    body: text,
    mode: modeToUse,
    pendingReviewId: pendingReviewId.value,
  });
}

function submitSingle() {
  submit('single');
}

function startOrAddToReview() {
  submit('review');
}

function submitReview() {
  if (submitting.value || typeof pendingReviewId.value !== 'number') {
    return;
  }
  submitting.value = true;
  postMessage({
    command: 'submitPullReview',
    instanceId: props.context.instanceId,
    owner: props.context.owner,
    repo: props.context.repo,
    index: props.context.index,
    reviewId: pendingReviewId.value,
    event: reviewEvent.value,
    body: body.value.trim(),
  });
}

function cancelReview() {
  if (submitting.value || typeof pendingReviewId.value !== 'number') {
    return;
  }
  submitting.value = true;
  postMessage({
    command: 'deletePullReview',
    instanceId: props.context.instanceId,
    owner: props.context.owner,
    repo: props.context.repo,
    index: props.context.index,
    reviewId: pendingReviewId.value,
  });
}

function uploadImage(file: File, onSuccess: (url: string) => void, onError: (error: string) => void) {
  state
    .uploadIssueAttachment(props.context.instanceId, props.context.owner, props.context.repo, props.context.index, file)
    .then((attachment) => {
      onSuccess(attachment.browser_download_url ?? `/attachments/${attachment.uuid}`);
    })
    .catch((error: unknown) => {
      onError(error instanceof Error ? error.message : String(error));
    });
}
</script>

<template>
  <div class="pull-review-comment-editor">
    <h2 class="editor-title">{{ title }}</h2>
    <div class="editor-context">
      <span class="context-path">{{ context.path }}</span>
      <span class="context-line">{{ t('pullReviewCommentEditor.line', { line: context.lineNumber + 1 }) }}</span>
    </div>
    <EasyMdeEditor
      v-model="body"
      :placeholder="t('pullReviewCommentEditor.placeholder')"
      :upload-image="uploadImage"
      :instance-id="context.instanceId"
      :owner="context.owner"
      :repo="context.repo"
    />
    <div v-if="isReviewMode && hasPendingReview" class="review-event">
      <span class="review-event-label">{{ t('pullReviewCommentEditor.reviewEvent') }}</span>
      <vscode-radio-group variant="vertical">
        <vscode-radio value="COMMENT" :checked="reviewEvent === 'COMMENT'" @change="reviewEvent = 'COMMENT'">
          {{ t('pullReviewCommentEditor.eventComment') }}
        </vscode-radio>
        <vscode-radio value="APPROVED" :checked="reviewEvent === 'APPROVED'" @change="reviewEvent = 'APPROVED'">
          {{ t('pullReviewCommentEditor.eventApprove') }}
        </vscode-radio>
        <vscode-radio
          value="REQUEST_CHANGES"
          :checked="reviewEvent === 'REQUEST_CHANGES'"
          @change="reviewEvent = 'REQUEST_CHANGES'"
        >
          {{ t('pullReviewCommentEditor.eventRequestChanges') }}
        </vscode-radio>
      </vscode-radio-group>
    </div>
    <div class="editor-actions">
      <vscode-button
        v-if="!isReviewMode || !hasPendingReview"
        :disabled="submitting || !body.trim()"
        @click="submitSingle"
      >
        {{ t('pullReviewCommentEditor.addSingleComment') }}
      </vscode-button>
      <vscode-button
        v-if="isReviewMode && !hasPendingReview"
        :disabled="submitting || !body.trim()"
        @click="startOrAddToReview"
      >
        {{ t('pullReviewCommentEditor.startReview') }}
      </vscode-button>
      <vscode-button
        v-if="isReviewMode && hasPendingReview"
        :disabled="submitting || !body.trim()"
        @click="startOrAddToReview"
      >
        {{ t('pullReviewCommentEditor.addToReview') }}
      </vscode-button>
      <vscode-button v-if="isReviewMode && hasPendingReview" :disabled="submitting" @click="submitReview">
        {{ t('pullReviewCommentEditor.submitReview') }}
      </vscode-button>
      <vscode-button v-if="isReviewMode && hasPendingReview" :disabled="submitting" secondary @click="cancelReview">
        {{ t('pullReviewCommentEditor.cancelReview') }}
      </vscode-button>
      <vscode-button secondary @click="closePanel">
        {{ t('pullReviewCommentEditor.close') }}
      </vscode-button>
    </div>
  </div>
</template>

<style scoped>
.pull-review-comment-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 12px;
  box-sizing: border-box;
}

.editor-title {
  margin: 0;
  font-size: 1.1em;
  font-weight: 600;
}

.editor-context {
  display: flex;
  gap: 12px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.context-path {
  font-family: var(--vscode-editor-font-family);
}

.review-event {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.review-event-label {
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}

.editor-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
