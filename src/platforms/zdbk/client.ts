import { casLogin } from '../../auth/cas.ts';
import type { StoredCookie } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import type { HttpClient } from '../../core/http.ts';
import { SessionClient } from '../../core/session.ts';
import { sleep, type Raw } from '../../core/util.ts';

export const ZDBK_HOST = 'zdbk.zju.edu.cn';
export const ZDBK_BASE = `https://${ZDBK_HOST}/jwglxt`;
const SERVICE = `${ZDBK_BASE}/xtgl/login_ssologin.html`;
const ENTRY = `https://zjuam.zju.edu.cn/cas/login?service=${encodeURIComponent(SERVICE)}`;

export const ZDBK_PATHS = {
  grades: '/cxdy/xscjcx_cxXscjIndex.html',
  majorGrades: '/zycjtj/xszgkc_cxXsZgkcIndex.html',
  exams: '/xskscx/kscx_cxXsgrksIndex.html',
  timetable: '/kbcx/xskbcx_cxXsKb.html',
} as const;

const LOGIN_MARKERS = /cas\/login|login_ssologin|login_slogin|统一身份认证|未登录|请先登录|登录已失效|name=["']password["']/i;

export interface ZdbkApi {
  post(path: string, options?: { query?: Record<string, unknown>; form?: Record<string, string>; allowNull?: boolean }): Promise<Raw | null>;
}

export class ZdbkClient extends SessionClient implements ZdbkApi {
  readonly platform = 'zdbk';
  readonly probeHost = ZDBK_HOST;

  protected async login(http: HttpClient): Promise<void> {
    await casLogin(http, { entry: ENTRY, hosts: [ZDBK_HOST], upgradeHttpHosts: [ZDBK_HOST], credentials: () => this.ctx.accounts.load('zju') });
  }

  protected keepCookies(cookies: StoredCookie[]): StoredCookie[] {
    const selected = cookies.filter(c => c.domain === ZDBK_HOST);
    return selected.some(c => c.name === 'JSESSIONID') ? selected : [];
  }

  protected async preflight(): Promise<unknown> {
    return this.post(ZDBK_PATHS.grades, { query: { doType: 'query', 'queryModel.showCount': 1 } });
  }

  protected async verifyLogin(): Promise<void> {
    try {
      const data = await this.preflight();
      if (!data || !Array.isArray((data as Raw).items)) throw new Error('schema');
    } catch (e) {
      throw new ToolError('ZDBK_AUTH_UNVERIFIED', '统一认证流程结束，但教务系统接口尚未确认登录。', e instanceof ToolError ? { cause: e.code } : {});
    }
  }

  /** All ZDBK calls here are queries; a transient 9xx refusal is retried once after a short pause. */
  async post(path: string, options: { query?: Record<string, unknown>; form?: Record<string, string>; allowNull?: boolean } = {}): Promise<Raw | null> {
    try {
      return await this.postOnce(path, options);
    } catch (e) {
      if (!(e instanceof ToolError && e.code === 'PLATFORM_BUSY')) throw e;
      await sleep(this.retryDelayMs);
      return this.postOnce(path, options);
    }
  }

  retryDelayMs = 1500;

  private async postOnce(path: string, { query, form = {}, allowNull = false }: { query?: Record<string, unknown>; form?: Record<string, string>; allowNull?: boolean } = {}): Promise<Raw | null> {
    if (!path.startsWith('/') || path.includes('..')) throw new ToolError('INVALID_PATH', '只允许教务系统接口路径。');
    let response;
    try {
      response = await this.http().request(`${ZDBK_BASE}${path}`, {
        method: 'POST',
        query,
        form,
        headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest', Referer: `${ZDBK_BASE}/xtgl/index_initMenu.html`, Origin: `https://${ZDBK_HOST}` },
        maxBytes: 8 * 1024 * 1024,
      });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR') throw new ToolError('NETWORK_ERROR', '无法连接教务系统。校外访问可能需要 WebVPN（ZJU_NETWORK=auto 或 webvpn）。', e.details);
      throw e;
    }
    const status = response.status;
    if (status >= 300 && status < 400) throw new ToolError('LOGIN_REQUIRED', '教务系统会话已失效。');
    // 正方 returns non-standard 901/902 when the session has expired.
    if (status === 401 || status === 901 || status === 902) throw new ToolError('LOGIN_REQUIRED', '教务系统会话已失效。');
    if (status === 403) throw new ToolError('FORBIDDEN', '教务系统拒绝访问该功能。');
    if (status >= 900) throw new ToolError('PLATFORM_BUSY', `教务系统暂时拒绝请求（HTTP ${status}），通常是短时间内重复查询所致。请稍后再试，不要连续重复调用。`, { http_status: status, endpoint: path });
    if (status === 429) throw new ToolError('RATE_LIMITED', '教务系统请求过于频繁，请稍后再试。');
    if (!response.ok) throw new ToolError('PLATFORM_ERROR', `教务系统返回 HTTP ${status}。`, { http_status: status, endpoint: path });
    const body = response.text().trim();
    if (body.includes('captcha_error')) throw new ToolError('AUTH_CHALLENGE_REQUIRED', '教务系统要求输入验证码。请先在浏览器打开教务系统完成一次验证码后再试；不会自动识别或重试。');
    if (allowNull && (body === 'null' || body === '')) return null;
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        const data = JSON.parse(body);
        if (data && typeof data === 'object' && !Array.isArray(data)) return data as Raw;
      } catch {}
      throw new ToolError('SCHEMA_CHANGED', '教务系统返回的 JSON 无法解析。');
    }
    if (LOGIN_MARKERS.test(body)) throw new ToolError('LOGIN_REQUIRED', '教务系统返回了登录页，会话已失效。');
    throw new ToolError('UNEXPECTED_RESPONSE', '教务系统未返回 JSON，接口可能发生变化。');
  }
}
