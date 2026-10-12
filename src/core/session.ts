import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppContext } from './context.ts';
import { CookieJar, type StoredCookie } from './cookies.ts';
import { ToolError, isToolError } from './errors.ts';
import type { HttpClient } from './http.ts';
import type { AccountKind } from './keychain.ts';
import { SessionStore, type StoredSession, type TransportMode } from './store.ts';
import { hash } from './util.ts';

export interface ActiveSession {
  stored: StoredSession;
  mode: TransportMode;
  jar: CookieJar;
}

export interface SessionClientOptions {
  authenticate?: () => Promise<StoredSession | ActiveSession>;
}

const RELOGIN_CODES = new Set(['LOGIN_REQUIRED', 'WEBVPN_LOGIN_REQUIRED']);

/**
 * Shared session lifecycle for platforms that authenticate through the ZJU
 * unified identity service (directly or through WebVPN).
 *
 * - One logical tool call keeps one session snapshot (AsyncLocalStorage).
 * - Reads that hit an expired session re-authenticate once and retry.
 * - Writes verify the session with a read preflight first; once the write
 *   starts it is never replayed.
 */
export abstract class SessionClient {
  readonly ctx: AppContext;
  abstract readonly platform: string;
  abstract readonly probeHost: string;
  protected accountKind: AccountKind = 'zju';
  private storage = new AsyncLocalStorage<ActiveSession>();
  private refreshing: Promise<ActiveSession> | null = null;
  private authenticateOverride?: () => Promise<StoredSession | ActiveSession>;

  constructor(ctx: AppContext, options: SessionClientOptions = {}) {
    this.ctx = ctx;
    this.authenticateOverride = options.authenticate;
  }

  /** Performs the platform login into `http.jar`. */
  protected abstract login(http: HttpClient): Promise<void>;
  /** Selects the cookies worth persisting for direct mode. */
  protected abstract keepCookies(cookies: StoredCookie[]): StoredCookie[];
  /** Cheap authenticated read used as write preflight. */
  protected abstract preflight(): Promise<unknown>;
  /** Verifies that the freshly logged-in jar works. Default: preflight. */
  protected async verifyLogin(): Promise<void> {
    await this.preflight();
  }

  loginRequired(): ToolError {
    return new ToolError('LOGIN_REQUIRED', `尚未登录 ${this.platform}。配置统一认证账号（npm run configure -- ${this.accountKind}）后，工具会自动登录；也可调用 zju_auth_login。`);
  }

  async readStored(): Promise<StoredSession> {
    const stored = await this.ctx.sessions.read(this.platform);
    if (!stored) throw this.loginRequired();
    if (stored.mode === 'direct' && !stored.cookies.length) throw this.loginRequired();
    return stored;
  }

  async activate(stored: StoredSession): Promise<ActiveSession> {
    if (stored.mode === 'webvpn') {
      const webvpn = await this.ctx.sessions.read('webvpn');
      if (!webvpn?.cookies.length) throw new ToolError('WEBVPN_LOGIN_REQUIRED', 'WebVPN 会话缺失，需要重新登录。');
      return { stored, mode: 'webvpn', jar: CookieJar.from(webvpn.cookies) };
    }
    return { stored, mode: 'direct', jar: CookieJar.from(stored.cookies) };
  }

  async loadSession(): Promise<ActiveSession> {
    return this.activate(await this.readStored());
  }

  async fingerprint(): Promise<string> {
    const stored = await this.readStored();
    if (stored.mode === 'webvpn') {
      const webvpn = await this.ctx.sessions.read('webvpn');
      return hash(`webvpn:${stored.saved_at}:${SessionStore.fingerprint({ mode: 'webvpn', cookies: webvpn?.cookies ?? [] })}`);
    }
    return SessionStore.fingerprint(stored);
  }

  async canRefresh(): Promise<boolean> {
    return (await this.ctx.accounts.status(this.accountKind)).configured;
  }

  protected activeSession(): ActiveSession | undefined {
    return this.storage.getStore();
  }

  http(): HttpClient {
    const active = this.storage.getStore();
    if (!active) throw new ToolError('INTERNAL_ERROR', '平台请求必须在会话内执行。');
    return this.ctx.network.client(active.mode, active.jar, this.platform);
  }

  async runWith<T>(session: ActiveSession, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(session, fn);
  }

  async refreshSession({ explicit = false }: { explicit?: boolean } = {}): Promise<ActiveSession> {
    if (!this.refreshing) {
      this.refreshing = this.authenticate(explicit).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async authenticate(explicit = false): Promise<ActiveSession> {
    if (this.authenticateOverride) {
      const result = await this.authenticateOverride();
      return 'jar' in result ? result : this.activate(result);
    }
    const failureKey = `cas:${this.accountKind}`;
    if (!explicit) this.ctx.network.assertNoRecentFailure(failureKey);
    if (!(await this.ctx.accounts.status(this.accountKind)).configured) await this.ctx.accounts.load(this.accountKind);
    this.ctx.network.forgetReachability();
    try {
      const mode = await this.ctx.network.chooseMode(this.probeHost);
      const session = mode === 'webvpn' ? await this.authenticateWebvpn(explicit) : await this.authenticateDirect();
      this.ctx.network.clearFailure(failureKey);
      return session;
    } catch (e) {
      if (!(e instanceof ToolError && e.details.platform_error !== undefined)) this.ctx.network.rememberFailure(failureKey, e);
      throw e;
    }
  }

  private async authenticateDirect(): Promise<ActiveSession> {
    const jar = this.ctx.network.ssoJar();
    const http = this.ctx.network.client('direct', jar, this.platform);
    await this.login(http);
    this.ctx.network.rememberSso(jar);
    const stored: StoredSession = { platform: this.platform, mode: 'direct', saved_at: new Date().toISOString(), cookies: this.keepCookies(jar.list()) };
    if (!stored.cookies.length) throw new ToolError('SESSION_MISSING', `${this.platform} 认证完成但未返回平台会话。`);
    const active: ActiveSession = { stored, mode: 'direct', jar: CookieJar.from(stored.cookies) };
    await this.runWith(active, () => this.verifyLogin());
    await this.ctx.sessions.write(stored);
    return active;
  }

  private async authenticateWebvpn(explicit: boolean): Promise<ActiveSession> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const jar = attempt === 0 ? await this.ctx.network.webvpnJar() : await this.ctx.network.loginWebvpn({ explicit });
      const http = this.ctx.network.client('webvpn', jar, this.platform);
      try {
        await this.login(http);
        const stored: StoredSession = { platform: this.platform, mode: 'webvpn', saved_at: new Date().toISOString(), cookies: [] };
        const active: ActiveSession = { stored, mode: 'webvpn', jar };
        await this.runWith(active, () => this.verifyLogin());
        await this.ctx.network.saveWebvpnJar(jar);
        await this.ctx.sessions.write(stored);
        return active;
      } catch (e) {
        if (attempt === 0 && isToolError(e, 'WEBVPN_LOGIN_REQUIRED')) continue;
        throw e;
      }
    }
    throw new ToolError('WEBVPN_LOGIN_REQUIRED', 'WebVPN 会话无法建立。');
  }

  private shouldRelogin(error: unknown, session: ActiveSession): boolean {
    if (!(error instanceof ToolError)) return false;
    if (RELOGIN_CODES.has(error.code)) return true;
    return error.code === 'NETWORK_ERROR' && error.details.before_send === true && session.mode === 'direct' && this.ctx.cfg.network === 'auto' && !this.authenticateOverride;
  }

  async withSession<T>(fn: () => Promise<T>, { readOnly = true }: { readOnly?: boolean } = {}): Promise<T> {
    let session: ActiveSession;
    let refreshed = false;
    try {
      session = await this.loadSession();
    } catch (e) {
      if (!(e instanceof ToolError) || !RELOGIN_CODES.has(e.code) || !(await this.canRefresh())) throw e;
      session = await this.refreshSession();
      refreshed = true;
    }
    if (!readOnly) {
      try {
        await this.runWith(session, () => this.preflight());
      } catch (e) {
        if (!this.shouldRelogin(e, session) || refreshed || !(await this.canRefresh())) throw e;
        session = await this.refreshSession();
        refreshed = true;
      }
    }
    try {
      return await this.runWith(session, fn);
    } catch (e) {
      if (!readOnly || refreshed || !this.shouldRelogin(e, session) || !(await this.canRefresh())) throw e;
      session = await this.refreshSession();
      return this.runWith(session, fn);
    }
  }

  /** Live check without auto-login. */
  async check(): Promise<{ authenticated: boolean; reason?: string; mode?: TransportMode; saved_at?: string }> {
    let session: ActiveSession;
    try {
      session = await this.loadSession();
    } catch (e) {
      if (e instanceof ToolError && RELOGIN_CODES.has(e.code)) return { authenticated: false, reason: 'LOGIN_REQUIRED' };
      throw e;
    }
    try {
      await this.runWith(session, () => this.preflight());
      return { authenticated: true, mode: session.mode, saved_at: session.stored.saved_at };
    } catch (e) {
      if (e instanceof ToolError && RELOGIN_CODES.has(e.code)) return { authenticated: false, reason: 'SESSION_EXPIRED', mode: session.mode };
      throw e;
    }
  }

  async forget(): Promise<boolean> {
    return this.ctx.sessions.remove(this.platform);
  }
}
