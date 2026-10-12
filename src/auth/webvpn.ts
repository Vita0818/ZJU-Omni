// WebVPN URL scheme and login form adapted from EviterLesRoses2/cc98-mcp (MIT),
// which in turn credits Lucent-Snow/CC98-CLI (MIT).
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { ToolError } from '../core/errors.ts';
import type { HttpClient, Transport } from '../core/http.ts';

export const WEBVPN_ORIGIN = 'https://webvpn.zju.edu.cn';
const WEBVPN_HOST = 'webvpn.zju.edu.cn';
const URL_KEY = 'wrdvpnisthebest!';
const PASSWORD_KEY = 'wrdvpnisawesome!';
const CAMPUS_CHECK_URL = 'https://mirrors.zju.edu.cn/api/is_campus_network';

function cfb(key: string, data: Buffer, decrypt = false): Buffer {
  const k = Buffer.from(key, 'ascii');
  const cipher = decrypt ? createDecipheriv('aes-128-cfb', k, k) : createCipheriv('aes-128-cfb', k, k);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function wrdEncrypt(key: string, plaintext: string): string {
  return Buffer.from(key, 'ascii').toString('hex') + cfb(key, Buffer.from(plaintext, 'utf8')).toString('hex');
}

export function wrdDecrypt(key: string, value: string): string {
  const prefix = Buffer.from(key, 'ascii').toString('hex');
  if (!value.startsWith(prefix) || !/^[0-9a-f]*$/i.test(value) || (value.length - prefix.length) % 2) {
    throw new ToolError('WEBVPN_URL_INVALID', 'WebVPN 地址格式无法识别。');
  }
  return cfb(key, Buffer.from(value.slice(prefix.length), 'hex'), true).toString('utf8');
}

export function toWebvpnUrl(url: URL): URL {
  if (url.hostname === WEBVPN_HOST) return url;
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'https' && scheme !== 'http') throw new ToolError('WEBVPN_URL_INVALID', 'WebVPN 只能转发 HTTP(S) 地址。');
  const property = url.port ? `${scheme}-${url.port}` : scheme;
  return new URL(`${WEBVPN_ORIGIN}/${property}/${wrdEncrypt(URL_KEY, url.hostname)}${url.pathname}${url.search}`);
}

const ENCODED_PATH = /^\/(https?)(?:-(\d+))?\/([0-9a-f]{32,})(\/[^?#]*)?$/i;

export function fromWebvpnUrl(url: URL): URL | null {
  if (url.hostname !== WEBVPN_HOST) return null;
  const match = url.pathname.match(ENCODED_PATH);
  if (!match) return null;
  const host = wrdDecrypt(URL_KEY, match[3]);
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new ToolError('WEBVPN_URL_INVALID', 'WebVPN 地址中的站点名无效。');
  return new URL(`${match[1]}://${host}${match[2] ? `:${match[2]}` : ''}${match[4] || '/'}${url.search}`);
}

export function isWebvpnLoginUrl(url: URL): boolean {
  return url.hostname === WEBVPN_HOST && /^\/(login|portal|do-login|logout)(\/|$)/.test(url.pathname);
}

export const webvpnTransport: Transport = {
  mode: 'webvpn',
  toPhysical: url => toWebvpnUrl(url),
  toLogical: url => {
    if (isWebvpnLoginUrl(url)) throw new ToolError('WEBVPN_LOGIN_REQUIRED', 'WebVPN 会话已失效，需要重新登录。');
    return fromWebvpnUrl(url) ?? url;
  },
};

export function webvpnPassword(password: string): string {
  return wrdEncrypt(PASSWORD_KEY, password);
}

export function parseWebvpnLoginPage(html: string): { csrf: string; captchaId: string } {
  const attr = (name: string) => {
    const tag = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => m[0]).find(t => new RegExp(`name\\s*=\\s*["']${name}["']`, 'i').test(t));
    return tag?.match(/value\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  };
  return { csrf: attr('_csrf'), captchaId: attr('captcha_id') };
}

/**
 * Logs in to WebVPN with the unified identity account. `http` must use the
 * direct transport; its jar receives the WebVPN ticket cookies.
 */
export async function loginWebvpn(http: HttpClient, credentials: { username: string; password: string }): Promise<void> {
  const page = await http.request(`${WEBVPN_ORIGIN}/login`, { maxRedirects: 3, allowUrl: u => u.hostname === WEBVPN_HOST && u.protocol === 'https:' });
  if (page.status !== 200) throw new ToolError('WEBVPN_UNAVAILABLE', `WebVPN 登录页返回 HTTP ${page.status}。`, { http_status: page.status });
  const { csrf, captchaId } = parseWebvpnLoginPage(page.text());
  if (!csrf) throw new ToolError('AUTH_FLOW_CHANGED', 'WebVPN 登录页未提供预期的表单字段。');
  const response = await http.request(`${WEBVPN_ORIGIN}/do-login`, {
    method: 'POST',
    headers: { Referer: `${WEBVPN_ORIGIN}/login`, Origin: WEBVPN_ORIGIN, Accept: 'application/json' },
    form: { _csrf: csrf, auth_type: 'local', sms_code: '', captcha: '', needCaptcha: 'false', captcha_id: captchaId, username: credentials.username, password: webvpnPassword(credentials.password) },
  });
  let result: Record<string, unknown>;
  try {
    result = response.json();
  } catch {
    throw new ToolError('AUTH_FLOW_CHANGED', 'WebVPN 登录接口返回格式无法识别。', { http_status: response.status });
  }
  if (result.success === true) return;
  const code = typeof result.error === 'string' ? result.error : 'UNKNOWN';
  const details = { platform_error: code };
  if (code === 'NEED_CONFIRM') {
    throw new ToolError('WEBVPN_CONFIRM_REQUIRED', 'WebVPN 提示该账号已在其他设备登录，需要确认后才能继续。为避免踢下其他会话，已停止；请先在其他设备退出 WebVPN 后重试。', details);
  }
  if (code === 'CAPTCHA_FAILED' || code === 'NEED_CAPTCHA' || code.startsWith('NEED_TWO_STEP') || code === 'WECHAT_BINDING') {
    throw new ToolError('AUTH_CHALLENGE_REQUIRED', 'WebVPN 要求验证码、短信或二次验证。请先在浏览器登录一次 webvpn.zju.edu.cn，再重试；不会自动重试。', details);
  }
  if (code === 'TOO_MANY_ATTEMPTS' || code === 'IP_FORBIDDEN' || code === 'WEEK_PASSWORD_FORBID') {
    throw new ToolError('AUTH_BLOCKED', code === 'WEEK_PASSWORD_FORBID' ? 'WebVPN 以弱密码为由拒绝登录，请先在浏览器修改密码。' : 'WebVPN 暂时阻止了登录（尝试过多或 IP 受限），请稍后在浏览器登录确认。', details);
  }
  throw new ToolError('AUTHENTICATION_REQUIRED', 'WebVPN 未接受本次登录。WebVPN 使用“上网账号”（与统一认证是两套系统），请运行 npm run configure -- webvpn 检查配置。不会自动重试。', details);
}

export async function isCampusNetwork(fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const response = await fetchImpl(CAMPUS_CHECK_URL, { signal: AbortSignal.timeout(5000) });
    const text = (await response.text()).trim();
    return text === '1' || text === '2';
  } catch {
    return null;
  }
}
