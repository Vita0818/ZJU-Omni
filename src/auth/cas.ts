import { ToolError } from '../core/errors.ts';
import type { HttpClient } from '../core/http.ts';
import type { Credentials } from '../core/keychain.ts';

export const CAS_HOST = 'zjuam.zju.edu.cn';
export const IDENTITY_HOST = 'identity.zju.edu.cn';
const PUBKEY_URL = `https://${CAS_HOST}/cas/v2/getPubKey`;

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), (m[2] ?? m[3]).replace(/&amp;/g, '&').replace(/&quot;/g, '"')]),
  );
}

export function authUrlGuard(hosts: Iterable<string>, upgradeHttpHosts: Iterable<string> = []) {
  const allowed = new Set([CAS_HOST, IDENTITY_HOST, ...hosts]);
  const upgrade = new Set(upgradeHttpHosts);
  return (value: string | URL, base?: string | URL): URL => {
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      throw new ToolError('AUTH_REDIRECT_REJECTED', '统一认证返回了无法解析的跳转地址，已停止认证。');
    }
    if (url.protocol === 'http:' && upgrade.has(url.hostname)) url = new URL(`https:${url.href.slice('http:'.length)}`);
    if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.hostname)) {
      throw new ToolError('AUTH_REDIRECT_REJECTED', '统一认证跳转到未配置的站点，已停止认证。', { hostname: url.hostname });
    }
    return url;
  };
}

export function casForm(html: string, url: string | URL, guard = authUrlGuard([])): { action: string; execution: string } {
  const forms = [...html.matchAll(/<form\b[^>]*>/gi)].map(m => attributes(m[0]));
  const form = forms.find(f => f.id === 'fm1') || forms[0];
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => attributes(m[0]));
  const execution = inputs.find(i => i.name === 'execution')?.value;
  if (!execution || !form) throw new ToolError('AUTH_FLOW_CHANGED', '统一认证页面未提供预期的登录表单。');
  const action = guard(form.action || String(url), url);
  if (action.hostname !== CAS_HOST || !action.pathname.startsWith('/cas/')) {
    throw new ToolError('AUTH_FORM_REJECTED', '密码只能提交到已验证的浙大统一认证接口。');
  }
  return { action: action.toString(), execution };
}

export function hasCasForm(html: string): boolean {
  return /<input\b[^>]*name\s*=\s*["']execution["']/i.test(html);
}

export function encryptCasPassword(password: string, modulusHex: string, exponentHex: string): string {
  if (/[^\x00-\x7f]/.test(password)) {
    throw new ToolError('AUTH_PASSWORD_ENCODING_UNSUPPORTED', '当前已验证的统一认证编码支持 ASCII 密码。非 ASCII 口令的学校兼容编码尚待适配，已在提交前停止。');
  }
  if (!/^[a-f\d]{128,1024}$/i.test(modulusHex || '') || !/^[a-f\d]{1,8}$/i.test(exponentHex || '')) {
    throw new ToolError('AUTH_KEY_INVALID', '统一认证 RSA 公钥格式无法识别。');
  }
  const modulus = BigInt('0x' + modulusHex);
  const exponent = BigInt('0x' + exponentHex);
  const chunkSize = 2 * Math.floor((modulus.toString(16).length - 1) / 4);
  if (modulus.toString(16).length < 128 || exponent < 3n || password.length > 4096) {
    throw new ToolError('AUTH_KEY_INVALID', '密码长度或公钥参数不受支持。');
  }
  // Same packing as the school's login.js / security.js RSAUtils:
  // reversed UTF-16 units, little-endian characters, chunked.
  const units = password.split('').reverse().map(c => c.charCodeAt(0));
  const chunks: string[] = [];
  for (let start = 0; start < units.length; start += chunkSize) {
    let message = 0n;
    for (let i = Math.min(start + chunkSize, units.length) - 1; i >= start; i--) message = message * 256n + BigInt(units[i]);
    let result = 1n;
    let factor = message;
    let power = exponent;
    while (power > 0n) {
      if (power & 1n) result = (result * factor) % modulus;
      factor = (factor * factor) % modulus;
      power >>= 1n;
    }
    const hex = result.toString(16);
    chunks.push(hex.padStart(Math.ceil(hex.length / 4) * 4, '0'));
  }
  return chunks.join(' ');
}

interface Page {
  url: URL;
  html: string;
}

async function follow(http: HttpClient, first: URL, guard: ReturnType<typeof authUrlGuard>, stopAtCas: boolean): Promise<Page> {
  let url = guard(first);
  for (let hop = 0; hop < 15; hop++) {
    const response = await http.request(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = guard(response.location);
      continue;
    }
    if (response.status !== 200) {
      throw new ToolError('AUTH_NETWORK_ERROR', `认证链路返回 HTTP ${response.status}。`, { hostname: url.hostname, http_status: response.status });
    }
    const html = response.text();
    if (stopAtCas && url.hostname === CAS_HOST) return { url, html };
    const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map(m => attributes(m[0])).find(a => /refresh/i.test(a['http-equiv'] || ''));
    const target = meta?.content?.match(/url\s*=\s*(.+)$/i)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (target) {
      url = guard(target, url);
      continue;
    }
    return { url, html };
  }
  throw new ToolError('AUTH_REDIRECT_LIMIT', '认证跳转超过限制，已停止。');
}

export interface CasLoginOptions {
  entry: string;
  hosts: string[];
  /** Platform hosts whose CAS service callback may arrive as http:// and is upgraded to https://. */
  upgradeHttpHosts?: string[];
  credentials: () => Promise<Credentials>;
}

export interface CasLoginResult {
  url: URL;
  html: string;
  passwordSubmitted: boolean;
}

/**
 * Runs the real ZJU unified-identity HTTP flow starting at a platform entry
 * page. If the jar already holds a CAS ticket-granting cookie, the flow may
 * complete without submitting the password. The password is submitted at
 * most once; any rejection or challenge stops immediately.
 */
export async function casLogin(http: HttpClient, options: CasLoginOptions): Promise<CasLoginResult> {
  const guard = authUrlGuard(options.hosts, options.upgradeHttpHosts);
  const landing = await follow(http, new URL(options.entry), guard, true);
  if (landing.url.hostname !== CAS_HOST) return { url: landing.url, html: landing.html, passwordSubmitted: false };
  if (!hasCasForm(landing.html)) {
    const done = await follow(http, landing.url, guard, false);
    if (done.url.hostname !== CAS_HOST) return { url: done.url, html: done.html, passwordSubmitted: false };
  }
  const form = casForm(landing.html, landing.url, guard);
  const account = await options.credentials();
  const keyResponse = await http.request(PUBKEY_URL, { headers: { Accept: 'application/json' } });
  let key: { modulus?: string; exponent?: string };
  try {
    if (!keyResponse.ok) throw new Error('status');
    key = keyResponse.json();
  } catch {
    throw new ToolError('AUTH_KEY_INVALID', '无法取得统一认证公钥。');
  }
  const body = {
    username: account.username,
    password: encryptCasPassword(account.password, key.modulus ?? '', key.exponent ?? ''),
    execution: form.execution,
    _eventId: 'submit',
    authcode: '',
  };
  const response = await http.request(form.action, {
    method: 'POST',
    form: body,
    headers: { Origin: `https://${CAS_HOST}`, Referer: landing.url.toString(), Accept: 'text/html,application/xhtml+xml' },
  });
  if (!(response.status >= 300 && response.status < 400 && response.location)) {
    const html = response.status === 200 ? response.text() : '';
    if (!/用户名或密码错误|密码错误|账号或密码/.test(html) && /验证码|captcha|二次验证|短信|动态码/i.test(html)) {
      throw new ToolError('AUTH_CHALLENGE_REQUIRED', '统一认证要求验证码或二次验证。请先在浏览器完成一次登录后再试；不会自动重试。', { http_status: response.status });
    }
    throw new ToolError('AUTHENTICATION_REQUIRED', '统一认证未接受本次登录。请检查已配置凭据；若学校要求验证码或二次验证，需要先完成该认证要求。', { http_status: response.status });
  }
  const done = await follow(http, guard(response.location), guard, false);
  if (done.url.hostname === CAS_HOST) {
    throw new ToolError('AUTHENTICATION_REQUIRED', '统一认证流程停留在登录页，未返回平台。', { hostname: done.url.hostname });
  }
  return { url: done.url, html: done.html, passwordSubmitted: true };
}
