import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { PtaClient } from '../../src/platforms/pta/client.ts';
import { PtaReader, ptaId } from '../../src/platforms/pta/reads.ts';
import { mockFetch, respond, testContext } from '../helpers.ts';

const CURL = `curl 'https://pintia.cn/api/u/current' -H 'accept: application/json' -H 'cookie: PTASession=abc-123; _ga=GA1.1; JSESSIONID=xyz' --compressed`;

test('cookie import accepts a pasted cURL command and stores a private session without echoing values', async t => {
  const fetchImpl = mockFetch(() => respond(200, { user: { nickname: 'tester' } }));
  const { ctx } = await testContext(t, { fetchImpl });
  const pta = new PtaClient(ctx);
  assert.equal((await pta.status()).configured, false);
  await assert.rejects(() => pta.get('/api/problem-sets', {}, { requireCookie: true }), (e: any) => e.code === 'COOKIE_IMPORT_REQUIRED' && /pta-cookie/.test(e.details.setup_command));
  assert.equal(fetchImpl.calls.length, 0);
  const saved = await pta.importCookie(CURL);
  assert.deepEqual(saved, { source: 'curl 命令', cookie_names: ['PTASession', '_ga', 'JSESSIONID'] });
  assert.equal((await stat(ctx.sessions.path('pta'))).mode & 0o777, 0o600);
  const status = await pta.status();
  assert.equal(status.source, 'session');
  assert.doesNotMatch(JSON.stringify(status), /abc-123/);
  assert.deepEqual(await pta.check(), { authenticated: true, nickname: 'tester' });
  assert.equal(fetchImpl.calls[0].url.hostname, 'passport.pintia.cn');
  assert.match((fetchImpl.calls[0].init.headers as Headers).get('cookie')!, /PTASession=abc-123/);
  await assert.rejects(() => pta.importCookie('nothing useful'), (e: any) => e.code === 'INVALID_ARGUMENT');
  assert.match(await readFile(ctx.sessions.path('pta'), 'utf8'), /"domain": "pintia.cn"/);
});

test('public problem sets can be read without a cookie; protected ones ask for an import', async t => {
  const fetchImpl = mockFetch(url => (url.pathname.endsWith('/exams') ? respond(403, {}) : respond(200, { summaries: {} })));
  const { ctx } = await testContext(t, { fetchImpl });
  const pta = new PtaClient(ctx);
  assert.deepEqual(await pta.get('/api/problem-sets/12/problem-summaries'), { summaries: {} });
  assert.equal((fetchImpl.calls[0].init.headers as Headers).get('cookie'), null);
  await assert.rejects(() => pta.get('/api/problem-sets/99/exams'), (e: any) => e.code === 'COOKIE_IMPORT_REQUIRED');
});

test('requests stay on pintia.cn and expired cookies are explicit', async t => {
  let mode = 'expired';
  const fetchImpl = mockFetch(() => (mode === 'expired' ? respond(401, { error: { code: 'UNAUTHORIZED' } }) : respond(200, { error: { code: 'PROBLEM_SET_NOT_FOUND', message: 'x' } })));
  const { ctx } = await testContext(t, { fetchImpl });
  const pta = new PtaClient(ctx);
  await pta.importCookie('PTASession=abc; other=1');
  await assert.rejects(() => pta.get('https://evil.example/api/x'), (e: any) => e.code === 'INVALID_PATH');
  await assert.rejects(() => pta.get('/problem-sets'), (e: any) => e.code === 'INVALID_PATH');
  await assert.rejects(() => pta.get('/api/problem-sets'), (e: any) => e.code === 'COOKIE_EXPIRED');
  mode = 'error';
  await assert.rejects(() => pta.get('/api/problem-sets/1/exams'), (e: any) => e.code === 'PLATFORM_REJECTED');
  assert.throws(() => ptaId('1/../../x'), (e: any) => e.code === 'INVALID_ID');
});

function fakeApi(routes: Record<string, (q: Record<string, unknown>) => any>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  return {
    calls,
    get: async (path: string, query: Record<string, unknown> = {}) => {
      calls.push({ path, query });
      const route = routes[path];
      if (!route) throw new Error(`unexpected ${path}`);
      return route(query);
    },
  };
}

test('problem sets are filtered to active ones, merged with exam windows and sorted by deadline', async () => {
  const api = fakeApi({
    '/api/problem-sets': q => {
      assert.match(String(q.filter), /endAtAfter/);
      return { problemSets: [{ id: '11', name: '实验二', timeType: 'FIXED' }, { id: '10', name: '实验一' }] };
    },
    '/api/problem-sets/11/exams': () => ({ status: 'PROCESSING', exam: { startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-20T15:59:00Z', ended: false, score: 20 } }),
    '/api/problem-sets/10/exams': () => ({ status: 'PROCESSING', exam: { endAt: '2026-10-15T15:59:00Z', ended: false } }),
  });
  const r = await new PtaReader(api, () => new Date('2026-10-12T00:00:00Z')).problemSets();
  assert.deepEqual(r.problem_sets.map(s => s.id), ['10', '11']);
  assert.match(r.problem_sets[0].ends_at.shanghai!, /2026-10-15 23:59:00/);
  assert.equal(api.calls.every(c => !c.path.endsWith('/exams') || c.query && Object.keys(c.query).length === 0), true);
});

test('problem lists use zero-based pages and merge my submission status; problems are paged by characters', async () => {
  const api = fakeApi({
    '/api/problem-sets/11/problem-summaries': () => ({ summaries: { TRUE_OR_FALSE: { total: 5 }, CODE_COMPLETION: { total: 2 } } }),
    '/api/problem-sets/11/exam-problem-list': q => {
      assert.deepEqual([q.problem_type, q.page], ['CODE_COMPLETION', 0]);
      return { total: 2, problemSetProblems: [{ id: '501', label: '6-1', title: '求和', score: 10, deadline: '1970-01-01T00:00:00Z' }, { id: '502', label: '6-2', title: '排序', score: 15, problemStatus: 'NO_PROBLEM_STATUS' }] };
    },
    '/api/problem-sets/11/exam-problem-status': () => ({ problemStatus: [{ id: '501', problemSubmissionStatus: 'PROBLEM_ACCEPTED' }] }),
    '/api/problem-sets/11/exam-problems/501': () => ({ problemSetProblem: { id: '501', label: '6-1', title: '求和', type: 'CODE_COMPLETION', score: 10, content: '本题要求实现函数 $f(x)$。'.repeat(20), problemConfig: { codeCompletionProblemConfig: { timeLimit: 400, memoryLimit: 65536 } } }, organization: { name: '浙江大学' } }),
  });
  const reader = new PtaReader(api);
  const list = await reader.problems({ problem_set_id: '11' });
  assert.equal(list.type_label, '函数题');
  assert.deepEqual(list.problems.map(p => [p.label, p.my_status]), [['6-1', 'PROBLEM_ACCEPTED'], ['6-2', null]]);
  assert.equal(list.problems[0].deadline.raw, null);
  assert.equal(list.next_page, null);
  const p = await reader.problem({ problem_set_id: '11', problem_id: '501', max_characters: 50 });
  assert.equal(p.time_limit_ms, 400);
  assert.equal(p.organization, '浙江大学');
  assert.equal(p.next_offset, 50);
  assert.match(p.url, /type\/6\?problemSetProblemId=501/);
});
