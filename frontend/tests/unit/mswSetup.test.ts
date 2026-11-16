import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { apiRequest } from '../../src/api/client';
import { server } from '../mocks/server';
import { holidaysListAll } from '../mocks/handlers';

describe('shared MSW setup', () => {
  it.each(['start=2026-06-01&end=2026-07-12', 'end=2026-07-12&start=2026-06-01'])(
    'matches the default holiday range handler with %s',
    async (query) => {
      const matchedRanges: Array<{ pathname: string; start: string | null; end: string | null }> =
        [];
      const recordRange = ({ request }: { request: Request }): void => {
        const url = new URL(request.url);
        matchedRanges.push({
          pathname: url.pathname,
          start: url.searchParams.get('start'),
          end: url.searchParams.get('end'),
        });
      };
      server.events.on('request:match', recordRange);

      try {
        expect(await apiRequest(`/holidays?${query}`)).toEqual([]);
        expect(matchedRanges).toEqual([
          { pathname: '/holidays', start: '2026-06-01', end: '2026-07-12' },
        ]);
      } finally {
        server.events.removeListener('request:match', recordRange);
      }
    },
  );

  it.each(['/holidays/all', '/__msw_unhandled_api_probe__'])(
    'rejects unhandled API path %s instead of warning or bypassing',
    async (pathname) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(apiRequest(pathname)).rejects.toMatchObject({
          name: 'ApiError',
          status: 0,
          body: { code: 'NETWORK' },
        });
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(
            '[MSW] Error: intercepted a request without a matching request handler:',
          ),
        );
        expect(error).toHaveBeenCalledWith(expect.stringContaining(`GET ${pathname}`));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it('keeps the explicit holiday administration handler distinct from the range handler', async () => {
    server.use(holidaysListAll);
    expect(await apiRequest('/holidays/all')).toEqual([
      { id: 'h-1', date: '2026-07-04', name: 'Independence Day', countryCode: 'US' },
      { id: 'h-2', date: '2026-12-25', name: 'Christmas Day', countryCode: null },
    ]);
  });

  it('restores the original handler set after resetting a runtime override', async () => {
    const initialHandlers = server.listHandlers();
    server.use(http.get('/holidays', () => HttpResponse.json([{ id: 'temporary-override' }])));

    expect(await apiRequest('/holidays?start=2026-06-01&end=2026-07-12')).toEqual([
      { id: 'temporary-override' },
    ]);

    server.resetHandlers();
    expect(server.listHandlers()).toEqual(initialHandlers);
    expect(await apiRequest('/holidays?end=2026-07-12&start=2026-06-01')).toEqual([]);
  });
});
