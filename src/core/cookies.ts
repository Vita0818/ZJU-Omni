export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
}

function defaultPath(url: URL): string {
  const path = url.pathname;
  if (!path.startsWith('/') || path === '/') return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

export function parseSetCookie(header: string, url: URL, now = Date.now()): StoredCookie | null {
  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  const host = url.hostname.toLowerCase();
  const cookie: StoredCookie = { name, value, domain: host, path: defaultPath(url), expires: -1, secure: false, httpOnly: false, hostOnly: true };
  let maxAge: number | null = null;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const val = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'domain' && val) {
      const domain = val.replace(/^\./, '').toLowerCase();
      if (!domain.includes('.') || !domainMatches(host, domain)) return null;
      cookie.domain = domain;
      cookie.hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) {
      cookie.path = val;
    } else if (key === 'expires' && maxAge === null) {
      const time = Date.parse(val);
      if (Number.isFinite(time)) cookie.expires = Math.floor(time / 1000);
    } else if (key === 'max-age' && /^-?\d+$/.test(val)) {
      maxAge = Number(val);
      cookie.expires = maxAge <= 0 ? 0 : Math.floor(now / 1000) + maxAge;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    }
  }
  return cookie;
}

export class CookieJar {
  private cookies: StoredCookie[];
  constructor(cookies: StoredCookie[] = []) {
    this.cookies = cookies.map(c => ({ ...c }));
  }
  static from(cookies: StoredCookie[] | undefined): CookieJar {
    return new CookieJar(cookies ?? []);
  }
  clone(): CookieJar {
    return new CookieJar(this.cookies);
  }
  list(): StoredCookie[] {
    this.purge();
    return this.cookies.map(c => ({ ...c }));
  }
  get size(): number {
    return this.list().length;
  }
  purge(now = Date.now()): void {
    const seconds = now / 1000;
    this.cookies = this.cookies.filter(c => c.expires < 0 || c.expires > seconds);
  }
  set(cookie: StoredCookie): void {
    this.cookies = this.cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
    if (cookie.expires === 0 || (cookie.expires > 0 && cookie.expires * 1000 <= Date.now())) return;
    this.cookies.push({ ...cookie });
  }
  setFromHeaders(url: URL, headers: string[]): void {
    for (const header of headers) {
      const cookie = parseSetCookie(header, url);
      if (cookie) this.set(cookie);
    }
  }
  matching(url: URL): StoredCookie[] {
    this.purge();
    const host = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:';
    return this.cookies
      .filter(c => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) && pathMatches(url.pathname || '/', c.path) && (!c.secure || secure))
      .sort((a, b) => b.path.length - a.path.length);
  }
  header(url: URL): string {
    return this.matching(url).map(c => `${c.name}=${c.value}`).join('; ');
  }
  filter(predicate: (cookie: StoredCookie) => boolean): CookieJar {
    return new CookieJar(this.list().filter(predicate));
  }
  merge(other: CookieJar): void {
    for (const cookie of other.list()) this.set(cookie);
  }
}
