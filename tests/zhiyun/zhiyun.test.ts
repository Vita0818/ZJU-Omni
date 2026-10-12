import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { tokenFromCookies, ZhiyunClient } from '../../src/platforms/zhiyun/client.ts';
import { clock, ZhiyunReader } from '../../src/platforms/zhiyun/reads.ts';
import { mockFetch, respond, testContext } from '../helpers.ts';

const TOKEN_VALUE = encodeURIComponent('a:2:{i:0;s:6:"_token";i:1;s:12:"tok-abc-1234";}');
const tokenCookie = (domain = 'zju.edu.cn') => ({ name: '_token', value: TOKEN_VALUE, domain, path: '/', expires: -1, secure: false, httpOnly: true, hostOnly: false });

test('the classroom token is parsed from the PHP-serialised cookie', () => {
  assert.equal(tokenFromCookies([tokenCookie()]), 'tok-abc-1234');
  assert.equal(tokenFromCookies([{ ...tokenCookie(), value: 'plain' }]), null);
  assert.equal(clock(3725.6), '01:02:05');
});

function fakeApi(routes: Record<string, (q: Record<string, unknown>) => any>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  return {
    calls,
    profile: async () => ({ id: '7', account: '3200000000' }),
    get: async (url: string, query: Record<string, unknown> = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, query });
      const route = routes[path];
      if (!route) throw new Error(`unexpected ${path}`);
      return route(query);
    },
    image: async (url: string) => ({ bytes: Buffer.from(`img:${url}`), contentType: 'image/jpeg' }),
  };
}

test('my lectures cover the requested day range, deduplicate and accept map-shaped lists', async () => {
  const api = fakeApi({
    '/courseapi/v2/course-live/get-my-course-day': q => q.day === '2026-10-12'
      ? { code: 0, list: { a: { course: [{ id: 11, title: '数据结构', sub_id: 101, sub_title: '第5周 周一 3-4节', realname: '张老师', class_begin: 1791765600 }] } } }
      : { code: 0, list: [{ course: [{ id: 11, title: '数据结构', sub_id: 101, sub_title: 'dup' }, { id: 12, title: '微积分', sub_id: 102, sub_title: '第5周 周日' }] }] },
  });
  const reader = new ZhiyunReader(api, () => new Date('2026-10-12T04:00:00Z'));
  const r = await reader.myLectures({ days: 2 });
  assert.deepEqual(api.calls.map(c => c.query.day), ['2026-10-12', '2026-10-11']);
  assert.deepEqual(r.lectures.map(l => [l.sub_id, l.date]), [['101', '2026-10-12'], ['102', '2026-10-11']]);
  assert.match(r.lectures[0].begins_at!, /\+08:00$/);
  await assert.rejects(() => reader.myLectures({ date: '2026/10/12' }), (e: any) => e.code === 'INVALID_ARGUMENT');
});

test('course lectures are flattened from the nested year/month/week map and sorted', async () => {
  const api = fakeApi({
    '/courseapi/v3/multi-search/get-course-detail': q => {
      assert.equal(q.student, '3200000000');
      return { code: 0, data: { title: '数据结构', sub_list: { 2026: { 10: { 2: [{ id: 202, sub_title: '第二讲', class_begin: 1791800000 }], 1: [{ id: 201, sub_title: '第一讲', lecturer_name: '张老师', class_begin: 1791700000 }] } } } } };
    },
  });
  const r = await new ZhiyunReader(api, () => new Date('2026-10-12T04:00:00Z')).courseLectures({ course_id: 11 });
  assert.deepEqual(r.lectures.map(l => l.sub_id), ['201', '202']);
  assert.equal(r.lectures[0].teacher, '张老师');
});

test('transcripts are timestamped, paged by characters, and missing data is not an error', async () => {
  let mode = 'ok';
  const api = fakeApi({
    '/courseapi/v3/web-socket/search-trans-result': () => mode === 'none'
      ? { code: 10002, msg: '未查询到语音数据' }
      : { code: 0, list: [{ all_content: [{ BeginSec: 1.2, EndSec: 3, Text: '同学们好' }, { BeginSec: 65, EndSec: 70, Text: '今天讲链表' }, { BeginSec: 71, EndSec: 72, Text: '  ' }] }] },
  });
  const reader = new ZhiyunReader(api);
  const full = await reader.transcript({ sub_id: 101 });
  assert.equal(full.text, '[00:00:01] 同学们好\n[00:01:05] 今天讲链表');
  assert.equal(full.duration, '00:01:12');
  const page = await reader.transcript({ sub_id: 101, max_characters: 10 });
  assert.equal(page.next_offset, 10);
  const plain = await reader.transcript({ sub_id: 101, with_timestamps: false });
  assert.equal(plain.text, '同学们好\n今天讲链表');
  mode = 'none';
  const none = await reader.transcript({ sub_id: 101 });
  assert.equal(none.available, false);
});

test('PPT pages are de-duplicated across repeated pages and keep timing when present', async () => {
  const slide = (n: number, extra: Record<string, unknown> = {}) => ({ content: JSON.stringify({ pptimgurl: `http://img.cmc.zju.edu.cn/${n}.jpg`, ...extra }), created_sec: 1791700000 + n });
  const api = fakeApi({
    '/pptnote/v1/schedule/search-ppt': () => ({ code: 0, total: 3, list: [slide(1, { offset_sec: 30 }), slide(2), slide(2), slide(3)] }),
  });
  const reader = new ZhiyunReader(api);
  const r = await reader.slides({ course_id: 11, sub_id: 101 });
  assert.equal(r.slides.length, 3);
  assert.equal(r.complete, true);
  assert.equal(r.slides[0].offset, '00:00:30');
  assert.equal(r.slides[1].offset, null);
  assert.match(r.slides[0].captured_at!, /\+08:00$/);
  assert.equal(api.calls.length, 1);
  const root = await tempDirFor();
  const saved = await reader.downloadSlides({ course_id: 11, sub_id: 101, output_dir: root.dir });
  assert.equal(saved.counts.downloaded, 3);
  assert.deepEqual((await readdir(saved.directory)).sort(), ['0001.jpg', '0002.jpg', '0003.jpg']);
  const again = await reader.downloadSlides({ course_id: 11, sub_id: 101, output_dir: root.dir });
  assert.equal(again.counts.exists, 3);
  await root.cleanup();
});

async function tempDirFor() {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'zju-zhiyun-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('platform error codes surface as PLATFORM_REJECTED and missing lists as SCHEMA_CHANGED', async () => {
  const reader = new ZhiyunReader(fakeApi({
    '/pptnote/v1/searchlist': () => ({ code: 5, msg: '参数错误' }),
    '/courseapi/v3/multi-search/get-course-detail': () => ({ code: 0 }),
  }));
  await assert.rejects(() => reader.searchCourses({ keyword: 'x' }), (e: any) => e.code === 'PLATFORM_REJECTED');
  await assert.rejects(() => reader.courseLectures({ course_id: 1 }), (e: any) => e.code === 'SCHEMA_CHANGED');
});

const keyPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const modulus = Buffer.from(jwk.n!, 'base64url').toString('hex');
const exponent = Buffer.from(jwk.e!, 'base64url').toString('hex');

test('智云 login goes through tgmedia, stores the token cookie but not SSO cookies, and uses a Bearer token', async t => {
  let posts = 0;
  const fetchImpl = mockFetch((url, init) => {
    const headers = init.headers as Headers;
    if (url.hostname === 'zjuam.zju.edu.cn') {
      if (url.pathname === '/cas/v2/getPubKey') return respond(200, { modulus, exponent });
      if (init.method === 'POST') {
        posts++;
        return respond(302, '', [['location', 'http://tgmedia.cmc.zju.edu.cn/index.php?r=auth/login&ticket=ST-1'], ['set-cookie', 'iPlanetDirectoryPro=sso; Domain=.zju.edu.cn; Path=/']]);
      }
      return respond(200, '<form id="fm1" action="/cas/login?service=x"><input name="execution" value="e"></form>');
    }
    if (url.hostname === 'tgmedia.cmc.zju.edu.cn') {
      if (!url.searchParams.get('ticket')) return respond(302, '', { location: 'https://zjuam.zju.edu.cn/cas/login?service=http%3A%2F%2Ftgmedia.cmc.zju.edu.cn%2F' });
      return respond(302, '', [['location', 'https://classroom.zju.edu.cn/'], ['set-cookie', `_token=${TOKEN_VALUE}; Domain=.zju.edu.cn; Path=/`]]);
    }
    if (url.hostname === 'classroom.zju.edu.cn' && url.pathname === '/') return respond(200, '<html>classroom</html>', { 'content-type': 'text/html' });
    if (url.pathname === '/userapi/v1/infosimple') {
      assert.equal(headers.get('authorization'), 'Bearer tok-abc-1234');
      return respond(200, { code: 0, params: { id: 7, account: '3200000000' } });
    }
    return respond(404);
  });
  const { ctx } = await testContext(t, { env: { ZJU_USERNAME: 'u', ZJU_PASSWORD: 'p', ZJU_NETWORK: 'direct' }, fetchImpl });
  const client = new ZhiyunClient(ctx);
  await client.refreshSession();
  assert.equal(posts, 1);
  const saved = await readFile(ctx.sessions.path('zhiyun'), 'utf8');
  assert.match(saved, /_token/);
  assert.doesNotMatch(saved, /iPlanetDirectoryPro/);
  assert.deepEqual(await client.withSession(() => client.profile()), { id: '7', account: '3200000000' });
});

test('slide images are upgraded to HTTPS and fetched without cookies or tokens', async t => {
  const fetchImpl = mockFetch(() => respond(200, 'jpeg-bytes', { 'content-type': 'image/jpeg' }));
  const { ctx } = await testContext(t, { fetchImpl });
  await ctx.sessions.write({ platform: 'zhiyun', mode: 'direct', saved_at: 'now', cookies: [tokenCookie()] });
  const client = new ZhiyunClient(ctx);
  const image = await client.withSession(() => client.image('http://img.cmc.zju.edu.cn/1.jpg', 1024));
  assert.equal(image.bytes.toString(), 'jpeg-bytes');
  const call = fetchImpl.calls[0];
  assert.equal(call.url.protocol, 'https:');
  assert.equal((call.init.headers as Headers).get('cookie'), null);
  assert.equal((call.init.headers as Headers).get('authorization'), null);
  await assert.rejects(() => client.withSession(() => client.image('http://example.com/x.jpg', 1024)), (e: any) => e.code === 'UNSAFE_URL');
  await assert.rejects(() => client.withSession(() => client.get('https://evil.example/api')), (e: any) => e.code === 'INVALID_PATH');
});

test('expired tokens trigger LOGIN_REQUIRED', async t => {
  const fetchImpl = mockFetch(() => respond(200, { code: 401, msg: 'token expired' }));
  const { ctx } = await testContext(t, { fetchImpl });
  await ctx.sessions.write({ platform: 'zhiyun', mode: 'direct', saved_at: 'now', cookies: [tokenCookie()] });
  const client = new ZhiyunClient(ctx);
  await assert.rejects(() => client.withSession(() => client.profile()), (e: any) => e.code === 'LOGIN_REQUIRED');
});
