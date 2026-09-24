<script lang="ts">
// Module scope, not `<script setup>` scope: a counter declared inside the setup
// block is re-created per instance (the compiler keeps it in the setup closure),
// so every picker would start at 1. Several pickers share a form (the issue and
// pull request edit dialogs have one each), and duplicate panel ids would make
// every `aria-controls` resolve to the first panel — a screen reader would
// announce the wrong dialog.
let pickerSequence = 0;

function nextPanelId(): string {
  pickerSequence += 1;
  return `date-time-panel-${pickerSequence}`;
}
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  modelValue?: string | null;
  placeholder?: string;
  /**
   * Accessible name of the field. A neighbouring `<label>` cannot be associated
   * with the input across the component boundary, so callers pass the field
   * name here; screen readers otherwise announce only "Select date and time".
   */
  label?: string;
  disabled?: boolean;
  displayFormat?: string;
  valueFormat?: string;
  type?: 'date' | 'datetime';
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void;
}>();

const { t, locale } = useI18n();

const inputRef = ref<HTMLInputElement | null>(null);
const panelOpen = ref(false);
const panelRef = ref<HTMLDivElement | null>(null);
const rootRef = ref<HTMLDivElement | null>(null);
const panelStyle = ref({ top: '0px', left: '0px' });

// Unique per instance so the field's `aria-controls` points at its own panel
// when several pickers are rendered in the same form.
const panelId = nextPanelId();

function onDocumentClick(event: MouseEvent) {
  const target = event.target as Node;
  if (!rootRef.value?.contains(target)) {
    // The pointer moved somewhere else: leave focus where the user clicked
    // instead of pulling it back to the field.
    closePanel(false);
  }
}

// The panel is `position: fixed` (the edit dialogs are scroll containers, so an
// absolutely positioned panel would be clipped), which means it must be clamped
// to the viewport by hand: at a narrow sidebar or a high zoom level its right
// columns and footer otherwise render outside the webview with no way to scroll
// to them. Mirrors MentionHoverCard's clamping.
const PANEL_MIN_WIDTH = 260;
const VIEWPORT_GAP = 8;

function updatePanelPosition() {
  const rect = inputRef.value?.getBoundingClientRect();
  if (!rect) return;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const panelWidth = Math.max(panelRef.value?.offsetWidth ?? 0, PANEL_MIN_WIDTH);
  const panelHeight = panelRef.value?.offsetHeight ?? 0;
  const maxLeft = Math.max(VIEWPORT_GAP, viewportWidth - panelWidth - VIEWPORT_GAP);
  const left = Math.min(Math.max(rect.left, VIEWPORT_GAP), maxLeft);
  // Prefer opening below the field; flip above it when it would not fit and
  // there is more room up there (the field is near the bottom of the viewport).
  const below = rect.bottom + 4;
  const above = rect.top - panelHeight - 4;
  const fitsBelow = panelHeight === 0 || below + panelHeight <= viewportHeight - VIEWPORT_GAP;
  const top = fitsBelow ? below : Math.max(VIEWPORT_GAP, above);
  panelStyle.value = {
    top: `${top}px`,
    left: `${left}px`,
  };
}

function updateClickListener(open: boolean) {
  if (open) {
    document.addEventListener('mousedown', onDocumentClick);
  } else {
    document.removeEventListener('mousedown', onDocumentClick);
  }
}

watch(panelOpen, updateClickListener);

onMounted(() => {
  if (panelOpen.value) {
    document.addEventListener('mousedown', onDocumentClick);
  }
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentClick);
});

const pickerType = computed(() => props.type ?? 'datetime');
const isDateOnly = computed(() => pickerType.value === 'date');
const displayFormat = computed(() => props.displayFormat ?? (isDateOnly.value ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm'));
const valueFormat = computed(() => props.valueFormat ?? 'iso');

// The caller's label names the field ("Due date"); without one the generic
// picker description is still better than an unlabelled field.
const fieldLabel = computed(() => props.label || t('datePicker.placeholder'));

const weekDays = computed(() => {
  const formatter = new Intl.DateTimeFormat(locale.value, { weekday: 'narrow' });
  // Use a Sunday-start reference week
  const base = new Date(2024, 0, 7); // Sunday
  return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(base.getTime() + i * 86400000)));
});

const selectedDate = computed(() => {
  if (!props.modelValue) return null;
  return parseValue(props.modelValue);
});

const displayValue = computed(() => {
  if (!selectedDate.value) return '';
  return formatDate(selectedDate.value, displayFormat.value);
});

const viewDate = ref(new Date());

watch(
  () => props.modelValue,
  (value) => {
    const parsed = value ? parseValue(value) : null;
    viewDate.value = parsed && !isNaN(parsed.getTime()) ? new Date(parsed) : new Date();
    if (viewDate.value.toString() === 'Invalid Date') {
      viewDate.value = new Date();
    }
  },
  { immediate: true },
);

const calendarRows = computed(() => {
  const year = viewDate.value.getFullYear();
  const month = viewDate.value.getMonth();
  const firstDayOfMonth = new Date(year, month, 1);
  const start = new Date(firstDayOfMonth);
  start.setDate(start.getDate() - firstDayOfMonth.getDay());

  const rows: Date[][] = [];
  let current = new Date(start);
  for (let week = 0; week < 6; week++) {
    const days: Date[] = [];
    for (let day = 0; day < 7; day++) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    rows.push(days);
  }
  return rows;
});

const hourValue = computed({
  get() {
    return selectedDate.value ? pad(selectedDate.value.getHours()) : '00';
  },
  set(value: string) {
    updateTime(value, minuteValue.value);
  },
});

const minuteValue = computed({
  get() {
    return selectedDate.value ? pad(selectedDate.value.getMinutes()) : '00';
  },
  set(value: string) {
    updateTime(hourValue.value, value);
  },
});

function parseISO(value: string): Date | null {
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function parseValue(value: string): Date | null {
  if (valueFormat.value === 'iso') {
    return parseISO(value);
  }
  return parseFormatted(value, valueFormat.value);
}

function parseFormatted(value: string, format: string): Date | null {
  const tokens = extractTokens(format);
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let index = 0;

  for (const token of tokens) {
    if (index >= value.length) break;

    // Skip literal characters before the token
    const literalBefore = token.literalBefore;
    if (literalBefore && value.slice(index, index + literalBefore.length) === literalBefore) {
      index += literalBefore.length;
    }

    const raw = value.slice(index, index + token.length);
    const num = parseInt(raw, 10);
    if (Number.isNaN(num)) return null;

    switch (token.type) {
      case 'yyyy':
        year = num;
        break;
      case 'MM':
        month = clamp(num, 1, 12);
        break;
      case 'dd':
        day = clamp(num, 1, 31);
        break;
      case 'HH':
        hour = clamp(num, 0, 23);
        break;
      case 'mm':
        minute = clamp(num, 0, 59);
        break;
      case 'ss':
        second = clamp(num, 0, 59);
        break;
    }
    index += token.length;
  }

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

interface Token {
  type: string;
  length: number;
  literalBefore: string;
}

function extractTokens(format: string): Token[] {
  const supported = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'];
  const tokens: Token[] = [];
  let index = 0;
  let literalBuffer = '';

  while (index < format.length) {
    const matched = supported.find((token) => format.slice(index, index + token.length) === token);
    if (matched) {
      tokens.push({ type: matched, length: matched.length, literalBefore: literalBuffer });
      literalBuffer = '';
      index += matched.length;
    } else {
      literalBuffer += format[index];
      index += 1;
    }
  }
  return tokens;
}

function formatDate(date: Date, format: string): string {
  const map: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (match) => map[match] ?? match);
}

function formatValue(date: Date): string {
  if (valueFormat.value === 'iso') {
    if (isDateOnly.value) {
      // A picked day is a calendar day, not an instant: emit UTC noon so the
      // stored timestamp lands on that day regardless of timezone. Local
      // midnight shifts to the previous day for every timezone east of UTC.
      return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12)).toISOString();
    }
    return date.toISOString();
  }
  return formatDate(date, valueFormat.value);
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isCurrentMonth(date: Date): boolean {
  return date.getMonth() === viewDate.value.getMonth() && date.getFullYear() === viewDate.value.getFullYear();
}

function selectDay(date: Date) {
  const current = selectedDate.value ? new Date(selectedDate.value) : new Date(date);
  current.setFullYear(date.getFullYear());
  current.setMonth(date.getMonth());
  current.setDate(date.getDate());
  emit('update:modelValue', formatValue(current));
}

function updateTime(hour: string, minute: string) {
  const h = clamp(parseInt(hour, 10) || 0, 0, 23);
  const m = clamp(parseInt(minute, 10) || 0, 0, 59);
  const date = selectedDate.value ? new Date(selectedDate.value) : new Date();
  date.setHours(h);
  date.setMinutes(m);
  emit('update:modelValue', formatValue(date));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function prevMonth() {
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() - 1, 1);
}

function nextMonth() {
  viewDate.value = new Date(viewDate.value.getFullYear(), viewDate.value.getMonth() + 1, 1);
}

function goToToday() {
  const now = new Date();
  viewDate.value = new Date(now.getFullYear(), now.getMonth(), 1);
  selectDay(now);
}

function clearValue() {
  emit('update:modelValue', null);
  closePanel(true);
}

function openPanel(moveFocusIntoPanel = false) {
  if (props.disabled) return;
  if (!panelOpen.value) {
    panelOpen.value = true;
    nextTick(() => {
      updatePanelPosition();
      if (moveFocusIntoPanel) {
        panelRef.value?.focus();
      }
    });
    return;
  }
  if (moveFocusIntoPanel) {
    nextTick(() => {
      panelRef.value?.focus();
    });
  }
}

function closePanel(restoreFieldFocus = false) {
  if (!panelOpen.value) return;
  panelOpen.value = false;
  if (restoreFieldFocus) {
    // The panel is about to be unmounted; without this the keyboard focus would
    // fall back to the document body and the user would lose their place.
    nextTick(() => {
      inputRef.value?.focus();
    });
  }
}

function togglePanel() {
  if (props.disabled) return;
  if (panelOpen.value) {
    closePanel();
  } else {
    openPanel();
  }
}

// The field is readonly, so it cannot be edited with the keyboard — but it must
// still be operable: Enter/Space toggles the panel and ArrowDown opens it and
// moves focus inside, where every control is a real button.
function onInputKeyDown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (panelOpen.value) {
      closePanel(true);
    } else {
      openPanel(true);
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openPanel(true);
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && panelOpen.value) {
    // Keep Esc scoped to the date panel: preventing default stops the
    // enclosing native <dialog> from firing its cancel event, which would
    // otherwise close the whole edit modal (and, on a dirty form, pop the
    // discard confirmation) while the user only meant to close the panel.
    event.preventDefault();
    event.stopPropagation();
    closePanel(true);
  }
}

function monthYearLabel() {
  return new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(viewDate.value);
}
</script>

<template>
  <div ref="rootRef" class="date-time-picker" @keydown.esc="onKeyDown">
    <input
      ref="inputRef"
      type="text"
      class="date-time-input"
      role="combobox"
      aria-haspopup="dialog"
      :aria-expanded="panelOpen"
      :aria-controls="panelId"
      :aria-label="fieldLabel"
      :value="displayValue"
      :placeholder="placeholder || t('datePicker.placeholder')"
      :disabled="disabled"
      readonly
      @click="togglePanel"
      @keydown="onInputKeyDown"
    />

    <div
      v-if="panelOpen"
      :id="panelId"
      ref="panelRef"
      class="date-time-panel"
      role="dialog"
      :aria-label="fieldLabel"
      tabindex="-1"
      :style="panelStyle"
    >
      <div class="panel-header">
        <button class="panel-nav" type="button" @click="prevMonth" :aria-label="t('datePicker.prevMonth')">‹</button>
        <span class="panel-title">{{ monthYearLabel() }}</span>
        <button class="panel-nav" type="button" @click="nextMonth" :aria-label="t('datePicker.nextMonth')">›</button>
      </div>

      <div class="calendar-grid">
        <span v-for="day in weekDays" :key="day" class="week-day">{{ day }}</span>
        <button
          v-for="date in calendarRows.flat()"
          :key="date.toISOString()"
          type="button"
          class="day-cell"
          :class="{
            'day-current-month': isCurrentMonth(date),
            'day-selected': selectedDate && isSameDay(date, selectedDate),
            'day-today': isSameDay(date, new Date()),
          }"
          @click="selectDay(date)"
        >
          {{ date.getDate() }}
        </button>
      </div>

      <div v-if="!isDateOnly" class="time-row">
        <span class="time-label" aria-hidden="true">{{ t('datePicker.time') }}</span>
        <input
          v-model="hourValue"
          type="number"
          min="0"
          max="23"
          class="time-input"
          :aria-label="t('datePicker.hours')"
          @blur="hourValue = hourValue"
        />
        <span class="time-separator" aria-hidden="true">:</span>
        <input
          v-model="minuteValue"
          type="number"
          min="0"
          max="59"
          class="time-input"
          :aria-label="t('datePicker.minutes')"
          @blur="minuteValue = minuteValue"
        />
      </div>

      <div class="panel-footer">
        <button type="button" class="panel-button secondary" @click="goToToday">
          {{ t('datePicker.today') }}
        </button>
        <button type="button" class="panel-button secondary" @click="clearValue">
          {{ t('datePicker.clear') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.date-time-picker {
  position: relative;
  display: inline-block;
  width: 100%;
}

.date-time-input {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 1.4;
  color: var(--vscode-input-foreground);
  background-color: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  outline: none;
}

.date-time-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.date-time-input:focus {
  border-color: var(--vscode-focusBorder);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.date-time-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.date-time-panel {
  position: fixed;
  z-index: 100;
  min-width: 260px;
  padding: 8px;
  background-color: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

.date-time-panel:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.panel-title {
  font-weight: 600;
}

.panel-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--vscode-button-foreground);
  background-color: var(--vscode-button-secondaryBackground);
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 16px;
}

.panel-nav:hover {
  background-color: var(--vscode-button-secondaryHoverBackground);
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
  margin-bottom: 8px;
}

.week-day {
  padding: 4px 0;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.day-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  margin: 0 auto;
  color: var(--vscode-foreground);
  background-color: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.95em;
}

.day-cell:not(.day-current-month) {
  color: var(--vscode-disabledForeground);
}

.day-cell:hover {
  background-color: var(--vscode-list-hoverBackground);
}

.day-cell:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.day-cell.day-selected {
  color: var(--vscode-button-foreground);
  background-color: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}

.day-cell.day-today:not(.day-selected) {
  border-color: var(--vscode-focusBorder);
}

.time-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
}

.time-label {
  flex: 1;
  color: var(--vscode-descriptionForeground);
}

.time-input {
  width: 44px;
  padding: 3px 4px;
  text-align: center;
  color: var(--vscode-input-foreground);
  background-color: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

.time-input:focus {
  border-color: var(--vscode-focusBorder);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.time-separator {
  color: var(--vscode-descriptionForeground);
}

.panel-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}

.panel-button {
  flex: 1;
  padding: 4px 8px;
  border: none;
  border-radius: 2px;
  cursor: pointer;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

.panel-button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background-color: var(--vscode-button-secondaryBackground);
}

.panel-button.secondary:hover {
  background-color: var(--vscode-button-secondaryHoverBackground);
}
</style>
