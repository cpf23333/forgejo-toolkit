// The shared client is the default export because kubb-generated operations
// fall back to it when no client is configured. Two contract points every
// consumer must know (documented in full on `client` in
// packages/shared/src/request/index.ts): it has no built-in timeout — callers
// must supply their own timeout `signal` — and sending an `Authorization`
// header relies on the fetch specification (undici's implementation of it)
// stripping that header on a cross-origin redirect.
export { client as default, client } from '@cpf23333-forgejo-toolkit/shared/request';
export type * from '@cpf23333-forgejo-toolkit/shared/request';
export * from './generated/client/index';
export * from './generated/types/index';
