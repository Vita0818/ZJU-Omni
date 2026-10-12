// Request shapes ported from zju-chaoxing (MIT; upstream © Wu Jiale, additions © Vita0818).
import type { AppContext } from '../../core/context.ts';
import { CookieJar, type StoredCookie } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import { HttpClient, type HttpResponse } from '../../core/http.ts';
import { RateLimiter } from '../../core/ratelimit.ts';
import { extractCookie } from '../pta/cookie.ts';

export const XXT_SETUP = 'pbpaste | npm run cli -- xxt-cookie';
const LOGIN_MARKERS = ['passport2.chaoxing.com/login', '用户登录'];
const REQUIRED = ['UID', '_uid', 'fid'];

export function xxtCookies(header: string): StoredCookie[] {
  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => ({ name: part.slice(0, part.indexOf('=')).trim(), value: part.slice(part.indexOf('=') + 1).trim() }))
    .filter(c => c.name && c.value && /^[\w-]+$/.test(c.name))
    .map(c => ({ ...c, domain: 'chaoxing.com', path: '/', expires: -1, secure: false, httpOnly: false, hostOnly: false }));
}

export interface XxtApi {
  get(url: string, query?: Record<string, unknown>): Promise<string>;
  post(url: string, form?: Record<string, string>): Promise<string>;
}

export class XxtClient implements XxtApi {
  readonly ctx: AppContext;
  readonly platform = 'xxt';
  private limiter: RateLimiter;
  constructor(ctx: AppContext) {
    this.ctx = ctx;
    // Chaoxing is sensitive to bursts: keep at least one second between requests.
    this.limiter = new RateLimiter(ctx.cfg.minIntervalMs === 0 ? 0 : Math.max(1000, ctx.cfg.minIntervalMs));
  }

  private envCookie(): string | undefined {
    return (process.env.CHAOXING_COOKIE ?? '').trim() || undefined;
  }

  async status(): Promise<{ configured: boolean; source: 'environment' | 'session' | null; cookie_names?: string[]; missing_required?: string[] }> {
    const env = this.envCookie();
    const cookies = env ? xxtCookies(env) : (await this.ctx.sessions.read('xxt'))?.cookies ?? [];
    if (!cookies.length) return { configured: false, source: null };
    const names = cookies.map(c => c.name);
    return { configured: true, source: env ? 'environment' : 'session', cookie_names: names, missing_required: REQUIRED.filter(n => !names.includes(n)) };
  }

  async importCookie(input: string): Promise<{ source: string; cookie_names: string[]; missing_required: string[] }> {
    const extracted = extractCookie(input);
    if (!extracted) throw new ToolError('INVALID_ARGUMENT', '没有从输入中识别出 Cookie。请复制任一 chaoxing.com 请求的 cURL 或 Cookie 请求头。');
    const cookies = xxtCookies(extracted.cookie);
    await this.ctx.sessions.write({ platform: 'xxt', mode: 'direct', saved_at: new Date().toISOString(), cookies });
    const names = cookies.map(c => c.name);
    return { source: extracted.source, cookie_names: names, missing_required: REQUIRED.filter(n => !names.includes(n)) };
  }

  private async jar(): Promise<CookieJar> {
    const env = this.envCookie();
    if (env) return new CookieJar(xxtCookies(env));
    const stored = await this.ctx.sessions.read('xxt');
    if (!stored?.cookies.length) {
      throw new ToolError('COOKIE_IMPORT_REQUIRED', '学习通登录常弹滑块验证码，不做自动登录。请在浏览器登录学习通，复制任一 chaoxing.com 请求的 cURL 或 Cookie，在本机终端运行导入命令。不要把 Cookie 发到对话里。', { setup_command: XXT_SETUP });
    }
    return CookieJar.from(stored.cookies);
  }

  private check(target: URL, response: HttpResponse): string {
    if (response.url.hostname === 'passport2.chaoxing.com') throw new ToolError('COOKIE_EXPIRED', '学习通登录已失效，请重新导入 Cookie。', { setup_command: XXT_SETUP });
    if (response.status >= 300 && response.status < 400) {
      if (response.location && /passport2\.chaoxing\.com/.test(response.location.hostname)) throw new ToolError('COOKIE_EXPIRED', '学习通登录已失效，请重新导入 Cookie。', { setup_command: XXT_SETUP });
      throw new ToolError('UNEXPECTED_RESPONSE', '学习通返回了意外的跳转。');
    }
    if (response.status === 403) throw new ToolError('FORBIDDEN', '学习通拒绝访问。');
    if (!response.ok) throw new ToolError('PLATFORM_ERROR', `学习通返回 HTTP ${response.status}。`, { http_status: response.status, endpoint: target.pathname });
    const body = response.text();
    if (LOGIN_MARKERS.some(marker => body.includes(marker)) && !/json/i.test(response.contentType)) throw new ToolError('COOKIE_EXPIRED', '学习通返回了登录页，请重新导入 Cookie。', { setup_command: XXT_SETUP });
    return body;
  }

  private async send(method: 'GET' | 'POST', url: string, query?: Record<string, unknown>, form?: Record<string, string>): Promise<string> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !(target.hostname === 'chaoxing.com' || target.hostname.endsWith('.chaoxing.com'))) throw new ToolError('INVALID_PATH', '只允许学习通（chaoxing.com）地址。');
    const http = new HttpClient({ jar: await this.jar(), limiter: this.limiter, limiterKey: 'xxt', timeoutMs: this.ctx.cfg.timeoutMs, fetchImpl: this.ctx.fetchImpl });
    try {
      // Some pages bounce through http:// and back (cookies are never sent over http).
      const allowUrl = (u: URL) => (u.hostname === 'chaoxing.com' || u.hostname.endsWith('.chaoxing.com')) && (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
      return this.check(target, await http.request(target, { method, query, form, headers: { Referer: 'https://mooc1.chaoxing.com/' }, maxBytes: 8 * 1024 * 1024, maxRedirects: 5, allowUrl }));
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR') throw new ToolError('NETWORK_ERROR', '无法连接学习通，请检查网络。', e.details);
      throw e;
    }
  }

  get(url: string, query?: Record<string, unknown>): Promise<string> {
    return this.send('GET', url, query);
  }

  post(url: string, form: Record<string, string> = {}): Promise<string> {
    return this.send('POST', url, undefined, form);
  }

  async checkLogin(): Promise<{ authenticated: boolean; reason?: string }> {
    try {
      await this.get('https://i.chaoxing.com/base');
      return { authenticated: true };
    } catch (e) {
      if (e instanceof ToolError && (e.code === 'COOKIE_EXPIRED' || e.code === 'COOKIE_IMPORT_REQUIRED')) return { authenticated: false, reason: e.code };
      throw e;
    }
  }
}
