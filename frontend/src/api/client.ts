export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: payload,
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const errorBody =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error: ApiErrorBody }).error
        : { code: 'UNKNOWN', message: res.statusText };
    throw new ApiError(res.status, errorBody);
  }

  return parsed as T;
}
