# Webview State Management

The webview uses a single shared reactive store implemented with Vue's `reactive` API.

## Store shape

The store holds:

- `instances` — Forgejo instances and their tokens (token values are not exposed to the UI).
- `locale` — current language (`zh` or `en`).
- `debug` — whether API request logging is enabled.
- `worktrees` — list of local worktrees.
- `worktreeOpenMode` and `worktreeCacheDirectory` — worktree settings.
- `currentView` and `viewParams` — current route state.

## Creating the store

The store is created once by `createAppState()` and exported as a singleton. This ensures that all components and composables share the same reactive object, even across multiple Vue roots or tests.

## Mutations

State is mutated through helper functions in `useAppState`:

- `setInstances`
- `setLocale`
- `setDebug`
- `setWorktrees`
- `setCurrentView`

Direct mutation of the store from components is discouraged.

## Routing

Routing is implemented as a thin layer on top of the store. `currentView` is a string like `dashboard`, `repository`, `issue`, or `pullRequest`, and `viewParams` carries the data needed to render that view.

## Reactivity

Components access state through composables such as `useAppState` and `useI18n`. Because the store is a single `reactive` object, destructured properties must be accessed through getters or computed properties to preserve reactivity.

## Testing

Tests use a helper that creates a fresh store instance and provides mocked i18n and router state. See `packages/forgejo-toolkit/webview/src/test-utils.ts`.
