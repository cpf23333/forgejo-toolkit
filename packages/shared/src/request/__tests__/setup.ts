import { beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const mockServer = setupServer();

beforeAll(() => {
  mockServer.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  mockServer.resetHandlers();
});

afterAll(() => {
  mockServer.close();
});

export { mockServer, http, HttpResponse };
