import type {} from 'vue';

declare module '@vue/runtime-dom' {
  interface ReservedProps {
    slot?: string;
  }
}

declare module 'vue' {
  interface ReservedProps {
    slot?: string;
  }
}
