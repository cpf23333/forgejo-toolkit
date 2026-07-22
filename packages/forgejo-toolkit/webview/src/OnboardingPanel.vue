<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Onboarding from './views/Onboarding.vue';

const { t } = useI18n();
</script>

<template>
  <div class="onboarding-panel">
    <div class="onboarding-panel-content">
      <Onboarding />
    </div>
  </div>
</template>

<style scoped>
.onboarding-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  padding: 40px 20px;
}

.onboarding-panel-content {
  width: 100%;
  max-width: 720px;
}
</style>
