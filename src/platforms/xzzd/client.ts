import { casLogin } from '../../auth/cas.ts';
import type { AppContext } from '../../core/context.ts';
import type { StoredCookie } from '../../core/cookies.ts';
import { ToolError } from '../../core/errors.ts';
import { isJson, type HttpClient } from '../../core/http.ts';
import { SessionClient, type ActiveSession, type SessionClientOptions } from '../../core/session.ts';
import { id, type Raw } from '../../core/util.ts';

export const XZZD_BASE_URL = 'https://courses.zju.edu.cn';
export const XZZD_HOST = 'courses.zju.edu.cn';

export interface XzzdConfig {
  baseUrl: string;
  dataDir: string;
  maxFileBytes: number;
  storageHosts: string[];
}

export function xzzdConfig(ctx: AppContext): XzzdConfig {
  return { baseUrl: XZZD_BASE_URL, dataDir: ctx.cfg.dataDir, maxFileBytes: ctx.cfg.maxFileBytes, storageHosts: ctx.cfg.storageHosts };
}

// A deployment may scope its session to a parent domain. Preserve only the
// course session and CSRF cookies from such a domain, never CAS credentials.
export function courseCookies(cookies: StoredCookie[], baseUrl = XZZD_BASE_URL): StoredCookie[] {
  const hostname = new URL(baseUrl).hostname;
  return cookies
    .filter(c => {
      const domain = c.domain.replace(/^\./, '');
      const applicable = hostname === domain || hostname.endsWith('.' + domain);
      return applicable && (domain === hostname || /^(session|csrftoken|csrf_token|xsrf-token)$/i.test(c.name));
    })
    .map(c => ({ ...c, domain: hostname, hostOnly: true }));
}

export interface JsonOptions {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  readOnly?: boolean;
}

export class XzzdClient extends SessionClient {
  readonly platform = 'xzzd';
  readonly probeHost = XZZD_HOST;
  readonly cfg: XzzdConfig;
  private userIds = new WeakMap<ActiveSession, Promise<string>>();

  constructor(ctx: AppContext, options: SessionClientOptions = {}) {
    super(ctx, options);
    this.cfg = xzzdConfig(ctx);
  }

  protected async login(http: HttpClient): Promise<void> {
    await casLogin(http, { entry: `${this.cfg.baseUrl}/user/index`, hosts: [XZZD_HOST], credentials: () => this.ctx.accounts.load('zju') });
  }

  protected keepCookies(cookies: StoredCookie[]): StoredCookie[] {
    const selected = courseCookies(cookies, this.cfg.baseUrl);
    return selected.some(c => c.name === 'session') ? selected : [];
  }

  protected async preflight(): Promise<unknown> {
    return this.listCourses({ page: 1, page_size: 1 });
  }

  protected async verifyLogin(): Promise<void> {
    try {
      const data = await this.listCourses({ page: 1, page_size: 1 });
      if (!Array.isArray(data.courses)) throw new Error('schema');
    } catch (e) {
      throw new ToolError('COURSE_AUTH_UNVERIFIED', '统一认证流程结束，但课程接口尚未确认登录。', e instanceof ToolError ? { cause: e.code } : {});
    }
  }

  async sessionFingerprint(): Promise<string> {
    return this.fingerprint();
  }

  private apiHeaders(): Record<string, string> {
    return { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: this.cfg.baseUrl, Referer: `${this.cfg.baseUrl}/user/index` };
  }

  url(path: string, query: Record<string, unknown> = {}): string {
    if (!path.startsWith('/api/') || path.includes('..') || path.includes('\\')) throw new ToolError('INVALID_PATH', '只允许平台 API 路径。');
    const url = new URL(path, this.cfg.baseUrl);
    for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
    if (url.origin !== this.cfg.baseUrl) throw new ToolError('INVALID_PATH', 'API 请求必须保持在课程站点。');
    return url.toString();
  }

  async json(path: string, { method = 'GET', query, body, readOnly = method === 'GET' }: JsonOptions = {}): Promise<Raw> {
    const target = this.url(path, query);
    let response;
    try {
      response = await this.http().request(target, { method, json: body, headers: this.apiHeaders(), maxBytes: 5 * 1024 * 1024 });
    } catch (e) {
      if (e instanceof ToolError) {
        if (e.code === 'WEBVPN_LOGIN_REQUIRED') throw e;
        if (e.code === 'RESPONSE_TOO_LARGE') throw new ToolError(readOnly ? 'RESPONSE_TOO_LARGE' : 'OUTCOME_UNKNOWN', '平台响应过大，请缩小查询范围。');
        if (e.code === 'NETWORK_ERROR') {
          if (readOnly) throw new ToolError('NETWORK_ERROR', '无法连接课程站点，请检查当前网络是否能访问学在浙大。', e.details);
          if (e.details.before_send === true) throw new ToolError('NETWORK_ERROR', '无法连接课程站点，请求未发出。', e.details);
          throw new ToolError('OUTCOME_UNKNOWN', '请求中断，平台是否已执行尚不确定。先查询提交记录，勿自动重试。');
        }
        throw e;
      }
      throw new ToolError(readOnly ? 'NETWORK_ERROR' : 'OUTCOME_UNKNOWN', readOnly ? '无法连接课程站点。' : '请求中断，平台是否已执行尚不确定。先查询提交记录，勿自动重试。');
    }
    const status = response.status;
    if (status === 401 || (status >= 300 && status < 400)) throw new ToolError('LOGIN_REQUIRED', '课程会话已失效或需要重新登录。');
    if (status === 403) throw new ToolError('FORBIDDEN', '平台拒绝访问。请检查登录状态和此课程的访问权限。');
    if (status === 429) throw new ToolError('RATE_LIMITED', '平台请求过于频繁，请稍后再试。');
    if (!response.ok) throw new ToolError(!readOnly && status >= 500 ? 'OUTCOME_UNKNOWN' : 'PLATFORM_ERROR', `平台返回 HTTP ${status}。`, { http_status: status, endpoint: path });
    if (status === 204) return {};
    if (!isJson(response)) throw new ToolError(readOnly ? 'UNEXPECTED_RESPONSE' : 'OUTCOME_UNKNOWN', '平台未返回 JSON，可能是登录页或接口发生变化。');
    let data: unknown;
    try {
      data = response.json();
    } catch {
      throw new ToolError(readOnly ? 'SCHEMA_CHANGED' : 'OUTCOME_UNKNOWN', '平台返回的 JSON 无法解析。');
    }
    if (!data || typeof data !== 'object') throw new ToolError(readOnly ? 'SCHEMA_CHANGED' : 'OUTCOME_UNKNOWN', '平台响应格式无法识别。');
    const raw = data as Raw;
    if (raw.success === false || raw.ok === false || raw.error) throw new ToolError('PLATFORM_REJECTED', '平台返回了操作失败状态，请在网页中检查详情。');
    return raw;
  }

  async listCourses(query: { keyword?: string; semester_id?: unknown; page?: number; page_size?: number } = {}): Promise<Raw> {
    const { keyword = '', semester_id, page = 1, page_size = 30 } = query;
    const conditions: Raw = { keyword };
    if (semester_id) conditions.semester_id = Number(semester_id);
    const fields = 'id,name,course_code,status,academic_year(id,name),semester(id,name),instructors(id,name),course_attributes(teaching_class_name)';
    return this.json('/api/my-courses', { method: 'POST', readOnly: true, body: { page, page_size, conditions, fields } });
  }

  async currentUserId(): Promise<string> {
    const session = this.activeSession();
    if (!session) return this.fetchUserId();
    let pending = this.userIds.get(session);
    if (!pending) {
      pending = this.fetchUserId();
      this.userIds.set(session, pending);
      pending.catch(() => this.userIds.delete(session));
    }
    return pending;
  }

  private async fetchUserId(): Promise<string> {
    let response;
    try {
      response = await this.http().request(`${this.cfg.baseUrl}/user/index`, { headers: { Accept: 'text/html' } });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'WEBVPN_LOGIN_REQUIRED') throw e;
      throw new ToolError('NETWORK_ERROR', '无法读取当前账号身份，请检查网络。');
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) throw new ToolError('LOGIN_REQUIRED', '课程会话已失效。');
    if (!response.ok) throw new ToolError('IDENTITY_UNAVAILABLE', '无法读取当前账号身份。');
    return identityFromPage(response.text());
  }

  storageUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw, this.cfg.baseUrl);
    } catch {
      throw new ToolError('STORAGE_URL_INVALID', '平台返回了无效文件地址。');
    }
    const ownHost = new URL(this.cfg.baseUrl).hostname;
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === ownHost || url.hostname.endsWith('.zju.edu.cn') || this.cfg.storageHosts.includes(url.hostname))) {
      throw new ToolError('STORAGE_HOST_UNVERIFIED', '文件存储站点尚未配置。请核对平台使用的存储域名，再设置 ZJU_XZZD_STORAGE_HOSTS。', { hostname: url.hostname });
    }
    return url.toString();
  }

  async uploadBytes(url: string, buffer: Buffer, name: string): Promise<void> {
    const target = this.storageUrl(url);
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array(buffer)]), name);
    let response;
    try {
      response = await this.http().request(target, { method: 'PUT', body: data, timeoutMs: 120000 });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'NETWORK_ERROR' && e.details.before_send === true) {
        throw new ToolError('UPLOAD_FAILED', '无法连接文件存储站点。作业尚未提交。');
      }
      throw new ToolError('UPLOAD_OUTCOME_UNKNOWN', '文件上传中断。作业提交请求尚未发送，请先检查平台状态。');
    }
    if (!response.ok) throw new ToolError('UPLOAD_FAILED', `文件上传返回 HTTP ${response.status}。作业尚未提交。`);
  }

  async downloadBytes(uploadId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const max = this.cfg.maxFileBytes;
    const tooLarge = () => new ToolError('FILE_TOO_LARGE', '当前单文件上限为 100 MiB。');
    try {
      const response = await this.http().request(this.url(`/api/uploads/${id(uploadId)}/blob`), { maxBytes: max, timeoutMs: 120000 });
      if (response.status === 401 || response.status === 403) throw new ToolError('FORBIDDEN', '文件不可访问，请核对登录和课程权限。');
      if (response.status >= 300 && response.status < 400) {
        const location = response.location;
        if (!location || /\/cas\/|\/login(?:[/?]|$)/.test(location.pathname)) throw new ToolError('LOGIN_REQUIRED', '下载需要重新登录。');
        const storage = this.storageUrl(location.toString());
        // Storage redirects never receive the course cookie (jar is host-scoped
        // to the course site) and further redirects are refused.
        const external = await this.http().request(storage, { maxBytes: max, timeoutMs: 120000 });
        if (external.status >= 300 && external.status < 400) throw new ToolError('DOWNLOAD_FAILED', '文件存储站点再次跳转，已停止。');
        if (!external.ok) throw new ToolError('DOWNLOAD_FAILED', `文件存储站点返回 HTTP ${external.status}。`);
        return { bytes: external.body, contentType: external.contentType };
      }
      if (!response.ok) throw new ToolError('DOWNLOAD_FAILED', `文件下载返回 HTTP ${response.status}。`);
      return { bytes: response.body, contentType: response.contentType };
    } catch (e) {
      if (e instanceof ToolError) {
        if (e.code === 'RESPONSE_TOO_LARGE') throw tooLarge();
        if (e.code === 'NETWORK_ERROR') throw new ToolError('DOWNLOAD_FAILED', '下载未完成，请检查网络和文件访问权限。');
        throw e;
      }
      throw new ToolError('DOWNLOAD_FAILED', '下载未完成，请检查网络和文件访问权限。');
    }
  }
}

// Read only the server-rendered identity object, never execute page JavaScript.
export function identityFromPage(html: string): string {
  const identities: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|\btype\s*=\s*["'](?:text\/ng-template|application\/json)/i.test(match[1])) continue;
    const user = match[2].match(/^\s*(?:(?:var|let|const)\s+globalData|window\.globalData)\s*=\s*\{\s*user\s*:\s*\{\s*id\s*:\s*["']?([1-9]\d*)["']?\s*[,}]/);
    if (user) identities.push(id(user[1]));
  }
  if (identities.length !== 1) throw new ToolError('IDENTITY_UNAVAILABLE', '平台未返回唯一的当前账号身份，请重新登录或检查页面结构。');
  return identities[0];
}
