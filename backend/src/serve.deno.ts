import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { createApp } from './server.js';
import { loadEnv } from './config/env.js';

function getApp(): ReturnType<typeof createApp> {
  return createApp();
}

interface CapturedResponse {
  statusCode: number;
  statusMessage: string;
  headers: Headers;
  body: Uint8Array;
}

function headersToObject(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    const existing = out[lower];
    if (existing === undefined) {
      out[lower] = v;
    } else if (Array.isArray(existing)) {
      existing.push(v);
    } else {
      out[lower] = [existing, v];
    }
  }
  return out;
}

function buildNodeRequest(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body != null;

  const stream = hasBody ? Readable.fromWeb(request.body as never) : Readable.from([]);

  Object.assign(stream, {
    url: `${url.pathname}${url.search}`,
    method,
    headers: headersToObject(request.headers),
    aborted: false,
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket: { remoteAddress: '127.0.0.1', encrypted: url.protocol === 'https:' },
    connection: { remoteAddress: '127.0.0.1' },
  });

  return stream as unknown as IncomingMessage;
}

function buildNodeResponse(
  request: Request,
  onDone: (captured: CapturedResponse) => void,
): ServerResponse {
  const headerStore = new Map<string, string[]>();
  const bodyChunks: Uint8Array[] = [];

  const res: Record<string, unknown> = {
    statusCode: 200,
    statusMessage: 'OK',
    headersSent: false,
    finished: false,
  };

  res.setHeader = function (name: string, value: string | number | string[]): void {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    headerStore.set(name.toLowerCase(), values);
  };
  res.getHeader = function (name: string): string | number | string[] | undefined {
    const v = headerStore.get(name.toLowerCase());
    if (!v) return undefined;
    return v.length === 1 ? v[0]! : v;
  };
  res.getHeaders = function (): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of headerStore.entries()) {
      out[k] = v.length === 1 ? v[0]! : v;
    }
    return out;
  };
  res.hasHeader = function (name: string): boolean {
    return headerStore.has(name.toLowerCase());
  };
  res.removeHeader = function (name: string): void {
    headerStore.delete(name.toLowerCase());
  };
  res.writeHead = function (
    status: number,
    messageOrHeaders?: string | Record<string, string | string[]>,
    headersArg?: Record<string, string | string[]>,
  ): ServerResponse {
    res.statusCode = status;
    if (typeof messageOrHeaders === 'string') {
      res.statusMessage = messageOrHeaders;
    }
    const hdrs = (typeof messageOrHeaders === 'object' ? messageOrHeaders : headersArg) ?? {};
    for (const [k, v] of Object.entries(hdrs)) {
      const values = Array.isArray(v) ? v : [v];
      headerStore.set(k.toLowerCase(), values);
    }
    res.headersSent = true;
    return res as unknown as ServerResponse;
  };
  res.write = function (
    chunk: string | Buffer | Uint8Array,
    _encoding?: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean {
    const buf =
      typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk)) : new Uint8Array(chunk);
    bodyChunks.push(buf);
    if (callback) callback();
    return true;
  };
  res.end = function (
    chunk?: string | Buffer | Uint8Array,
    _encoding?: BufferEncoding,
    callback?: () => void,
  ): ServerResponse {
    if (chunk) {
      const buf =
        typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk)) : new Uint8Array(chunk);
      bodyChunks.push(buf);
    }
    if (!res.headersSent && headerStore.size > 0) {
      res.headersSent = true;
    }
    res.finished = true;

    const total = bodyChunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of bodyChunks) {
      merged.set(c, off);
      off += c.byteLength;
    }

    const out = new Headers();
    for (const [k, v] of headerStore.entries()) {
      for (const one of v) out.append(k, one);
    }

    onDone({
      statusCode: res.statusCode as number,
      statusMessage: res.statusMessage as string,
      headers: out,
      body: merged,
    });

    if (callback) callback();
    return res as unknown as ServerResponse;
  };
  res.on = function (): ServerResponse {
    return res as unknown as ServerResponse;
  };
  res.once = function (): ServerResponse {
    return res as unknown as ServerResponse;
  };
  res.emit = function (): boolean {
    return true;
  };
  res.removeListener = function (): ServerResponse {
    return res as unknown as ServerResponse;
  };
  res.removeAllListeners = function (): ServerResponse {
    return res as unknown as ServerResponse;
  };

  void request;
  return res as unknown as ServerResponse;
}

export default {
  async fetch(request: Request): Promise<Response> {
    void loadEnv();
    const app = getApp();

    return new Promise<Response>((resolve) => {
      const nodeReq = buildNodeRequest(request);
      const nodeRes = buildNodeResponse(request, (captured) => {
        resolve(
          new Response(captured.body, {
            status: captured.statusCode,
            statusText: captured.statusMessage,
            headers: captured.headers,
          }),
        );
      });

      app(
        nodeReq as unknown as ExpressRequest,
        nodeRes as unknown as ExpressResponse,
        (err: unknown) => {
          if (err) {
            if (!nodeRes.headersSent) {
              resolve(
                new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), {
                  status: 500,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            } else {
              resolve(new Response(null, { status: 500 }));
            }
          }
        },
      );
    });
  },
};
