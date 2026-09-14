import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import TokenScopeList from '../TokenScopeList.vue';

describe('TokenScopeList', () => {
  it('lists the audited read and write scopes with descriptions', () => {
    const wrapper = mount(TokenScopeList, { global: { plugins: [createTestI18n()] } });

    const items = wrapper.findAll('li');
    expect(items).toHaveLength(7);
    const text = wrapper.text();
    for (const scope of [
      'read:user',
      'read:repository',
      'read:issue',
      'read:notification',
      'write:repository',
      'write:issue',
      'write:notification',
    ]) {
      expect(text).toContain(scope);
    }
  });
});
