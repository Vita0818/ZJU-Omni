import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../../src/core/errors.ts';
import type { FetchImpl } from '../../src/core/http.ts';
import { SessionStore } from '../../src/core/store.ts';
import { courseCookies, XzzdClient } from '../../src/platforms/xzzd/client.ts';
import { CourseReader } from '../../src/platforms/xzzd/reads.ts';
import { CourseActions } from '../../src/platforms/xzzd/actions.ts';
import { baseEnv, connectServer, fingerprintFrom, mockFetch, respond, tempDir, testContext, xzzdCfg, xzzdSession } from '../helpers.ts';

async function fixture(t: TestContext, fetchImpl?: FetchImpl) {
  const { root, cfg, ctx } = await testContext(t, { fetchImpl });
  await ctx.sessions.write(xzzdSession());
  return { root, cfg, ctx };
}

async function actionFixture(t: TestContext) {
  const root = await tempDir(t);
  const dataDir = join(root, 'state');
  const store = new SessionStore(dataDir);
  await store.write(xzzdSession());
  const cfg = xzzdCfg(dataDir);
  const file = join(root, 'answer.txt');
  await writeFile(file, 'Original answer');
  const state = { list: [] as any[], calls: [] as any[], upload: 100, loseSubmissionResponse: false, verifyWrongFiles: false };
  const activity = { id: 10, course_id: 20, type: 'homework', title: '练习 1', is_closed: false, data: { allow_retract: true } };
  const client = {
    cfg,
    sessionFingerprint: fingerprintFrom(store),
    json: async (path: string, options: any) => {
      state.calls.push({ path, options });
      if (path === '/api/uploads') return { id: ++state.upload, created_by_id: 30, upload_url: 'https://courses.zju.edu.cn/storage' };
      if (path.endsWith('/submissions')) {
        state.list = [{ id: 40, is_draft: false, can_retract: true, uploads: options.body.uploads.map((id: number) => ({ id: state.verifyWrongFiles ? 999 : id, name: 'answer.txt' })) }];
        if (state.loseSubmissionResponse) throw new ToolError('OUTCOME_UNKNOWN', 'Simulated lost response');
        return {};
      }
      if (path.endsWith('/retract')) {
        state.list[0].is_draft = true;
        return {};
      }
      throw new Error('Unexpected mock route');
    },
    uploadBytes: async () => {
      state.calls.push({ path: 'storage-put' });
    },
  };
  const reader: any = {
    client,
    cfg,
    rawActivity: async () => activity,
    course: async () => ({ id: 20, name: 'Test Course' }),
    rawSubmissions: async () => ({ userId: '30', list: structuredClone(state.list) }),
    activityUrl: () => 'https://courses.zju.edu.cn/course/20/learning-activity/full-screen#/10',
    publicSubmission: (s: any) => s,
  };
  return { root, cfg, store, file, state, reader, activity, actions: new CourseActions(reader) };
}

test('MCP initializes, advertises 54 full tools, and reports missing login without leaking state', async t => {
  const dataDir = await tempDir(t);
  const client = await connectServer(t, baseEnv(dataDir));
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 54);
  for (const name of ['zju_auth_status', 'zju_auth_login', 'xzzd_list_all_assignments', 'xzzd_get_assignment', 'xzzd_prepare_draft', 'xzzd_save_draft', 'xzzd_download_submission_file', 'xzzd_search_course_content', 'xzzd_sync_course_materials']) {
    assert.ok(catalog.tools.some(tool => tool.name === name), name);
  }
  const byName = (name: string) => catalog.tools.find(tool => tool.name === name)!;
  assert.equal((byName('xzzd_prepare_submission').inputSchema.properties as any).file_paths.minItems, undefined);
  assert.equal(byName('xzzd_save_draft').annotations?.destructiveHint, true);
  assert.equal(byName('xzzd_submit_assignment').annotations?.destructiveHint, true);
  assert.equal(byName('xzzd_list_courses').annotations?.readOnlyHint, true);
  const status: any = await client.callTool({ name: 'zju_auth_status', arguments: {} });
  assert.ok(status.structuredContent.data.credentials.every((c: any) => !c.configured));
  assert.equal(status.structuredContent.data.platforms[0].session, null);
  const login: any = await client.callTool({ name: 'zju_auth_login', arguments: {} });
  assert.equal(login.structuredContent.error.code, 'CONFIGURATION_REQUIRED');
  assert.match(login.structuredContent.error.setup_command, /configure -- zju/);
  const result: any = await client.callTool({ name: 'xzzd_list_courses', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'LOGIN_REQUIRED');
  const invalid: any = await client.callTool({ name: 'xzzd_get_activity', arguments: { activity_id: '../etc' } });
  assert.equal(invalid.isError, true);
});

test('a stored session never leaks through tool output', async t => {
  const dataDir = await tempDir(t);
  await new SessionStore(dataDir).write(xzzdSession());
  const client = await connectServer(t, baseEnv(dataDir, { ZJU_NETWORK: 'direct' }));
  const status: any = await client.callTool({ name: 'zju_auth_status', arguments: {} });
  assert.equal(status.structuredContent.data.platforms[0].session.mode, 'direct');
  assert.doesNotMatch(JSON.stringify(status), /test-secret-not-real/);
});

test('parent-domain course sessions are retained but CAS credentials are excluded', () => {
  const cookie = (name: string, value: string, domain: string) => ({ name, value, domain, path: '/', expires: -1, secure: true, httpOnly: true, hostOnly: false });
  const cookies = courseCookies([cookie('session', 'course', 'zju.edu.cn'), cookie('iPlanetDirectoryPro', 'sso', 'zju.edu.cn'), cookie('other', 'unrelated', 'other.zju.edu.cn')]);
  assert.deepEqual(cookies.map(c => [c.name, c.domain, c.hostOnly]), [['session', 'courses.zju.edu.cn', true]]);
});

test('network errors are classified by action semantics and no write is retried', async t => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    throw Object.assign(new TypeError('secret URL'), { cause: { code: 'ECONNRESET' } });
  };
  const { ctx } = await fixture(t, fetchImpl);
  const client = new XzzdClient(ctx);
  const session = await client.loadSession();
  await assert.rejects(() => client.runWith(session, () => client.listCourses()), (e: any) => e.code === 'NETWORK_ERROR' && !e.message.includes('secret'));
  await assert.rejects(() => client.runWith(session, () => client.json('/api/uploads', { method: 'POST', body: {} })), (e: any) => e.code === 'OUTCOME_UNKNOWN');
  assert.equal(attempts, 2);
});

test('login redirects never become empty data', async t => {
  const fetchImpl = mockFetch(() => respond(302, 'login page body', { location: 'https://zjuam.zju.edu.cn/cas/login' }));
  const { ctx } = await fixture(t, fetchImpl);
  const client = new XzzdClient(ctx);
  await assert.rejects(() => client.withSession(() => client.json('/api/todos')), (e: any) => e.code === 'LOGIN_REQUIRED');
});

test('non-JSON pages and platform failure flags are explicit errors', async t => {
  let mode = 'html';
  const fetchImpl = mockFetch(() => (mode === 'html' ? respond(200, '<html>login</html>', { 'content-type': 'text/html' }) : respond(200, { success: false })));
  const { ctx } = await fixture(t, fetchImpl);
  const client = new XzzdClient(ctx);
  await assert.rejects(() => client.withSession(() => client.json('/api/todos')), (e: any) => e.code === 'UNEXPECTED_RESPONSE');
  mode = 'reject';
  await assert.rejects(() => client.withSession(() => client.json('/api/todos')), (e: any) => e.code === 'PLATFORM_REJECTED');
});

test('one logical operation stays on its original session if login changes concurrently', async t => {
  const { ctx } = await fixture(t);
  const client = new XzzdClient(ctx);
  const observed: string[] = [];
  const url = new URL('https://courses.zju.edu.cn/api/x');
  await client.withSession(async () => {
    observed.push(client.http().jar.header(url));
    await ctx.sessions.write(xzzdSession('new-session'));
    observed.push(client.http().jar.header(url));
  });
  await client.withSession(async () => observed.push(client.http().jar.header(url)));
  assert.deepEqual(observed, ['session=test-secret-not-real', 'session=test-secret-not-real', 'session=new-session']);
});

test('storage addresses require HTTPS and a configured destination', async t => {
  const { ctx } = await testContext(t);
  const client = new XzzdClient(ctx);
  for (const address of ['http://courses.zju.edu.cn/file', 'https://evil.example/file', 'https://127.0.0.1/file', 'https://user:secret@courses.zju.edu.cn/file']) {
    assert.throws(() => client.storageUrl(address), (e: any) => e.code === 'STORAGE_HOST_UNVERIFIED');
  }
  assert.match(client.storageUrl('https://courses.zju.edu.cn/file?token=hidden'), /^https:/);
});

test('storage redirects never receive the course cookie', async t => {
  const fetchImpl = mockFetch(url => {
    if (url.hostname === 'courses.zju.edu.cn') return respond(302, '', { location: 'https://storage.zju.edu.cn/blob?sig=1' });
    return respond(200, '%PDF', { 'content-type': 'application/pdf' });
  });
  const { ctx } = await fixture(t, fetchImpl);
  const client = new XzzdClient(ctx);
  const result = await client.withSession(() => client.downloadBytes('70'));
  assert.equal(result.bytes.toString(), '%PDF');
  assert.match((fetchImpl.calls[0].init.headers as Headers).get('cookie') ?? '', /session=/);
  assert.equal((fetchImpl.calls[1].init.headers as Headers).get('cookie'), null);
});

test('activities preserve server pagination even after type filtering', async () => {
  const client = { cfg: xzzdCfg('/tmp'), json: async () => ({ page: 1, pages: 2, total: 4, activities: [{ id: 1, course_id: 2, type: 'material' }] }) };
  const data = await new CourseReader(client).activities({ course_id: 2, page: 1, page_size: 2, type: 'notice' });
  assert.equal(data.next_page, 2);
  assert.equal(data.complete, false);
  assert.equal(data.activities.length, 0);
});

test('identity lookup never guesses the student from the record creator', async () => {
  const reader = new CourseReader({ cfg: xzzdCfg('/tmp'), json: async () => ({ activity_reads: [{ created_by_id: 99 }] }) });
  await assert.rejects(() => reader.currentUserId(20), (e: any) => e.code === 'IDENTITY_UNAVAILABLE');
});

test('preview makes no external writes and an unchanged submission verifies by its attachments', async t => {
  const f = await actionFixture(t);
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  assert.equal(f.state.calls.length, 0);
  const result = await f.actions.execute('submit', plan.plan_id);
  assert.equal(result.status, 'submitted');
  assert.equal(result.verified, true);
  const count = f.state.calls.length;
  await assert.rejects(() => new CourseActions(f.reader).execute('submit', plan.plan_id), (e: any) => e.code === 'PLAN_CONSUMED');
  assert.equal(f.state.calls.length, count);
});

test('a changed file cannot be uploaded under an old preview', async t => {
  const f = await actionFixture(t);
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  await writeFile(f.file, 'A different answer');
  await assert.rejects(() => f.actions.execute('submit', plan.plan_id), (e: any) => e.code === 'FILE_CHANGED');
  assert.equal(f.state.calls.length, 0);
});

test('a changed platform submission cancels the stale operation before any write', async t => {
  const f = await actionFixture(t);
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  f.state.list = [{ id: 88, is_draft: false }];
  await assert.rejects(() => f.actions.execute('submit', plan.plan_id), (e: any) => e.code === 'PLATFORM_STATE_CHANGED');
  assert.equal(f.state.calls.length, 0);
});

test('changing the login session invalidates an old preview', async t => {
  const f = await actionFixture(t);
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  await f.store.write(xzzdSession('different'));
  await assert.rejects(() => f.actions.execute('submit', plan.plan_id), (e: any) => e.code === 'SESSION_CHANGED');
  assert.equal(f.state.calls.length, 0);
});

test('session files and symlinks to them cannot be submitted', async t => {
  const f = await actionFixture(t);
  const alias = join(f.root, 'innocent.json');
  await symlink(f.store.path('xzzd'), alias);
  await assert.rejects(() => f.actions.prepare('submit', { activity_id: 10, file_paths: [alias] }), (e: any) => e.code === 'PRIVATE_STATE_FILE');
  assert.equal(f.state.calls.length, 0);
});

test('a lost submission response consumes the plan across process restarts', async t => {
  const f = await actionFixture(t);
  f.state.loseSubmissionResponse = true;
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  await assert.rejects(() => f.actions.execute('submit', plan.plan_id), (e: any) => e.code === 'OUTCOME_UNKNOWN');
  assert.equal(f.state.list[0].is_draft, false);
  const count = f.state.calls.length;
  await assert.rejects(() => new CourseActions(f.reader).execute('submit', plan.plan_id), (e: any) => e.code === 'PLAN_CONSUMED');
  assert.equal(f.state.calls.length, count);
});

test('HTTP acceptance without matching readback is reported as unverified', async t => {
  const f = await actionFixture(t);
  f.state.verifyWrongFiles = true;
  const plan = await f.actions.prepare('submit', { activity_id: 10, file_paths: [f.file] });
  const result = await f.actions.execute('submit', plan.plan_id);
  assert.equal(result.verified, false);
  assert.equal(result.status, 'accepted_unverified');
});

test('retraction targets the selected submission and verifies draft status', async t => {
  const f = await actionFixture(t);
  f.state.list = [{ id: 40, is_draft: false, can_retract: true, uploads: [] }];
  const plan = await f.actions.prepare('retract', { activity_id: 10, submission_id: 40 });
  assert.equal(f.state.calls.length, 0);
  const result = await f.actions.execute('retract', plan.plan_id);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'retracted');
});

test('downloads enforce activity membership, respect platform flags, and do not overwrite', async t => {
  const root = await tempDir(t);
  let downloads = 0;
  const activity = { id: 10, course_id: 20, uploads: [{ id: 70, name: '../../notes.pdf', allow_download: false }] };
  const reader = new CourseReader({
    cfg: xzzdCfg(join(root, 'state')),
    json: async () => activity,
    downloadBytes: async () => {
      downloads++;
      return { bytes: Buffer.from('%PDF-test'), contentType: 'application/pdf' };
    },
  });
  const args = { activity_id: 10, upload_id: 70, output_dir: join(root, 'downloads') };
  await assert.rejects(() => reader.download({ ...args, upload_id: 71 }), (e: any) => e.code === 'FILE_NOT_IN_ACTIVITY');
  await assert.rejects(() => reader.download(args), (e: any) => e.code === 'DOWNLOAD_NOT_ALLOWED');
  assert.equal(downloads, 0);
  activity.uploads[0].allow_download = true;
  const saved = await reader.download(args);
  assert.equal(saved.path, join(args.output_dir, '70-notes.pdf'));
  await assert.rejects(() => reader.download(args), (e: any) => e.code === 'FILE_EXISTS');
  assert.equal(await readFile(saved.path, 'utf8'), '%PDF-test');
});

test('the current user identity is fetched once per logical operation', async t => {
  let identityCalls = 0;
  const fetchImpl = mockFetch(url => {
    if (url.pathname === '/user/index') {
      identityCalls++;
      return respond(200, '<script>var globalData = { user: { id: 30 } };</script>', { 'content-type': 'text/html' });
    }
    return respond(404);
  });
  const { ctx } = await fixture(t, fetchImpl);
  const client = new XzzdClient(ctx);
  await client.withSession(async () => {
    assert.equal(await client.currentUserId(), '30');
    assert.equal(await client.currentUserId(), '30');
  });
  await client.withSession(() => client.currentUserId());
  assert.equal(identityCalls, 2);
});
