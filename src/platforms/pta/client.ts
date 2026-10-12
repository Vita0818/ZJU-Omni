// Endpoint facts cross-checked with jinzcdev/vscode-pintia (MIT).
import type { AppContext } from '../../core/context.ts';
import { CookieJar, type StoredCookie } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import { HttpClient } from '../../core/http.ts';
import type { Raw } from '../../core/util.ts';
import { extractCookie } from './cookie.ts';

export const PTA_BASE = 'https://pintia.cn';
const PASSPORT = 'https://passport.pintia.cn';
const ALLOWED = new Set(['pintia.cn', 'passport.pintia.cn']);
export const PTA_SETUP = 'pbpaste | npm run cli -- pta-cookie';

export function cookiesFromHeader(header: string): StoredCookie[] {
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(c => c.name && c.value && /^[\w-]+$/.test(c.name))
    .map(c => ({ ...c, domain: 'pintia.cn', path: '/', expires: -1, secure: true, httpOnly: true, hostOnly: false }));
}

export interface PtaApi {
  get(path: string, query?: Record<string, unknown>, options?: { requireCookie?: boolean }): Promise<Raw>;
}

export class PtaClient implements PtaApi {
  readonly ctx: AppContext;
  readonly platform = 'pta';
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private envCookie(): string | undefined {
    return (process.env.PINTIA_COOKIE ?? '').trim() || undefined;
  }

  async status(): Promise<{ configured: boolean; source: 'environment' | 'session' | null; cookie_names?: string[]; saved_at?: string }> {
    const env = this.envCookie();
    if (env) return { configured: true, source: 'environment', cookie_names: cookiesFromHeader(env).map(c => c.name) };
    const stored = await this.ctx.sessions.read('pta');
    if (stored?.cookies.length) return { configured: true, source: 'session', cookie_names: stored.cookies.map(c => c.name), saved_at: stored.saved_at };
    return { configured: false, source: null };
  }

  /** Accepts a pasted cURL command, request header, DevTools table or raw cookie string. */
  async importCookie(input: string): Promise<{ source: string; cookie_names: string[] }> {
    const extracted = extractCookie(input);
    if (!extracted) throw new ToolError('INVALID_ARGUMENT', '没有从输入中识别出 Cookie。请复制 pintia.cn 任一 /api 请求的 cURL 或 Cookie 请求头。');
    const cookies = cookiesFromHeader(extracted.cookie);
    await this.ctx.sessions.write({ platform: 'pta', mode: 'direct', saved_at: new Date().toISOString(), cookies });
    return { source: extracted.source, cookie_names: cookies.map(c => c.name) };
  }

  private importRequired(): ToolError {
    return new ToolError('COOKIE_IMPORT_REQUIRED', '拼题A 登录需要短信验证，不做自动登录。请在浏览器登录 pintia.cn，复制任一 /api 请求的 cURL 或 Cookie，然后在本机终端运行导入命令。不要把 Cookie 发到对话里。', { setup_command: PTA_SETUP });
  }

  private async jar(required: boolean): Promise<CookieJar | null> {
    const env = this.envCookie();
    if (env) return new CookieJar(cookiesFromHeader(env));
    const stored = await this.ctx.sessions.read('pta');
    if (!stored?.cookies.length) {
      if (!required) return null;
      throw this.importRequired();
    }
    return CookieJar.from(stored.cookies);
  }

  /** Public problem sets can be read anonymously; personal data requires the imported cookie. */
  async get(path: string, query: Record<string, unknown> = {}, { requireCookie = false }: { requireCookie?: boolean } = {}): Promise<Raw> {
    const url = new URL(path.startsWith('http') ? path : `${PTA_BASE}${path}`);
    if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname) || !url.pathname.startsWith('/api/') || url.pathname.includes('..')) {
      throw new ToolError('INVALID_PATH', '只允许拼题A 接口路径。');
    }
    const jar = await this.jar(requireCookie);
    const http = new HttpClient({ jar: jar ?? new CookieJar(), limiter: this.ctx.limiter, limiterKey: 'pta', timeoutMs: this.ctx.cfg.timeoutMs, fetchImpl: this.ctx.fetchImpl });
    let response;
    try {
      response = await http.request(url, { query, headers: { Accept: 'application/json;charset=UTF-8', Referer: `${PTA_BASE}/` }, maxBytes: 8 * 1024 * 1024 });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR') throw new ToolError('NETWORK_ERROR', '无法连接拼题A，请检查网络。', e.details);
      throw e;
    }
    const status = response.status;
    if ((status === 401 || (status >= 300 && status < 400)) && !jar) throw this.importRequired();
    if (status === 401 || (status >= 300 && status < 400)) throw new ToolError('COOKIE_EXPIRED', '拼题A Cookie 缺失或已失效，请在浏览器重新登录后再导入一次。', { setup_command: PTA_SETUP });
    if (status === 403 && !jar) throw this.importRequired();
    if (status === 403) throw new ToolError('FORBIDDEN', '拼题A 拒绝访问：该题集未开放、未开始，或当前账号没有权限。');
    if (status === 404 || status === 406) throw new ToolError('NOT_FOUND', '拼题A 没有这个题集或题目，或接口已变化。');
    if (status === 429) throw new ToolError('RATE_LIMITED', '拼题A 请求过于频繁，请稍后再试。');
    if (!response.ok) throw new ToolError('PLATFORM_ERROR', `拼题A 返回 HTTP ${status}。`, { http_status: status });
    let data: unknown;
    try {
      data = response.json();
    } catch {
      throw new ToolError('UNEXPECTED_RESPONSE', '拼题A 未返回 JSON，接口可能发生变化。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ToolError('SCHEMA_CHANGED', '拼题A 响应格式无法识别。');
    const raw = data as Raw;
    if (raw.error && typeof raw.error === 'object') {
      const code = String(raw.error.code ?? '');
      if (/UNAUTHORIZED|LOGIN|SESSION/i.test(code) && !jar) throw this.importRequired();
      if (/UNAUTHORIZED|LOGIN|SESSION/i.test(code)) throw new ToolError('COOKIE_EXPIRED', '拼题A 登录已失效，请重新导入 Cookie。', { setup_command: PTA_SETUP });
      throw new ToolError('PLATFORM_REJECTED', `拼题A 拒绝请求：${raw.error.message ?? code}`, { platform_code: code });
    }
    return raw;
  }

  async currentUser(): Promise<Raw> {
    const data = await this.get(`${PASSPORT}/api/u/current`, {}, { requireCookie: true });
    if (!data.user || typeof data.user !== 'object') throw new ToolError('COOKIE_EXPIRED', '拼题A 未返回当前用户，Cookie 可能已失效。', { setup_command: PTA_SETUP });
    return data.user;
  }

  async check(): Promise<{ authenticated: boolean; reason?: string; nickname?: string }> {
    try {
      const user = await this.currentUser();
      return { authenticated: true, nickname: user.nickname ?? undefined };
    } catch (e) {
      if (e instanceof ToolError && (e.code === 'COOKIE_EXPIRED' || e.code === 'COOKIE_IMPORT_REQUIRED')) return { authenticated: false, reason: e.code };
      throw e;
    }
  }
}
