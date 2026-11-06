import { describe, expect, it } from 'vitest';
import { isTransient } from '../src/agent';

describe('isTransient — what an agent rides out while waiting for a job', () => {
  it('retries the Mirror Node outage seen live (API 500 wrapping a Mirror 503)', () => {
    const live = new Error(
      'GET /v1/jobs/c653d0e7 → 500 {"error":{"code":"UPSTREAM_FAILED","message":"Mirror 503 for /api/v1/topics/0.0.11332888/messages: Service Unavailable"}}',
    );
    expect(isTransient(live)).toBe(true);
  });

  it('retries other 5xx and network failures', () => {
    expect(isTransient(new Error('GET /v1/jobs/x → 502 {}'))).toBe(true);
    expect(isTransient(new Error('GET /v1/jobs/x → 503 {}'))).toBe(true);
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('connect ECONNREFUSED 127.0.0.1:4040'))).toBe(true);
  });

  it('does not retry real client errors', () => {
    expect(isTransient(new Error('GET /v1/jobs/x → 401 {"error":{"code":"UNAUTHORIZED"}}'))).toBe(false);
    expect(isTransient(new Error('GET /v1/jobs/x → 404 {"error":{"code":"NOT_FOUND"}}'))).toBe(false);
    expect(isTransient(new Error('GET /v1/jobs/x → 409 {"error":{"code":"ROUND_CLOSED"}}'))).toBe(false);
    expect(isTransient(new Error('something unrelated'))).toBe(false);
  });
});
