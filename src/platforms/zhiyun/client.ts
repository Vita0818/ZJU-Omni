// Endpoint usage adapted from 8eoyw/zju-learning-cli (MIT).
import { casLogin } from '../../auth/cas.ts';
import type { StoredCookie } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import type { HttpClient } from '../../core/http.ts';
import { SessionClient, type ActiveSession } from '../../core/session.ts';
import type { Raw } from '../../core/util.ts';

export const CLASSROOM = 'https://classroom.zju.edu.cn';
export const YJAPI = 'https://yjapi.cmc.zju.edu.cn';
const TGMEDIA_HOST = 'tgmedia.cmc.zju.edu.cn';
const ENTRY = `https://${TGMEDIA_HOST}/index.php?r=auth/login&auType=cmc&tenant_code=112&forward=${encodeURIComponent(`${CLASSROOM}/`)}`;
export const ZHIYUN_HOSTS = ['classroom.zju.edu.cn', TGMEDIA_HOST, 'yjapi.cmc.zju.edu.cn', 'cmc.zju.edu.cn', 'www.cmc.zju.edu.cn'];
const API_HOSTS = new Set(['classroom.zju.edu.cn', 'yjapi.cmc.zju.edu.cn']);

// The classroom token lives in a PHP-serialized cookie, often on the parent .zju.edu.cn domain.
export function tokenFromCookies(cookies: StoredCookie[]): string | null {
  for (const cookie of cookies) {
    let value = cookie.value;
    try {
      value = decodeURIComponent(value);
    } catch {}
    const m = value.match(/"_token";i:\d+;s:\d+:"([^"]+)"/) ?? value.match(/"_token";s:\d+:"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

const isZhiyunHost = (domain: string) => domain === 'classroom.zju.edu.cn' || domain === 'cmc.zju.edu.cn' || domain.endsWith('.cmc.zju.edu.cn');

export interface ZhiyunApi {
  get(url: string, query?: Record<string, unknown>): Promise<Raw>;
  profile(): Promise<{ id: string; account: string }>;
}

export class ZhiyunClient extends SessionClient implements ZhiyunApi {
  readonly platform = 'zhiyun';
  readonly probeHost = 'classroom.zju.edu.cn';
  private profiles = new WeakMap<ActiveSession, Promise<{ id: string; account: string }>>();

  protected async login(http: HttpClient): Promise<void> {
    await casLogin(http, { entry: ENTRY, hosts: ZHIYUN_HOSTS, upgradeHttpHosts: ZHIYUN_HOSTS, credentials: () => this.ctx.accounts.load('zju') });
  }

  protected keepCookies(cookies: StoredCookie[]): StoredCookie[] {
    const token = cookies.filter(c => tokenFromCookies([c]) != null);
    if (!token.length) return [];
    const own = cookies.filter(c => isZhiyunHost(c.domain) && !token.includes(c));
    return [...token, ...own];
  }

  protected async preflight(): Promise<unknown> {
    return this.profile();
  }

  protected async verifyLogin(): Promise<void> {
    try {
      await this.preflight();
    } catch (e) {
      throw new ToolError('ZHIYUN_AUTH_UNVERIFIED', '统一认证流程结束，但智云课堂接口尚未确认登录。', e instanceof ToolError ? { cause: e.code } : {});
    }
  }

  token(): string {
    const session = this.activeSession();
    const token = session ? tokenFromCookies(session.jar.list()) : null;
    if (!token) throw new ToolError('LOGIN_REQUIRED', '智云课堂会话缺少访问令牌，需要重新登录。');
    return token;
  }

  async get(url: string, query: Record<string, unknown> = {}): Promise<Raw> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !API_HOSTS.has(target.hostname)) throw new ToolError('INVALID_PATH', '只允许智云课堂接口地址。');
    let response;
    try {
      response = await this.http().request(target, { query, headers: { Accept: 'application/json, text/plain, */*', Authorization: `Bearer ${this.token()}`, Referer: `${CLASSROOM}/` }, maxBytes: 16 * 1024 * 1024 });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR') throw new ToolError('NETWORK_ERROR', '无法连接智云课堂，请检查网络。', e.details);
      throw e;
    }
    const status = response.status;
    if (status === 401 || (status >= 300 && status < 400)) throw new ToolError('LOGIN_REQUIRED', '智云课堂会话已失效。');
    if (status === 403) throw new ToolError('FORBIDDEN', '智云课堂拒绝访问，可能没有这门课的观看权限。');
    if (status === 429) throw new ToolError('RATE_LIMITED', '智云课堂请求过于频繁，请稍后再试。');
    if (!response.ok) throw new ToolError('PLATFORM_ERROR', `智云课堂返回 HTTP ${status}。`, { http_status: status, endpoint: target.pathname });
    let data: unknown;
    try {
      data = response.json();
    } catch {
      if (/cas\/login|统一身份认证/i.test(response.text())) throw new ToolError('LOGIN_REQUIRED', '智云课堂返回了登录页，会话已失效。');
      throw new ToolError('UNEXPECTED_RESPONSE', '智云课堂未返回 JSON，接口可能发生变化。');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ToolError('SCHEMA_CHANGED', '智云课堂响应格式无法识别。');
    const raw = data as Raw;
    const code = raw.code == null ? null : Number(raw.code);
    if (code === 401 || code === 403 || /token/i.test(String(raw.msg ?? '')) && /失效|过期|invalid|expired/i.test(String(raw.msg ?? ''))) {
      throw new ToolError('LOGIN_REQUIRED', '智云课堂令牌已失效。');
    }
    return raw;
  }

  async profile(): Promise<{ id: string; account: string }> {
    const session = this.activeSession();
    const load = async () => {
      const data = await this.get(`${CLASSROOM}/userapi/v1/infosimple`);
      const params = data.params;
      if (!params || params.id == null || !params.account) throw new ToolError('SCHEMA_CHANGED', '智云课堂用户信息缺少 id 或 account。');
      return { id: String(params.id), account: String(params.account) };
    };
    if (!session) return load();
    let pending = this.profiles.get(session);
    if (!pending) {
      pending = load();
      this.profiles.set(session, pending);
      pending.catch(() => this.profiles.delete(session));
    }
    return pending;
  }

  /** Slide images: upgraded to HTTPS for school hosts, fetched without cookies or tokens. */
  async image(url: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string }> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ToolError('SCHEMA_CHANGED', 'PPT 图片地址无效。');
    }
    if (target.protocol === 'http:' && target.hostname.endsWith('.zju.edu.cn')) target = new URL(`https:${target.href.slice(5)}`);
    if (target.protocol !== 'https:' || target.username || target.password) throw new ToolError('UNSAFE_URL', 'PPT 图片只通过 HTTPS 下载。', { hostname: target.hostname });
    const viaWebvpn = this.activeSession()?.mode === 'webvpn';
    const response = await this.http().request(target, { cookies: viaWebvpn, maxBytes, timeoutMs: 60000 });
    if (!response.ok) throw new ToolError('DOWNLOAD_FAILED', `PPT 图片返回 HTTP ${response.status}。`);
    if (!/^image\//i.test(response.contentType)) throw new ToolError('UNEXPECTED_RESPONSE', 'PPT 地址返回的不是图片。');
    return { bytes: response.body, contentType: response.contentType };
  }
}
