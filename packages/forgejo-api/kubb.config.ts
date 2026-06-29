import { defineConfig } from '@kubb/core';
import { pluginOas } from '@kubb/plugin-oas';
import { pluginTs } from '@kubb/plugin-ts';
import { pluginClient } from '@kubb/plugin-client';
import { pluginMsw } from '@kubb/plugin-msw';

export default defineConfig({
  root: '.',
  input: {
    path: 'https://codeberg.org/swagger.v1.json',
  },
  output: {
    path: './src/generated',
    clean: true,
  },
  plugins: [
    pluginOas({
      validate: true,
    }),
    pluginTs({
      output: {
        path: './types',
      },
      enumType: 'asConst',
    }),
    pluginClient({
      output: {
        path: './client',
      },
      importPath: '@cpf23333-forgejo-toolkit/shared/request',
      parser: 'client',
    }),
    pluginMsw({
      output: {
        path: './mocks',
      },
    }),
  ],
});
