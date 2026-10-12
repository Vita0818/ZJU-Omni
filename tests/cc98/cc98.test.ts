import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Cc98Client } from '../../src/platforms/cc98/client.ts';
import { Cc98Reader } from '../../src/platforms/cc98/reads.ts';
import { Cc98Actions } from '../../src/platforms/cc98/actions.ts';
import { ubbToText } from '../../src/platforms/cc98/ubb.ts';
import { fromWebvpnUrl } from '../../src/auth/webvpn.ts';
import { mockFetch, respond, testContext } from '../helpers.ts';

const CREDS = { CC98_USERNAME: 'tester', CC98_PASSWORD: 'cc98-secret', ZJU_NETWORK: 'direct' };

function forum(state: { tokens: number; refreshes: number; posts: any[]; writes: any[]; me?: string; failLogin?: boolean }) {
  return (url: URL, init: RequestInit) => {
    const auth = (init.headers as Headers).get('authorization');
    if (url.hostname === 'openid.cc98.org') {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get('client_id'), '9a1fd200-8687-44b1-4c20-08d50a96e5cd');
      if (form.get('grant_type') === 'password') {
        state.tokens++;
        if (state.failLogin) return respond(400, { error: 'invalid_grant' });
        assert.equal(form.get('password'), 'cc98-secret');
        return respond(200, { access_token: `tok${state.tokens}`, refresh_token: 'refresh-1', expires_in: 3600 });
      }
      state.refreshes++;
      return respond(200, { access_token: 'tok-refreshed', expires_in: 3600 });
    }
    if (url.pathname === '/config/index') {
      assert.equal(auth, null);
      return respond(200, { hotTopic: [{ id: 1, title: '十大一', boardName: '心灵之约' }] });
    }
    if (!auth?.startsWith('Bearer tok')) return respond(401, '');
    if (url.pathname === '/me') return respond(200, { id: 7, name: state.me ?? 'tester' });
    if (url.pathname === '/topic/search') return respond(200, [{ id: 42, title: '选课求助', boardName: '学习天地', userName: 'a', replyCount: 2, time: '2026-10-12T10:00:00+08:00' }]);
    if (url.pathname === '/topic/42' && init.method === 'GET') return respond(200, { id: 42, title: '选课求助', boardName: '学习天地', replyCount: state.posts.length - 1, state: 0 });
    if (url.pathname === '/Topic/42/post') {
      const from = Number(url.searchParams.get('from'));
      const size = Number(url.searchParams.get('size'));
      return respond(200, state.posts.slice(from, from + size).map(p => ({ ...p, length: state.posts.length })));
    }
    if (url.pathname === '/topic/42/post' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      state.writes.push(body);
      state.posts.push({ id: 900 + state.posts.length, floor: state.posts.length + 1, userName: 'tester', content: body.content, contentType: 0 });
      return respond(200, '');
    }
    if (url.pathname === '/user/name/friend') return respond(200, { id: 8, name: 'friend' });
    if (url.pathname === '/message' && init.method === 'POST') {
      state.writes.push(JSON.parse(String(init.body)));
      return respond(200, '');
    }
    if (url.pathname === '/message/user/8') return respond(200, state.writes.filter(w => w.receiverId).map((w, i) => ({ id: i + 1, senderId: 7, receiverId: 8, content: w.content })));
    return respond(404, '');
  };
}

test('UBB is flattened to compact text', () => {
  assert.equal(ubbToText('[b]你好[/b][img]https://x/1.png[/img][quote]原文[/quote][ac01]'), '你好[图片: https://x/1.png]\n> [引用] 原文\n[表情]');
});

test('password grant runs once, tokens are stored privately and reads use the bearer token', async t => {
  const state = { tokens: 0, refreshes: 0, posts: [{ id: 1, floor: 1, userName: 'a', content: '[b]求助[/b]', contentType: 0 }], writes: [] };
  const fetchImpl = mockFetch(forum(state));
  const { ctx } = await testContext(t, { env: CREDS, fetchImpl });
  const client = new Cc98Client(ctx);
  const reader = new Cc98Reader(client);
  const found = await reader.search({ keyword: '选课' });
  assert.equal(found.topics[0].id, 42);
  const topic = await reader.topic({ topic_id: 42 });
  assert.equal(topic.posts[0].text, '求助');
  assert.equal(state.tokens, 1);
  assert.equal((await stat(ctx.sessions.path('cc98'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(ctx.sessions.path('cc98'), 'utf8'), /cc98-secret/);
  const hot = await reader.hot({ range: 'today' });
  assert.equal(hot.topics[0].title, '十大一');
  const stored = await ctx.sessions.read('cc98');
  await ctx.sessions.write({ ...stored!, data: { ...stored!.data, expires_at: 0 } });
  await reader.search({ keyword: '选课' });
  assert.equal(state.refreshes, 1);
  assert.equal(state.tokens, 1);
});

test('rejected CC98 credentials are not resubmitted by later automatic calls', async t => {
  const state = { tokens: 0, refreshes: 0, posts: [], writes: [], failLogin: true };
  const { ctx } = await testContext(t, { env: CREDS, fetchImpl: mockFetch(forum(state)) });
  const reader = new Cc98Reader(new Cc98Client(ctx));
  await assert.rejects(() => reader.search({ keyword: 'x' }), (e: any) => e.code === 'AUTHENTICATION_REQUIRED');
  await assert.rejects(() => reader.search({ keyword: 'x' }), (e: any) => e.code === 'AUTHENTICATION_REQUIRED' && /不再自动重试/.test(e.message));
  assert.equal(state.tokens, 1);
});

test('reply is previewed without writing, executed once, and verified by reading the latest floors', async t => {
  const state = { tokens: 0, refreshes: 0, posts: [{ id: 1, floor: 1, userName: 'a', content: '求助', contentType: 0 }], writes: [] as any[], me: 'tester' };
  const { ctx, cfg } = await testContext(t, { env: CREDS, fetchImpl: mockFetch(forum(state)) });
  const client = new Cc98Client(ctx);
  const actions = new Cc98Actions(client, cfg.dataDir);
  const plan = await actions.prepareReply({ topic_id: 42, content: '建议先看培养方案。' });
  assert.equal(plan.topic, '选课求助');
  assert.equal(state.writes.length, 0);
  const result = await actions.reply(plan.plan_id);
  assert.equal(result.verified, true);
  assert.equal(result.floor, 2);
  assert.deepEqual(state.writes[0], { title: '', content: '建议先看培养方案。', contentType: 0 });
  await assert.rejects(() => actions.reply(plan.plan_id), (e: any) => e.code === 'PLAN_CONSUMED');
  assert.equal(state.writes.length, 1);
  const second = await actions.prepareReply({ topic_id: 42, content: '另一条' });
  state.me = 'someone-else';
  await assert.rejects(() => actions.reply(second.plan_id), (e: any) => e.code === 'IDENTITY_CHANGED');
  assert.equal(state.writes.length, 1);
  await assert.rejects(() => actions.prepareReply({ topic_id: 42, content: '   ' }), (e: any) => e.code === 'EMPTY_CONTENT');
});

test('private messages resolve the recipient by name and verify from the conversation', async t => {
  const state = { tokens: 0, refreshes: 0, posts: [], writes: [] as any[] };
  const { ctx, cfg } = await testContext(t, { env: CREDS, fetchImpl: mockFetch(forum(state)) });
  const actions = new Cc98Actions(new Cc98Client(ctx), cfg.dataDir);
  const plan = await actions.prepareMessage({ user_name: 'friend', content: '明天图书馆见' });
  assert.equal(plan.to_user_id, 8);
  assert.equal(state.writes.length, 0);
  const result = await actions.sendMessage(plan.plan_id);
  assert.equal(result.verified, true);
  assert.deepEqual(state.writes, [{ receiverId: 8, content: '明天图书馆见' }]);
});

test('CC98 goes through WebVPN when the API is unreachable directly', async t => {
  const state = { tokens: 0, refreshes: 0, posts: [], writes: [] };
  const site = forum(state);
  const fetchImpl = mockFetch((url, init) => {
    if (url.hostname !== 'webvpn.zju.edu.cn') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } });
    if (url.pathname === '/login') return respond(200, '<input name="_csrf" value="c">');
    if (url.pathname === '/do-login') return respond(200, { success: true }, { 'set-cookie': 'wengine_vpn_ticketwebvpn_zju_edu_cn=t; Path=/' });
    return site(fromWebvpnUrl(url)!, init);
  });
  const { ctx } = await testContext(t, { env: { CC98_USERNAME: 'tester', CC98_PASSWORD: 'cc98-secret', ZJU_USERNAME: 'z', ZJU_PASSWORD: 'p' }, fetchImpl });
  const r = await new Cc98Reader(new Cc98Client(ctx)).search({ keyword: '选课' });
  assert.equal(r.topics.length, 1);
  assert.ok(fetchImpl.calls.some(c => c.url.hostname === 'webvpn.zju.edu.cn' && fromWebvpnUrl(c.url)?.hostname === 'api.cc98.org'));
});
