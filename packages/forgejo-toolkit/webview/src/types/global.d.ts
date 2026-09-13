import type {
  VscodeButton,
  VscodeCheckbox,
  VscodeContextMenu,
  VscodeIcon,
  VscodeOption,
  VscodeProgressRing,
  VscodeRadio,
  VscodeRadioGroup,
  VscodeSingleSelect,
  VscodeTextfield,
  VscodeTree,
  VscodeTreeItem,
} from '@vscode-elements/elements';
import type { VscContextMenuSelectEvent } from '@vscode-elements/elements/dist/vscode-context-menu/vscode-context-menu.js';
import type { VscSingleSelectCreateOptionEvent } from '@vscode-elements/elements/dist/vscode-single-select/vscode-single-select.js';
import type { VscTreeSelectEvent } from '@vscode-elements/elements/dist/vscode-tree/vscode-tree.js';
import type { EmitFn, HTMLAttributes, PublicProps } from 'vue';

export {};

type EventMap = {
  [event: string]: Event;
};

type VueEmit<T extends EventMap> = EmitFn<{
  [K in keyof T]: (event: T[K]) => void;
}>;

type DefineCustomElement<
  ElementType extends HTMLElement,
  Events extends EventMap = {},
  SelectedAttributes extends keyof ElementType = keyof ElementType,
  ExtraProps = {},
> = new () => ElementType & {
  $props: HTMLAttributes &
    Partial<Pick<ElementType, SelectedAttributes>> &
    ExtraProps &
    PublicProps & {
      slot?: string;
    };
  $emit: VueEmit<Events>;
};

type VscodeButtonProps = Pick<
  VscodeButton,
  | 'autofocus'
  | 'secondary'
  | 'block'
  | 'disabled'
  | 'icon'
  | 'iconSpin'
  | 'iconSpinDuration'
  | 'iconAfter'
  | 'iconAfterSpin'
  | 'iconAfterSpinDuration'
  | 'focused'
  | 'name'
  | 'iconOnly'
  | 'type'
  | 'value'
>;

type VscodeCheckboxProps = Pick<VscodeCheckbox, 'autofocus' | 'checked' | 'defaultChecked' | 'invalid' | 'name'>;

type VscodeContextMenuProps = Pick<VscodeContextMenu, 'data' | 'preventClose' | 'show' | 'tabIndex'>;

type VscodeIconProps = Pick<VscodeIcon, 'label' | 'name' | 'size' | 'spin' | 'spinDuration' | 'actionIcon'>;

type VscodeOptionProps = Pick<VscodeOption, 'value' | 'description' | 'selected' | 'disabled'>;

type VscodeProgressRingProps = Pick<VscodeProgressRing, 'ariaLabel'>;

type VscodeRadioProps = Pick<VscodeRadio, 'checked' | 'defaultChecked' | 'disabled' | 'name' | 'required' | 'value'>;

type VscodeRadioGroupProps = Pick<VscodeRadioGroup, 'variant'>;

type VscodeSingleSelectProps = Pick<
  VscodeSingleSelect,
  | 'defaultValue'
  | 'name'
  | 'selectedIndex'
  | 'value'
  | 'required'
  | 'disabled'
  | 'invalid'
  | 'label'
  | 'filter'
  | 'combobox'
  | 'open'
  | 'position'
  | 'creatable'
>;

type VscodeTextfieldProps = Pick<
  VscodeTextfield,
  | 'autocomplete'
  | 'autofocus'
  | 'defaultValue'
  | 'disabled'
  | 'focused'
  | 'invalid'
  | 'label'
  | 'max'
  | 'maxLength'
  | 'min'
  | 'minLength'
  | 'multiple'
  | 'name'
  | 'pattern'
  | 'placeholder'
  | 'readonly'
  | 'required'
  | 'step'
  | 'type'
  | 'value'
  | 'minlength'
  | 'maxlength'
>;

type VscodeTreeProps = Pick<VscodeTree, 'expandMode' | 'hideArrows' | 'indent' | 'indentGuides' | 'multiSelect'>;

type VscodeTreeItemProps = Pick<
  VscodeTreeItem,
  'active' | 'branch' | 'hasActiveItem' | 'hasSelectedItem' | 'open' | 'level' | 'selected'
>;

/** data-* attributes read back via `dataset` in the tree select handler (RepoFileBrowser.onTreeSelect). */
type VscodeTreeItemDataProps = {
  dataFilePath?: string;
  dataType?: string;
  dataSize?: number;
};

declare module 'vue' {
  interface GlobalComponents {
    'vscode-button': DefineCustomElement<VscodeButton, { click: MouseEvent }, keyof VscodeButtonProps>;
    'vscode-checkbox': DefineCustomElement<VscodeCheckbox, { change: Event }, keyof VscodeCheckboxProps>;
    'vscode-context-menu': DefineCustomElement<
      VscodeContextMenu,
      { 'vsc-context-menu-select': VscContextMenuSelectEvent },
      keyof VscodeContextMenuProps
    >;
    'vscode-icon': DefineCustomElement<VscodeIcon, {}, keyof VscodeIconProps>;
    'vscode-option': DefineCustomElement<VscodeOption, {}, keyof VscodeOptionProps>;
    'vscode-progress-ring': DefineCustomElement<VscodeProgressRing, {}, keyof VscodeProgressRingProps>;
    'vscode-radio': DefineCustomElement<VscodeRadio, { change: Event }, keyof VscodeRadioProps>;
    'vscode-radio-group': DefineCustomElement<VscodeRadioGroup, { change: Event }, keyof VscodeRadioGroupProps>;
    'vscode-single-select': DefineCustomElement<
      VscodeSingleSelect,
      { change: Event; input: Event; 'vsc-single-select-create-option': VscSingleSelectCreateOptionEvent },
      keyof VscodeSingleSelectProps
    >;
    'vscode-textfield': DefineCustomElement<
      VscodeTextfield,
      { change: Event; input: Event },
      keyof VscodeTextfieldProps,
      // Fallthrough attribute used by ModalDialog to find the field to focus.
      { dataAutofocus?: boolean | string }
    >;
    'vscode-tree': DefineCustomElement<VscodeTree, { 'vsc-tree-select': VscTreeSelectEvent }, keyof VscodeTreeProps>;
    'vscode-tree-item': DefineCustomElement<VscodeTreeItem, {}, keyof VscodeTreeItemProps, VscodeTreeItemDataProps>;
  }
}
