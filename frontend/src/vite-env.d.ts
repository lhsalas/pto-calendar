/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /**
   * Default per-request timeout in milliseconds. Defaults to 15000 when unset.
   * `apiRequest` aborts the underlying `fetch` via a per-request `AbortController`
   * after this many ms and throws a typed `ApiError` with code `TIMEOUT`.
   */
  readonly VITE_API_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
