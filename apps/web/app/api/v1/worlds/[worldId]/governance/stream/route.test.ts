import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

const worldId = '018f8652-3cb6-7d52-904b-cce7901d7e25';

afterEach(() => vi.unstubAllGlobals());

describe('governance realtime browser boundary', () => {
  it('forwards session and cursor headers and preserves the response stream', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(inputUrl).toContain('/governance/stream?after=41');
      const headers = new Headers(init?.headers);
      expect(headers.get('accept')).toBe('text/event-stream');
      expect(headers.get('cookie')).toBe('worldgraph_session=opaque');
      expect(headers.get('last-event-id')).toBe('42');
      return new Response('id: 43\nevent: governance\ndata: {"safe":true}\n\n', {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', upstream);

    const response = await GET(
      new Request(`http://localhost/api/v1/worlds/${worldId}/governance/stream?after=41`, {
        headers: {
          cookie: 'worldgraph_session=opaque',
          'last-event-id': '42',
        },
      }),
      { params: Promise.resolve({ worldId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await expect(response.text()).resolves.toContain('"safe":true');
  });

  it('rejects malformed world identities without contacting the API', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await GET(
      new Request('http://localhost/api/v1/worlds/not-a-uuid/governance/stream'),
      { params: Promise.resolve({ worldId: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
