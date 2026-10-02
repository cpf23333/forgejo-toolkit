/**
 * The Kubb client core: the runtime every generated operation in
 * `src/generated/client/*` sends through, plus the types that describe a
 * transport (`Transport`, `TransportResult`, `ResolvedRequest`, `ClientInstance`).
 *
 * It needs its own entry point because the package's root barrel
 * (`src/index.ts`) re-exports only `src/generated/client/index` and
 * `src/generated/types/index`, and Kubb writes `src/generated/.kubb/client.ts`
 * neither is — so `createClientCore` and the transport types are reachable from
 * nowhere else. `src/index.ts` cannot simply re-export this file either: the root
 * exports the shared request client as `client`, and this module's own `client`
 * (the bundled instance the generated operations fall back to) would collide with
 * it.
 *
 * Only Kubb's own output is re-exported here, so a regeneration cannot invalidate
 * this file the way an edit to `src/generated/**` would.
 */
export * from './generated/.kubb/client';
