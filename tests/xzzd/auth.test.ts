import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, publicEncrypt, constants } from 'node:crypto';
import { ToolError } from '../../src/core/errors.ts';
import { casForm, authUrlGuard, encryptCasPassword } from '../../src/auth/cas.ts';
import { XzzdClient } from '../../src/platforms/xzzd/client.ts';
import { fromWebvpnUrl, toWebvpnUrl } from '../../src/auth/webvpn.ts';
import { mockFetch, respond, testContext, xzzdSession } from '../helpers.ts';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const modulus = Buffer.from(jwk.n!, 'base64url').toString('hex');
const exponent = Buffer.from(jwk.e!, 'base64url').toString('hex');
const CREDS = { ZJU_USERNAME: 'synthetic-account', ZJU_PASSWORD: 'synthetic-password' };

test('CAS form accepts reordered attributes but rejects foreign password destinations', () => {
  const html = '<form action="/cas/login?service=x&amp;key=y" id="fm1"><input value="opaque" name="execution"></form>';
  assert.deepEqual(casForm(html, 'https://zjuam.zju.edu.cn/cas/login'), { execution: 'opaque', action: 'https://zjuam.zju.edu.cn/cas/login?service=x&key=y' });
  assert.throws(() => casForm(html.replace('/cas/login?service=x&amp;key=y', 'https://evil.example/collect'), 'https://zjuam.zju.edu.cn/cas/login'), (e: any) => e.code === 'AUTH_REDIRECT_REJECTED');
  assert.throws(() => authUrlGuard([])('http://zjuam.zju.edu.cn/cas/login'), (e: any) => e.code === 'AUTH_REDIRECT_REJECTED');
});

test('CAS ASCII encryption agrees with the native RSA primitive', () => {
  const password = 'Synthetic-test-p@ss!';
  const padded = Buffer.alloc(128);
  Buffer.from(password).copy(padded, 128 - password.length);
  const expected = publicEncrypt({ key: keyPair.publicKey, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
  assert.equal(BigInt('0x' + encryptCasPassword(password, modulus, exponent)), BigInt('0x' + expected));
});

test('unsupported non-ASCII passwords stop before an incorrect authentication request', () => {
  assert.throws(() => encryptCasPassword('测试-password', modulus, exponent), (e: any) => e.code === 'AUTH_PASSWORD_ENCODING_UNSUPPORTED');
});

function casSite(state: { loggedIn: boolean; posts: number; navigationAccept: string[] }) {
  return (url: URL, init: RequestInit): Response => {
    const headers = init.headers as Headers;
    if (url.pathname === '/cas/v2/getPubKey') return respond(200, { modulus, exponent });
    if (url.hostname === 'courses.zju.edu.cn' && url.pathname === '/api/my-courses') {
      return state.loggedIn && /session=course-only/.test(headers.get('cookie') ?? '') ? respond(200, { courses: [] }) : respond(401, { message: 'auth' });
    }
    if (url.hostname === 'courses.zju.edu.cn') {
      state.navigationAccept.push(headers.get('accept') ?? '');
      return state.loggedIn ? respond(200, '<title>Courses</title>', { 'set-cookie': 'session=course-only; Path=/; HttpOnly' }) : respond(302, '', { location: 'https://identity.zju.edu.cn/auth/realms/zju/protocol/cas/login' });
    }
    if (url.hostname === 'identity.zju.edu.cn') return respond(303, '', { location: 'https://zjuam.zju.edu.cn/cas/login?service=broker' });
    if (url.hostname === 'zjuam.zju.edu.cn' && init.method === 'POST') {
      state.posts++;
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('username'), 'synthetic-account');
      assert.notEqual(body.get('password'), 'synthetic-password');
      state.loggedIn = true;
      return respond(302, '', [['location', 'https://courses.zju.edu.cn/user/index'], ['set-cookie', 'iPlanetDirectoryPro=sso-only; Domain=.zju.edu.cn; Path=/'], ['set-cookie', 'CASTGC=tgc-only; Path=/cas']]);
    }
    if (/CASTGC=tgc-only/.test(headers.get('cookie') ?? '')) {
      state.loggedIn = true;
      return respond(302, '', { location: 'https://courses.zju.edu.cn/user/index' });
    }
    return respond(200, '<form id="fm1" action="/cas/login?service=broker"><input name="execution" value="opaque"></form>');
  };
}

test('API login follows the identity broker, submits once, and stores only course credentials', async t => {
  const state = { loggedIn: false, posts: 0, navigationAccept: [] as string[] };
  const fetchImpl = mockFetch(casSite(state));
  const { ctx } = await testContext(t, { env: { ...CREDS, ZJU_NETWORK: 'direct' }, fetchImpl });
  const client = new XzzdClient(ctx);
  const session = await client.refreshSession();
  assert.equal(session.mode, 'direct');
  const saved = await readFile(ctx.sessions.path('xzzd'), 'utf8');
  assert.equal(state.posts, 1);
  assert.ok(state.navigationAccept.every(a => !a.includes('application/json')));
  assert.match(saved, /course-only/);
  assert.doesNotMatch(saved, /sso-only|tgc-only|synthetic-password/);
  state.loggedIn = false;
  await new XzzdClient(ctx).refreshSession();
  assert.equal(state.posts, 1, 'a second login in the same process reuses the in-memory CAS ticket instead of the password');
});

test('CAS rejection does not retry the password or save an authenticated session', async t => {
  let posts = 0;
  const fetchImpl = mockFetch((url, init) => {
    if (url.pathname.includes('getPubKey')) return respond(200, { modulus, exponent });
    if (url.hostname === 'courses.zju.edu.cn') return respond(302, '', { location: 'https://zjuam.zju.edu.cn/cas/login' });
    if (init.method === 'POST') {
      posts++;
      return respond(200, '<p>用户名或密码错误</p>');
    }
    return respond(200, '<form id="fm1"><input name="execution" value="opaque"></form>');
  });
  const { ctx } = await testContext(t, { env: { ...CREDS, ZJU_NETWORK: 'direct' }, fetchImpl });
  await assert.rejects(() => new XzzdClient(ctx).refreshSession(), (e: any) => e.code === 'AUTHENTICATION_REQUIRED');
  assert.equal(posts, 1);
  await assert.rejects(() => readFile(ctx.sessions.path('xzzd')), (e: any) => e.code === 'ENOENT');
});

test('a rejected CAS password is not resubmitted automatically, but an explicit login may retry', async t => {
  let posts = 0;
  const fetchImpl = mockFetch((url, init) => {
    if (url.pathname.includes('getPubKey')) return respond(200, { modulus, exponent });
    if (url.hostname === 'courses.zju.edu.cn') return respond(302, '', { location: 'https://zjuam.zju.edu.cn/cas/login' });
    if (init.method === 'POST') {
      posts++;
      return respond(200, '<p>用户名或密码错误</p>');
    }
    return respond(200, '<form id="fm1"><input name="execution" value="opaque"></form>');
  });
  const { ctx } = await testContext(t, { env: { ...CREDS, ZJU_NETWORK: 'direct' }, fetchImpl });
  await assert.rejects(() => new XzzdClient(ctx).refreshSession(), (e: any) => e.code === 'AUTHENTICATION_REQUIRED');
  await assert.rejects(() => new XzzdClient(ctx).refreshSession(), (e: any) => /不再自动重试/.test(e.message));
  assert.equal(posts, 1);
  await assert.rejects(() => new XzzdClient(ctx).refreshSession({ explicit: true }), (e: any) => e.code === 'AUTHENTICATION_REQUIRED');
  assert.equal(posts, 2);
});

test('captcha challenges stop with a distinct code', async t => {
  const fetchImpl = mockFetch((url, init) => {
    if (url.pathname.includes('getPubKey')) return respond(200, { modulus, exponent });
    if (url.hostname === 'courses.zju.edu.cn') return respond(302, '', { location: 'https://zjuam.zju.edu.cn/cas/login' });
    if (init.method === 'POST') return respond(200, '<p>请输入验证码</p><form id="fm1"><input name="execution" value="x"></form>');
    return respond(200, '<form id="fm1"><input name="execution" value="opaque"></form>');
  });
  const { ctx } = await testContext(t, { env: { ...CREDS, ZJU_NETWORK: 'direct' }, fetchImpl });
  await assert.rejects(() => new XzzdClient(ctx).refreshSession(), (e: any) => e.code === 'AUTH_CHALLENGE_REQUIRED');
});

test('auto network falls back to WebVPN when the platform is unreachable directly', async t => {
  const state = { loggedIn: false, posts: 0, navigationAccept: [] as string[] };
  const site = casSite(state);
  let webvpnLogins = 0;
  const fetchImpl = mockFetch((url, init) => {
    if (url.hostname !== 'webvpn.zju.edu.cn') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } });
    if (url.pathname === '/login') return respond(200, '<input name="_csrf" value="c">');
    if (url.pathname === '/do-login') {
      webvpnLogins++;
      assert.equal(new URLSearchParams(String(init.body)).get('username'), 'net-account');
      return respond(200, { success: true }, { 'set-cookie': 'wengine_vpn_ticketwebvpn_zju_edu_cn=ticket; Path=/' });
    }
    assert.match((init.headers as Headers).get('cookie') ?? '', /wengine_vpn_ticket/);
    const logical = fromWebvpnUrl(url)!;
    const response = site(logical, init);
    const location = response.headers.get('location');
    if (!location) return response;
    const headers = new Headers(response.headers);
    headers.set('location', toWebvpnUrl(new URL(location, logical)).toString());
    return new Response(null, { status: response.status, headers });
  });
  const { ctx } = await testContext(t, { env: { ...CREDS, WEBVPN_USERNAME: 'net-account', WEBVPN_PASSWORD: 'net-password' }, fetchImpl });
  const client = new XzzdClient(ctx);
  const session = await client.refreshSession();
  assert.equal(session.mode, 'webvpn');
  assert.equal(webvpnLogins, 1);
  assert.equal((await ctx.sessions.read('xzzd'))?.mode, 'webvpn');
  assert.match(await readFile(ctx.sessions.path('webvpn'), 'utf8'), /wengine_vpn_ticket/);
  const courses = await client.withSession(() => client.listCourses());
  assert.deepEqual(courses.courses, []);
  const last = fetchImpl.calls.at(-1)!;
  assert.equal(last.url.hostname, 'webvpn.zju.edu.cn');
});

test('WebVPN never falls back to the unified identity password', async t => {
  const fetchImpl = mockFetch(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } });
  });
  const { ctx } = await testContext(t, { env: CREDS, fetchImpl });
  await assert.rejects(() => new XzzdClient(ctx).refreshSession(), (e: any) => e.code === 'CONFIGURATION_REQUIRED' && e.details.account === 'webvpn');
  assert.ok(fetchImpl.calls.every(c => c.url.pathname !== '/do-login'));
});

test('an expired read refreshes once and retries only the read', async t => {
  const { ctx } = await testContext(t, { env: CREDS });
  const session = xzzdSession('old');
  await ctx.sessions.write(session);
  let refreshes = 0, reads = 0;
  const client = new XzzdClient(ctx, { authenticate: async () => { refreshes++; return session; } });
  const value = await client.withSession(async () => {
    if (++reads === 1) throw new ToolError('LOGIN_REQUIRED', 'expired');
    return 'read-result';
  });
  assert.equal(value, 'read-result');
  assert.equal(refreshes, 1);
  assert.equal(reads, 2);
});

test('a write is never replayed if login fails after the preflight', async t => {
  const { ctx } = await testContext(t, { env: CREDS });
  const session = xzzdSession('old');
  await ctx.sessions.write(session);
  let writes = 0, refreshes = 0;
  const client = new XzzdClient(ctx, { authenticate: async () => { refreshes++; return session; } });
  client.listCourses = async () => ({ courses: [] });
  await assert.rejects(() => client.withSession(async () => { writes++; throw new ToolError('LOGIN_REQUIRED', 'expired during write'); }, { readOnly: false }), (e: any) => e.code === 'LOGIN_REQUIRED');
  assert.equal(writes, 1);
  assert.equal(refreshes, 0);
});

test('without configured credentials a missing session is reported, not silently refreshed', async t => {
  const { ctx } = await testContext(t);
  let refreshes = 0;
  const client = new XzzdClient(ctx, { authenticate: async () => { refreshes++; return xzzdSession(); } });
  await assert.rejects(() => client.withSession(async () => 1), (e: any) => e.code === 'LOGIN_REQUIRED');
  assert.equal(refreshes, 0);
});
