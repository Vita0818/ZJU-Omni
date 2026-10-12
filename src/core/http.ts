import { CookieJar } from './cookies.ts';
import { ToolError } from './errors.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { TransportMode } from './store.ts';

export interface Transport {
  readonly mode: TransportMode;
  toPhysical(url: URL): URL;
  toLogical(url: URL): URL;
}

export const directTransport: Transport = {
  mode: 'direct',
  toPhysical: url => url,
  toLogical: url => url,
};

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  maxRedirects?: number;
  allowUrl?: (url: URL) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
  cookies?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: URL;
  headers: Headers;
  location: URL | null;
  contentType: string;
  body: Buffer;
  text(): string;
  json<T = any>(): T;
}

const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function connectFailure(error: any): boolean {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === 'string' && CONNECT_ERRORS.has(e.code)) return true;
    if (Array.isArray(e.errors) && e.errors.some((inner: any) => CONNECT_ERRORS.has(inner?.code))) return true;
  }
  return false;
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ToolError('RESPONSE_TOO_LARGE', '平台响应超过大小限制。', { max_bytes: maxBytes });
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) throw new ToolError('RESPONSE_TOO_LARGE', '平台响应超过大小限制。', { max_bytes: maxBytes });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface HttpClientOptions {
  jar?: CookieJar;
  transport?: Transport;
  limiter?: RateLimiter;
  limiterKey?: string;
  timeoutMs?: number;
  userAgent?: string;
  fetchImpl?: FetchImpl;
  defaultHeaders?: Record<string, string>;
}

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export class HttpClient {
  jar: CookieJar;
  transport: Transport;
  limiter?: RateLimiter;
  limiterKey: string;
  timeoutMs: number;
  userAgent: string;
  fetchImpl: FetchImpl;
  defaultHeaders: Record<string, string>;

  constructor(options: HttpClientOptions = {}) {
    this.jar = options.jar ?? new CookieJar();
    this.transport = options.transport ?? directTransport;
    this.limiter = options.limiter;
    this.limiterKey = options.limiterKey ?? 'default';
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  async request(target: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
    let url = new URL(target);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value != null) url.searchParams.set(key, String(value));
    let current: RequestOptions = options;
    const maxRedirects = options.maxRedirects ?? 0;
    for (let hop = 0; ; hop++) {
      if (options.allowUrl && !options.allowUrl(url)) {
        throw new ToolError('REDIRECT_REJECTED', '请求被重定向到未允许的站点，已停止。', { hostname: url.hostname });
      }
      const response = await this.once(url, current);
      if (response.status >= 300 && response.status < 400 && response.location && hop < maxRedirects) {
        const method = (current.method ?? 'GET').toUpperCase();
        const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD');
        if (toGet) current = { ...current, method: 'GET', json: undefined, form: undefined, body: undefined };
        url = response.location;
        continue;
      }
      if (response.status >= 300 && response.status < 400 && response.location && maxRedirects > 0) {
        throw new ToolError('REDIRECT_LIMIT', '跳转次数超过限制，已停止。');
      }
      return response;
    }
  }

  private async once(logical: URL, options: RequestOptions): Promise<HttpResponse> {
    const physical = this.transport.toPhysical(logical);
    const headers = new Headers({ 'User-Agent': this.userAgent, ...this.defaultHeaders, ...(options.headers ?? {}) });
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
    // Plain-HTTP requests never carry cookies: ZJU SSO cookies are not marked Secure.
    if (options.cookies !== false && physical.protocol === 'https:') {
      const cookie = this.jar.header(physical);
      if (cookie) headers.set('cookie', cookie);
    }
    const run = async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(physical.toString(), {
          method: options.method ?? 'GET',
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        });
      } catch (error) {
        throw new ToolError('NETWORK_ERROR', `无法连接 ${logical.hostname}，请检查网络。`, { hostname: logical.hostname, before_send: connectFailure(error) });
      }
      if (options.cookies !== false) {
        const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        if (setCookies.length) this.jar.setFromHeaders(physical, setCookies);
      }
      const status = response.status;
      const rawLocation = response.headers.get('location');
      let location: URL | null = null;
      if (status >= 300 && status < 400 && rawLocation) {
        let resolved: URL;
        try {
          resolved = new URL(rawLocation, physical);
        } catch {
          throw new ToolError('REDIRECT_REJECTED', '平台返回了无法解析的跳转地址。');
        }
        location = this.transport.toLogical(resolved);
      }
      let buffer: Buffer;
      if (status >= 300 && status < 400) {
        await response.body?.cancel().catch(() => {});
        buffer = Buffer.alloc(0);
      } else {
        try {
          buffer = await readLimited(response, options.maxBytes ?? 10 * 1024 * 1024);
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError('NETWORK_ERROR', `读取 ${logical.hostname} 响应时中断。`, { hostname: logical.hostname, before_send: false });
        }
      }
      const result: HttpResponse = {
        status,
        ok: status >= 200 && status < 300,
        url: logical,
        headers: response.headers,
        location,
        contentType: response.headers.get('content-type') ?? '',
        body: buffer,
        text: () => buffer.toString('utf8'),
        json: () => JSON.parse(buffer.toString('utf8')),
      };
      return result;
    };
    return this.limiter ? this.limiter.schedule(this.limiterKey, run) : run();
  }
}

export function isJson(response: HttpResponse): boolean {
  return /json/i.test(response.contentType);
}
