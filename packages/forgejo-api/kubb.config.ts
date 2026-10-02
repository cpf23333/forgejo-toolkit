import { defineConfig } from 'kubb/config';
import { adapterOas } from '@kubb/adapter-oas';
import { pluginTs } from '@kubb/plugin-ts';
import { pluginFetch } from '@kubb/plugin-fetch';
import { pluginMsw } from '@kubb/plugin-msw';

export default defineConfig({
  root: '.',
  // Pinned snapshot: the live endpoint tracks whatever version the server runs,
  // so the generated client could change without a commit explaining why.
  // Refresh deliberately with `pnpm --filter @cpf23333-forgejo-toolkit/api spec:update`
  // and record the version in spec/README.md.
  input: './spec/swagger.v1.json',
  adapter: adapterOas({
    validate: true,
    // v5 defaults `integerType` to 'bigint'; v4 used 'number'. Verified in
    // @kubb/adapter-oas@5.4.2 dist: `integerType: "bigint"`.
    integerType: 'number',
  }),
  output: {
    path: './src/generated',
    clean: true,
    // v5 defaults `barrel` to false; v4's 'named' default produced the
    // `generated/index.ts`, `generated/{types,client,mocks}/index.ts` barrels
    // that `src/index.ts` and `src/mocks/index.ts` re-export.
    barrel: { type: 'named' },
  },
  plugins: [
    pluginTs({
      output: {
        path: './types',
      },
    }),
    pluginFetch({
      output: {
        path: './client',
      },
      // v5 defaults to returning the full `RequestResult`; v4's generated
      // operations resolved to the response body, which every call site in
      // `packages/forgejo-toolkit/src/api/client.ts` relies on.
      returnType: 'data',
    }),
    pluginMsw({
      output: {
        path: './mocks',
      },
    }),
  ],
});
