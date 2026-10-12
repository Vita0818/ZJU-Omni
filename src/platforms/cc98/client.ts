// OIDC password grant and REST paths follow EviterLesRoses2/cc98-mcp (MIT,
// itself crediting Lucent-Snow/CC98-CLI) and the CC98 desktop client.
import type { AppContext } from '../../core/context.ts';
import { CookieJar } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import type { HttpClient, HttpResponse } from '../../core/http.ts';
import type { StoredSession, TransportMode } from '../../core/store.ts';
import { hash } from '../../core/util.ts';

export const CC98_API = 'https://api.cc98.org';
const TOKEN_URL = 'https://openid.cc98.org/connect/token';
// Public client used by third-party CC98 clients (CC98-CLI, CC98-Desktop, cc98-mcp).
const CLIENT_ID = '9a1fd200-8687-44b1-4c20-08d50a96e5cd';
const CLIENT_SECRET = '8b53f727-08e2-4509-8857-e34bf92b27f2';
const SCOPE = 'cc98-api openid offline_access';

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

export interface Cc98Api {
  request<T = unknown>(method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown; anonymous?: boolean }): Promise<T>;
}

export class Cc98Client implements Cc98Api {
  readonly ctx: AppContext;
  readonly platform = 'cc98';
  private mode: TransportMode | null = null;
  private loggingIn: Promise<Tokens> | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private async transportMode(): Promise<TransportMode> {
    if (!this.mode) this.mode = await this.ctx.network.chooseMode('api.cc98.org');
    return this.mode;
  }

  private async http(): Promise<HttpClient> {
    const mode = await this.transportMode();
    const jar = mode === 'webvpn' ? await this.ctx.network.webvpnJar() : new CookieJar();
    return this.ctx.network.client(mode, jar, 'cc98');
  }

  private async send(method: string, url: string, options: { query?: Record<string, unknown>; body?: unknown; form?: Record<string, string>; token?: string } = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', Referer: 'https://www.cc98.org/' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const run = async () => (await this.http()).request(url, { method, query: options.query, json: options.body, form: options.form, headers, maxBytes: 8 * 1024 * 1024 });
    try {
      return await run();
    } catch (e) {
      if (e instanceof ToolError && e.code === 'WEBVPN_LOGIN_REQUIRED') {
        await this.ctx.network.loginWebvpn();
        if (method === 'GET' || url === TOKEN_URL) return run();
        throw new ToolError('WEBVPN_LOGIN_REQUIRED', 'WebVPN 会话已失效，已重新登录；写操作未发送，请重新执行。');
      }
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR') {
        throw new ToolError(method === 'GET' || e.details.before_send === true ? 'NETWORK_ERROR' : 'OUTCOME_UNKNOWN', method === 'GET' ? '无法连接 CC98。校外需要 WebVPN（ZJU_NETWORK=auto 或 webvpn）。' : '请求中断，CC98 是否已执行尚不确定。请先读回，勿重复发送。', e.details);
      }
      throw e;
    }
  }

  async sessionFingerprint(): Promise<string> {
    const stored = await this.ctx.sessions.read('cc98');
    return hash(`cc98:${(stored?.data?.username as string) ?? ''}:${stored?.saved_at ?? ''}`);
  }

  private async saveTokens(tokens: Tokens, username: string): Promise<void> {
    const session: StoredSession = { platform: 'cc98', mode: (await this.transportMode()) ?? 'direct', saved_at: new Date().toISOString(), cookies: [], data: { ...tokens, username } };
    const previous = await this.ctx.sessions.read('cc98');
    if (previous?.data?.username === username) session.saved_at = previous.saved_at;
    await this.ctx.sessions.write(session);
  }

  private async tokenRequest(form: Record<string, string>): Promise<Tokens | null> {
    const response = await this.send('POST', TOKEN_URL, { form: { ...form, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: SCOPE } });
    let data: Record<string, unknown> = {};
    try {
      data = response.json();
    } catch {}
    if (typeof data.access_token !== 'string') {
      if (form.grant_type === 'password') {
        const reason = String(data.error ?? '');
        throw new ToolError(reason === 'invalid_grant' ? 'AUTHENTICATION_REQUIRED' : 'CC98_LOGIN_FAILED', reason === 'invalid_grant' ? 'CC98 未接受用户名或密码。请检查 npm run configure -- cc98 的配置；不会自动重试。' : `CC98 登录失败（HTTP ${response.status}）。`, { http_status: response.status });
      }
      return null;
    }
    const expires = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    return { access_token: data.access_token, refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined, expires_at: Date.now() + expires * 1000 - 60000 };
  }

  async login({ explicit = false }: { explicit?: boolean } = {}): Promise<Tokens> {
    if (!explicit) this.ctx.network.assertNoRecentFailure('cc98');
    if (!this.loggingIn) {
      this.loggingIn = (async () => {
        const account = await this.ctx.accounts.load('cc98');
        let tokens: Tokens | null;
        try {
          tokens = await this.tokenRequest({ grant_type: 'password', username: account.username, password: account.password });
        } catch (e) {
          this.ctx.network.rememberFailure('cc98', e);
          throw e;
        }
        this.ctx.network.clearFailure('cc98');
        await this.saveTokens(tokens!, account.username);
        return tokens!;
      })().finally(() => {
        this.loggingIn = null;
      });
    }
    return this.loggingIn;
  }

  async token(force = false): Promise<string> {
    const stored = await this.ctx.sessions.read('cc98');
    const data = stored?.data as (Tokens & { username?: string }) | undefined;
    if (!force && data?.access_token && Date.now() < Number(data.expires_at)) return data.access_token;
    if (data?.refresh_token) {
      const refreshed = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: data.refresh_token });
      if (refreshed) {
        await this.saveTokens({ ...refreshed, refresh_token: refreshed.refresh_token ?? data.refresh_token }, data.username ?? '');
        return refreshed.access_token;
      }
    }
    if (!(await this.ctx.accounts.status('cc98')).configured) await this.ctx.accounts.load('cc98');
    return (await this.login()).access_token;
  }

  private parse<T>(response: HttpResponse, path: string, write: boolean): T {
    const status = response.status;
    if (status === 401) throw new ToolError('LOGIN_REQUIRED', 'CC98 登录已失效。');
    if (status === 403) throw new ToolError('FORBIDDEN', 'CC98 拒绝访问：可能没有该版面权限，或账号受限。');
    if (status === 404) throw new ToolError('NOT_FOUND', 'CC98 上没有这个帖子、版面或用户。');
    if (status === 429) throw new ToolError('RATE_LIMITED', 'CC98 请求过于频繁，请稍后再试。');
    if (status >= 300 && status < 400) throw new ToolError(write ? 'OUTCOME_UNKNOWN' : 'UNEXPECTED_RESPONSE', 'CC98 返回了跳转。');
    const text = response.text();
    if (!response.ok) {
      const reason = text.slice(0, 120).replace(/\s+/g, ' ');
      throw new ToolError(write && status >= 500 ? 'OUTCOME_UNKNOWN' : 'PLATFORM_REJECTED', `CC98 返回 HTTP ${status}${reason ? `：${reason}` : ''}`, { http_status: status, endpoint: path });
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async request<T = unknown>(method: string, path: string, { query, body, anonymous = false }: { query?: Record<string, unknown>; body?: unknown; anonymous?: boolean } = {}): Promise<T> {
    if (!path.startsWith('/') || path.includes('..')) throw new ToolError('INVALID_PATH', '只允许 CC98 接口路径。');
    const url = `${CC98_API}${path}`;
    const write = method !== 'GET';
    if (anonymous) return this.parse<T>(await this.send(method, url, { query, body }), path, write);
    let token = await this.token();
    let response = await this.send(method, url, { query, body, token });
    if (response.status === 401 && !write) {
      token = await this.token(true);
      response = await this.send(method, url, { query, body, token });
    }
    return this.parse<T>(response, path, write);
  }

  async me(): Promise<Record<string, any>> {
    return this.request('GET', '/me');
  }

  async check(): Promise<{ authenticated: boolean; reason?: string; name?: string; mode?: TransportMode }> {
    const stored = await this.ctx.sessions.read('cc98');
    if (!stored?.data?.access_token) return { authenticated: false, reason: 'LOGIN_REQUIRED' };
    try {
      const me = await this.me();
      return { authenticated: true, name: me?.name, mode: await this.transportMode() };
    } catch (e) {
      if (e instanceof ToolError && ['LOGIN_REQUIRED', 'AUTHENTICATION_REQUIRED', 'CONFIGURATION_REQUIRED'].includes(e.code)) return { authenticated: false, reason: e.code };
      throw e;
    }
  }
}
