import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { loadConfig, enabledPlatforms, networkMode, toolProfile } from '../src/core/config.ts';
import { CookieJar, parseSetCookie } from '../src/core/cookies.ts';
import { HttpClient } from '../src/core/http.ts';
import { RateLimiter } from '../src/core/ratelimit.ts';
import { Accounts } from '../src/core/keychain.ts';
import { SessionStore, withLock } from '../src/core/store.ts';
import { compactValue, strictArgs } from '../src/core/tools.ts';
import { deadline, requiredArray } from '../src/core/util.ts';
import { fromWebvpnUrl, toWebvpnUrl, webvpnPassword, webvpnTransport, wrdEncrypt, parseWebvpnLoginPage, loginWebvpn } from '../src/auth/webvpn.ts';
import { mockFetch, respond, tempDir } from './helpers.ts';
import { z } from 'zod';

test('profile, platforms and network mode are validated with explicit defaults', () => {
  assert.equal(toolProfile({}), 'full');
  assert.equal(toolProfile({ MCP_TOOL_PROFILE: ' LITE ' }), 'lite');
  assert.throws(() => toolProfile({ MCP_TOOL_PROFILE: 'tiny' }), (e: any) => e.code === 'CONFIG_ERROR');
  assert.deepEqual([...enabledPlatforms({})], ['xzzd', 'zdbk', 'zhiyun', 'pta', 'cc98']);
  assert.ok(!enabledPlatforms({}).has('xxt'));
  assert.deepEqual([...enabledPlatforms({ ZJU_PLATFORMS: 'xzzd, XXT' })], ['xzzd', 'xxt']);
  assert.throws(() => enabledPlatforms({ ZJU_PLATFORMS: 'xzzd,moodle' }), (e: any) => e.code === 'CONFIG_ERROR');
  assert.equal(networkMode({}), 'auto');
  assert.equal(networkMode({ ZJU_NETWORK: 'WebVPN' }), 'webvpn');
  assert.throws(() => networkMode({ ZJU_NETWORK: 'proxy' }), (e: any) => e.code === 'CONFIG_ERROR');
  assert.match(loadConfig({}).dataDir, /zju-omni$/);
});

test('cookie jar honours domain, host-only, path, secure and expiry rules', () => {
  const jar = new CookieJar();
  const url = new URL('https://courses.zju.edu.cn/api/x');
  jar.setFromHeaders(url, [
    'session=abc; Path=/; HttpOnly; Secure',
    'wide=1; Domain=.zju.edu.cn; Path=/',
    'scoped=2; Path=/api',
    'evil=3; Domain=example.com',
    'gone=4; Max-Age=0',
  ]);
  assert.equal(jar.header(new URL('https://courses.zju.edu.cn/api/y')), 'scoped=2; session=abc; wide=1');
  assert.equal(jar.header(new URL('https://zjuam.zju.edu.cn/cas')), 'wide=1');
  assert.equal(jar.header(new URL('http://courses.zju.edu.cn/')), 'wide=1');
  assert.equal(jar.header(new URL('https://courses.zju.edu.cn/apix')), 'session=abc; wide=1');
  jar.setFromHeaders(url, ['session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.doesNotMatch(jar.header(url), /session=/);
  assert.equal(parseSetCookie('=novalue', url), null);
});

test('http client follows only allowed redirects, keeps cookies and never reads redirect bodies', async () => {
  const fetchImpl = mockFetch(url => {
    if (url.pathname === '/start') return respond(302, '', [['location', '/next'], ['set-cookie', 'a=1; Path=/']]);
    if (url.pathname === '/next') return respond(200, 'ok');
    if (url.pathname === '/away') return respond(302, '', { location: 'https://evil.example/' });
    return respond(404);
  });
  const http = new HttpClient({ fetchImpl });
  const result = await http.request('https://courses.zju.edu.cn/start', { maxRedirects: 3, allowUrl: u => u.hostname.endsWith('zju.edu.cn') });
  assert.equal(result.text(), 'ok');
  assert.equal((fetchImpl.calls[1].init.headers as Headers).get('cookie'), 'a=1');
  await assert.rejects(() => http.request('https://courses.zju.edu.cn/away', { maxRedirects: 3, allowUrl: u => u.hostname.endsWith('zju.edu.cn') }), (e: any) => e.code === 'REDIRECT_REJECTED');
  const raw = await http.request('https://courses.zju.edu.cn/start');
  assert.equal(raw.status, 302);
  assert.equal(raw.location?.toString(), 'https://courses.zju.edu.cn/next');
});

test('network failures are classified without leaking the underlying error', async () => {
  const refused = new HttpClient({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed secret'), { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(() => refused.request('https://courses.zju.edu.cn/'), (e: any) => e.code === 'NETWORK_ERROR' && e.details.before_send === true && !e.message.includes('secret'));
  const reset = new HttpClient({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(() => reset.request('https://courses.zju.edu.cn/'), (e: any) => e.code === 'NETWORK_ERROR' && e.details.before_send === false);
  const big = new HttpClient({ fetchImpl: async () => respond(200, 'x'.repeat(100)) });
  await assert.rejects(() => big.request('https://courses.zju.edu.cn/', { maxBytes: 10 }), (e: any) => e.code === 'RESPONSE_TOO_LARGE');
});

test('rate limiter serialises one platform and enforces the minimum interval', async () => {
  const limiter = new RateLimiter(30);
  let active = 0, peak = 0;
  const starts: number[] = [];
  const job = () => limiter.schedule('xzzd', async () => { active++; peak = Math.max(peak, active); starts.push(Date.now()); await new Promise(r => setTimeout(r, 5)); active--; });
  await Promise.all([job(), job(), job()]);
  assert.equal(peak, 1);
  assert.ok(starts[2] - starts[1] >= 28 && starts[1] - starts[0] >= 28);
  await assert.rejects(() => limiter.schedule('xzzd', async () => { throw new Error('boom'); }));
  await limiter.schedule('xzzd', async () => 'still works');
});

test('keychain accounts: environment wins, keychain lookup is scoped and missing setup is explained', async t => {
  const dir = await tempDir(t);
  const calls: string[][] = [];
  const runner = async (args: string[]) => { calls.push(args); return 'kc-secret\n'; };
  const accounts = new Accounts(dir, { env: {}, runner, legacyDir: null, platform: 'darwin' });
  await assert.rejects(() => accounts.load('zju'), (e: any) => e.code === 'CONFIGURATION_REQUIRED' && /configure -- zju/.test(e.details.setup_command));
  await accounts.record('zju', 'student');
  assert.deepEqual(await accounts.load('zju'), { username: 'student', password: 'kc-secret' });
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'zju-omni.zjuam', '-a', 'student', '-w']);
  assert.equal(((await stat(accounts.file)).mode & 0o777), 0o600);
  assert.doesNotMatch(await readFile(accounts.file, 'utf8'), /kc-secret/);
  const env = new Accounts(dir, { env: { ZJU_USERNAME: 'e', ZJU_PASSWORD: 'p' }, runner, legacyDir: null });
  assert.deepEqual(await env.load('zju'), { username: 'e', password: 'p' });
  assert.equal((await env.status('cc98')).configured, false);
});

test('legacy zju-tronclass keychain item is reused read-only', async t => {
  const dir = await tempDir(t), legacy = await tempDir(t);
  await writeFile(join(legacy, 'account.json'), JSON.stringify({ username: 'old', backend: 'macos-keychain' }));
  const calls: string[][] = [];
  const accounts = new Accounts(dir, { env: {}, legacyDir: legacy, platform: 'darwin', runner: async args => { calls.push(args); return 'pw'; } });
  assert.equal((await accounts.status('zju')).backend, 'legacy-zju-tronclass');
  await accounts.load('zju');
  assert.equal(calls[0][2], 'org.zju.tronclass.codex');
});

test('session files are private and validated', async t => {
  const dir = await tempDir(t);
  const store = new SessionStore(dir);
  await store.write({ platform: 'xzzd', mode: 'direct', saved_at: 'now', cookies: [] });
  assert.equal(((await stat(store.path('xzzd'))).mode & 0o777), 0o600);
  assert.equal(((await stat(store.dir)).mode & 0o777), 0o700);
  await writeFile(store.path('zdbk'), JSON.stringify({ platform: 'other', mode: 'direct', cookies: [] }));
  await assert.rejects(() => store.read('zdbk'), (e: any) => e.code === 'LOCAL_STATE_INVALID');
  assert.throws(() => store.path('../x'), (e: any) => e.code === 'INVALID_SESSION_NAME');
  await mkdir(join(dir, 'locks'), { recursive: true });
  const lock = join(dir, 'locks', 'a.lock');
  await withLock(lock, async () => assert.rejects(() => withLock(lock, async () => 1), (e: any) => e.code === 'ACTION_BUSY'));
});

test('WebVPN host encryption matches the padded reference algorithm and round-trips', () => {
  const host = 'zdbk.zju.edu.cn';
  const key = Buffer.from('wrdvpnisthebest!');
  const padded = Buffer.concat([Buffer.from(host), Buffer.alloc(16 - (host.length % 16))]);
  const cipher = createCipheriv('aes-128-cfb', key, key);
  const reference = key.toString('hex') + Buffer.concat([cipher.update(padded), cipher.final()]).toString('hex').slice(0, host.length * 2);
  assert.equal(wrdEncrypt('wrdvpnisthebest!', host), reference);
  const url = toWebvpnUrl(new URL('https://zdbk.zju.edu.cn/jwglxt/xtgl/login_slogin.html?x=1'));
  assert.equal(url.origin, 'https://webvpn.zju.edu.cn');
  assert.match(url.pathname, /^\/https\/77726476706e69737468656265737421[0-9a-f]+\/jwglxt\//);
  assert.equal(fromWebvpnUrl(url)?.toString(), 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_slogin.html?x=1');
  const port = toWebvpnUrl(new URL('http://10.0.0.1:8080/a'));
  assert.match(port.pathname, /^\/http-8080\//);
  assert.equal(fromWebvpnUrl(port)?.toString(), 'http://10.0.0.1:8080/a');
  assert.throws(() => webvpnTransport.toLogical(new URL('https://webvpn.zju.edu.cn/login?cas_login=true')), (e: any) => e.code === 'WEBVPN_LOGIN_REQUIRED');
  assert.ok(webvpnPassword('pw').startsWith(Buffer.from('wrdvpnisawesome!').toString('hex')));
  assert.equal(webvpnPassword('pw').length, 32 + 4);
});

test('WebVPN login submits once, stores the ticket and stops on captcha or confirmation prompts', async () => {
  const page = '<form><input type="hidden" name="_csrf" value="tok"><input name="captcha_id" value="cid"></form>';
  assert.deepEqual(parseWebvpnLoginPage(page), { csrf: 'tok', captchaId: 'cid' });
  for (const [answer, code] of [[{ success: true }, null], [{ success: false, error: 'CAPTCHA_FAILED' }, 'AUTH_CHALLENGE_REQUIRED'], [{ success: false, error: 'NEED_CONFIRM' }, 'WEBVPN_CONFIRM_REQUIRED'], [{ success: false, error: 'WRONG' }, 'AUTHENTICATION_REQUIRED']] as const) {
    let posts = 0;
    const fetchImpl = mockFetch((url, init) => {
      if (url.pathname === '/login') return respond(200, page);
      posts++;
      assert.match(String(init.body), /password=77726476706e6973617765736f6d6521/);
      assert.doesNotMatch(String(init.body), /plain-password/);
      return respond(200, answer, { 'set-cookie': 'wengine_vpn_ticketwebvpn_zju_edu_cn=t; Path=/' });
    });
    const http = new HttpClient({ fetchImpl });
    const run = loginWebvpn(http, { username: 'u', password: 'plain-password' });
    if (code) await assert.rejects(run, (e: any) => e.code === code); else await run;
    assert.equal(posts, 1);
    if (!code) assert.match(http.jar.header(new URL('https://webvpn.zju.edu.cn/')), /wengine_vpn_ticket/);
  }
});

test('lite helpers compact output and validate against strict schemas', () => {
  assert.deepEqual(compactValue({ a: null, b: [], url: 'https://x', source_url: 'y', c: false, d: 0, e: [{ url: 'y', f: 1, g: null }] }), { c: false, d: 0, e: [{ f: 1 }] });
  assert.throws(() => strictArgs({ id: z.number().int().positive() }, { id: -1 }), (e: any) => e.code === 'INVALID_ARGUMENT');
});

test('missing upstream list fields fail visibly and deadlines keep unknown time zones', () => {
  assert.throws(() => requiredArray({ error: 'login' }, 'courses'), (e: any) => e.code === 'SCHEMA_CHANGED');
  assert.deepEqual(requiredArray({ courses: [] }, 'courses'), []);
  assert.match(deadline('2026-09-15T15:59:00Z').shanghai!, /23:59:00 \+08:00/);
  assert.equal(deadline('2026-09-15 23:59:00').iso, null);
  assert.equal(deadline(null).raw, null);
});
