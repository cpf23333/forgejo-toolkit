import { defineConfig } from '@kubb/core';
import { pluginOas } from '@kubb/plugin-oas';
import { pluginTs } from '@kubb/plugin-ts';
import { pluginClient } from '@kubb/plugin-client';
import { pluginMsw } from '@kubb/plugin-msw';

export default defineConfig({
  root: '.',
  input: {
    // Pinned snapshot: the live endpoint tracks whatever version the server runs,
    // so the generated client could change without a commit explaining why.
    // Refresh deliberately with `pnpm --filter @cpf23333-forgejo-toolkit/api spec:update`
    // and record the version in spec/README.md.
    path: './spec/swagger.v1.json',
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
