import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const mockServer = setupServer(...handlers);

export function startMockServer(): void {
  mockServer.listen({ onUnhandledRequest: 'warn' });
}

export function stopMockServer(): void {
  mockServer.close();
}

export function resetMockServer(): void {
  mockServer.resetHandlers(...handlers);
}
