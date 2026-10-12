import type { Config } from './config.ts';
import { CookieJar } from './cookies.ts';
import { ToolError, isToolError } from './errors.ts';
import { HttpClient, directTransport, type FetchImpl, type Transport } from './http.ts';
import { Accounts, type SecurityRunner } from './keychain.ts';
import { RateLimiter } from './ratelimit.ts';
import { SessionStore, type TransportMode } from './store.ts';
import { CAS_HOST, IDENTITY_HOST } from '../auth/cas.ts';
import { loginWebvpn, webvpnTransport, WEBVPN_ORIGIN } from '../auth/webvpn.ts';

export interface AppContext {
  cfg: Config;
  accounts: Accounts;
  sessions: SessionStore;
  limiter: RateLimiter;
  network: NetworkManager;
  fetchImpl?: FetchImpl;
}

export interface ContextOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  securityRunner?: SecurityRunner;
}

export function createContext(cfg: Config, options: ContextOptions = {}): AppContext {
  const env = options.env ?? process.env;
  const legacy = env.ZJU_OMNI_LEGACY_DIR;
  const accounts = new Accounts(cfg.dataDir, { env, runner: options.securityRunner, legacyDir: legacy === undefined ? undefined : legacy || null });
  const sessions = new SessionStore(cfg.dataDir);
  const limiter = new RateLimiter(cfg.minIntervalMs);
  const ctx = { cfg, accounts, sessions, limiter, fetchImpl: options.fetchImpl } as AppContext;
  ctx.network = new NetworkManager(ctx);
  return ctx;
}

export const SSO_HOSTS = new Set([CAS_HOST, IDENTITY_HOST]);
const FAILURE_CODES = new Set(['AUTHENTICATION_REQUIRED', 'AUTH_CHALLENGE_REQUIRED', 'AUTH_BLOCKED', 'WEBVPN_CONFIRM_REQUIRED', 'AUTH_PASSWORD_ENCODING_UNSUPPORTED']);
const FAILURE_TTL_MS = 15 * 60000;

export class NetworkManager {
  private ctx: AppContext;
  private sso = new CookieJar();
  private reachable = new Map<string, boolean>();
  private webvpnLoggingIn: Promise<CookieJar> | null = null;
  private failures = new Map<string, { error: ToolError; at: number }>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  transport(mode: TransportMode): Transport {
    return mode === 'webvpn' ? webvpnTransport : directTransport;
  }

  client(mode: TransportMode, jar: CookieJar, limiterKey: string, defaultHeaders: Record<string, string> = {}): HttpClient {
    return new HttpClient({
      jar,
      transport: this.transport(mode),
      limiter: this.ctx.limiter,
      limiterKey,
      timeoutMs: this.ctx.cfg.timeoutMs,
      fetchImpl: this.ctx.fetchImpl,
      defaultHeaders,
    });
  }

  forgetReachability(): void {
    this.reachable.clear();
  }

  async probe(host: string): Promise<boolean> {
    const known = this.reachable.get(host);
    if (known !== undefined) return known;
    const http = new HttpClient({ fetchImpl: this.ctx.fetchImpl, timeoutMs: 6000 });
    let ok: boolean;
    try {
      await http.request(`https://${host}/`, { cookies: false, maxBytes: 2 * 1024 * 1024 });
      ok = true;
    } catch (e) {
      if (!isToolError(e, 'NETWORK_ERROR') && !isToolError(e, 'RESPONSE_TOO_LARGE')) throw e;
      ok = isToolError(e, 'RESPONSE_TOO_LARGE');
    }
    this.reachable.set(host, ok);
    return ok;
  }

  async chooseMode(host: string): Promise<TransportMode> {
    const mode = this.ctx.cfg.network;
    if (mode === 'direct' || mode === 'webvpn') return mode;
    return (await this.probe(host)) ? 'direct' : 'webvpn';
  }

  ssoJar(): CookieJar {
    return this.sso.clone();
  }

  rememberSso(jar: CookieJar): void {
    this.sso = jar.filter(c => SSO_HOSTS.has(c.domain) || c.domain === 'zju.edu.cn');
  }

  clearSso(): void {
    this.sso = new CookieJar();
  }

  async webvpnJar(): Promise<CookieJar> {
    const stored = await this.ctx.sessions.read('webvpn');
    if (stored?.cookies.length) return CookieJar.from(stored.cookies);
    return this.loginWebvpn();
  }

  async saveWebvpnJar(jar: CookieJar): Promise<void> {
    await this.ctx.sessions.write({ platform: 'webvpn', mode: 'direct', saved_at: new Date().toISOString(), cookies: jar.list().filter(c => c.domain === 'webvpn.zju.edu.cn' || c.domain === 'zju.edu.cn') });
  }

  /** Credential rejections are remembered so automatic logins never resubmit a bad password. */
  rememberFailure(key: string, error: unknown): void {
    if (error instanceof ToolError && FAILURE_CODES.has(error.code)) this.failures.set(key, { error, at: Date.now() });
  }

  clearFailure(key?: string): void {
    if (key) this.failures.delete(key);
    else this.failures.clear();
  }

  assertNoRecentFailure(key: string): void {
    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.at < FAILURE_TTL_MS) {
      throw new ToolError(failure.error.code, `${failure.error.message}（本进程 ${Math.round(FAILURE_TTL_MS / 60000)} 分钟内不再自动重试；修正配置后用 zju_auth_login 显式登录。）`, failure.error.details);
    }
  }

  async loginWebvpn({ explicit = false }: { explicit?: boolean } = {}): Promise<CookieJar> {
    if (!explicit) this.assertNoRecentFailure('webvpn');
    if (!this.webvpnLoggingIn) {
      this.webvpnLoggingIn = (async () => {
        // WebVPN uses the campus network account, a separate system from unified identity.
        const kind = 'webvpn';
        if (!(await this.ctx.accounts.status(kind)).configured) await this.ctx.accounts.load(kind);
        const jar = new CookieJar();
        const http = this.client('direct', jar, 'webvpn');
        try {
          await loginWebvpn(http, await this.ctx.accounts.load(kind));
        } catch (e) {
          this.rememberFailure('webvpn', e);
          throw e;
        }
        this.clearFailure('webvpn');
        if (!jar.matching(new URL(WEBVPN_ORIGIN)).length) throw new ToolError('WEBVPN_SESSION_MISSING', 'WebVPN 登录成功但未返回会话。');
        await this.saveWebvpnJar(jar);
        return jar;
      })().finally(() => {
        this.webvpnLoggingIn = null;
      });
    }
    return (await this.webvpnLoggingIn).clone();
  }
}
