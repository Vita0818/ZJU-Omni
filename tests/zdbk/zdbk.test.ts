import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { currentTerm, gpaOf, parseExamTime, parseExams, parseGrade, parseSession, termCode } from '../../src/platforms/zdbk/parse.ts';
import { ZdbkClient } from '../../src/platforms/zdbk/client.ts';
import { ZdbkReader } from '../../src/platforms/zdbk/reads.ts';
import { mockFetch, respond, testContext } from '../helpers.ts';

const CREDS = { ZJU_USERNAME: 'synthetic-account', ZJU_PASSWORD: 'synthetic-password', ZJU_NETWORK: 'direct' };

// Synthetic, de-identified samples shaped like the 正方 responses.
const GRADE_ITEMS = [
  { xkkh: '(2025-2026-1)-CS1001G-0000001-1', kcmc: '程序设计(甲)', xf: '3.0', cj: '95', jd: '5.0' },
  { xkkh: '(2025-2026-1)-MA1002G-0000002-1', kcmc: '微积分', xf: '5', cj: '85', jd: '4.2' },
  { xkkh: '(2025-2026-2)-PE0001G-0000003-1', kcmc: '体育', xf: '1', cj: '合格', jd: '' },
  { xkkh: '(2025-2026-2)-HI0001G-0000004-1', kcmc: '史纲', xf: '2', cj: '弃修', jd: '0' },
  { xkkh: '(2025-2026-2)-PH0001G-0000005-1', kcmc: '大学物理', xf: '4', cj: 'B+', jd: '3.9' },
  { xkkh: '(2025-2026-2)-EN0001G-0000006-1', kcmc: '英语', xf: '2', cj: '55', jd: '0' },
];

test('grades are parsed defensively and GPA follows the documented rules', () => {
  const rows = GRADE_ITEMS.map(parseGrade);
  assert.equal(rows[0].name, '程序设计（甲）');
  assert.equal(rows[0].course_code, 'CS1001G');
  assert.deepEqual([rows[0].academic_year, rows[0].semester], ['2025-2026', 1]);
  assert.equal(rows[2].counted_in_gpa, false);
  assert.equal(rows[3].counted_in_credits, false);
  const gpa = gpaOf(rows);
  assert.equal(gpa.gpa_credits, 14);
  assert.equal(gpa.gpa_5, Math.round(((5 * 3 + 4.2 * 5 + 3.9 * 4 + 0 * 2) / 14) * 1000) / 1000);
  assert.equal(gpa.gpa_4_3, Math.round(((4.3 * 3 + 4.0 * 5 + 3.9 * 4) / 14) * 1000) / 1000);
  assert.equal(gpa.earned_credits, 13);
  assert.equal(gpa.average_score, Math.round(((95 * 3 + 85 * 5 + 83 * 4 + 55 * 2) / 14) * 100) / 100);
  assert.throws(() => parseGrade({ kcmc: 'x' }), (e: any) => e.code === 'SCHEMA_CHANGED');
  assert.equal(gpaOf([]).gpa_5, null);
});

test('timetable blocks, weeks and periods are parsed; finished courses are skipped', () => {
  const session = parseSession({ kcb: '数据结构基础<br>秋冬<br>张老师<br>紫金港东1A-101zwf<br>', xqj: '2', djj: '3', skcd: '2', dsz: '0', xxq: '秋冬', sfqd: '1' })!;
  assert.deepEqual(
    { name: session.name, teacher: session.teacher, location: session.location, weekday: session.weekday, periods: session.periods, time: session.time, weeks: session.weeks, terms: session.terms },
    { name: '数据结构基础', teacher: '张老师', location: '紫金港东1A-101', weekday: 2, periods: [3, 4], time: '10:00-11:35', weeks: 'odd', terms: '秋冬' },
  );
  assert.equal(parseSession({ kcb: 'x<br>y', sfyjskc: '1', xqj: 1, djj: 1, skcd: 1 }), null);
  assert.throws(() => parseSession({ kcb: 'x<br>y<br>z<br>w', xqj: 'x', djj: 1, skcd: 1 }), (e: any) => e.code === 'SCHEMA_CHANGED');
});

test('exam times become explicit +08:00 timestamps and undated exams keep their label', () => {
  assert.deepEqual(parseExamTime('2026年01月15日(08:00-10:00)'), { start: '2026-01-15T08:00:00+08:00', end: '2026-01-15T10:00:00+08:00' });
  assert.deepEqual(parseExamTime('考试周第3天(14:00-16:00)'), { start: null, end: null });
  const exams = parseExams({ xkkh: '(2025-2026-1)-CS1001G-0000001-1', kcmc: '程序设计', xf: '3', qzkssj: '2025年11月05日(18:30-20:30)', qzjsmc: '东2-202', kssj: '考试周第3天(14:00-16:00)', jsmc: '', zwxh: '' });
  assert.deepEqual(exams.map(e => [e.type, e.start, e.location]), [['midterm', '2025-11-05T18:30:00+08:00', '东2-202'], ['final', null, null]]);
});

test('current term is inferred from the Shanghai date and mapped to xqm', () => {
  assert.deepEqual(currentTerm(new Date('2026-10-12T04:00:00Z')), { academic_year: '2026-2027', term: '秋' });
  assert.deepEqual(currentTerm(new Date('2026-12-20T04:00:00Z')), { academic_year: '2026-2027', term: '冬' });
  assert.deepEqual(currentTerm(new Date('2027-03-20T04:00:00Z')), { academic_year: '2026-2027', term: '春' });
  assert.deepEqual(currentTerm(new Date('2027-06-01T04:00:00Z')), { academic_year: '2026-2027', term: '夏' });
  assert.equal(termCode('冬'), '1|冬');
  assert.equal(termCode('夏'), '2|夏');
});

test('reader filters by semester, keeps undated upcoming exams and posts the timetable form', async () => {
  const posts: any[] = [];
  const api = {
    post: async (path: string, options: any = {}) => {
      posts.push({ path, ...options });
      if (path.includes('xscjcx')) return { items: GRADE_ITEMS };
      if (path.includes('xszgkc')) return { items: GRADE_ITEMS.slice(0, 2) };
      if (path.includes('kscx')) {
        return { items: [
          { xkkh: '(2025-2026-1)-A-1-1', kcmc: '已考', kssj: '2025年09月01日(08:00-10:00)' },
          { xkkh: '(2025-2026-1)-B-1-1', kcmc: '未排', kssj: '考试周第2天(08:00-10:00)' },
          { xkkh: '(2025-2026-1)-C-1-1', kcmc: '将考', kssj: '2026年01月10日(08:00-10:00)', jsmc: '西1-101', zwxh: '12' },
        ] };
      }
      return { kbList: [{ kcb: '课<br>秋<br>师<br>地zwf', xqj: 1, djj: 1, skcd: 2 }, { kcb: '旧<br>秋', sfyjskc: '1' }] };
    },
  };
  const reader = new ZdbkReader(api, () => new Date('2025-12-01T00:00:00Z'));
  const semesterOne = await reader.grades({ academic_year: '2025-2026', semester: 1 });
  assert.equal(semesterOne.grades.length, 2);
  assert.equal(semesterOne.summary.gpa_credits, 8);
  const summary = await reader.gpaSummary();
  assert.equal(summary.major?.gpa_credits, 8);
  assert.deepEqual(summary.semesters.map(s => s.semester), ['2025-2026-2', '2025-2026-1']);
  const exams = await reader.exams({ upcoming_only: true });
  assert.deepEqual(exams.exams.map(e => e.name), ['将考', '未排']);
  const table = await reader.timetable({ academic_year: '2025-2026', term: '秋' });
  assert.equal(table.sessions.length, 1);
  assert.equal(table.inferred_term, false);
  assert.deepEqual(posts.at(-1).form, { xnm: '2025-2026', xqm: '1|秋', captcha_value: '' });
  await assert.rejects(() => reader.grades({ academic_year: '2025' }), (e: any) => e.code === 'INVALID_ARGUMENT');
  const inferred = await reader.timetable();
  assert.deepEqual([inferred.academic_year, inferred.term, inferred.inferred_term], ['2025-2026', '冬', true]);
});

test('a non-empty but unrecognisable list is SCHEMA_CHANGED, not an empty result', async () => {
  const reader = new ZdbkReader({ post: async () => ({ items: [{ foo: 1 }] }) });
  await assert.rejects(() => reader.grades(), (e: any) => e.code === 'SCHEMA_CHANGED');
  const missing = new ZdbkReader({ post: async () => ({ rows: [] }) });
  await assert.rejects(() => missing.exams(), (e: any) => e.code === 'SCHEMA_CHANGED');
});

const keyPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const modulus = Buffer.from(jwk.n!, 'base64url').toString('hex');
const exponent = Buffer.from(jwk.e!, 'base64url').toString('hex');

test('ZDBK login uses the CAS service callback, upgrades http and keeps only ZDBK cookies', async t => {
  let posts = 0;
  const fetchImpl = mockFetch((url, init) => {
    const cookie = (init.headers as Headers).get('cookie') ?? '';
    if (url.hostname === 'zjuam.zju.edu.cn') {
      if (url.pathname === '/cas/v2/getPubKey') return respond(200, { modulus, exponent });
      if (init.method === 'POST') {
        posts++;
        return respond(302, '', [['location', 'http://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html?ticket=ST-1'], ['set-cookie', 'iPlanetDirectoryPro=sso; Domain=.zju.edu.cn; Path=/']]);
      }
      assert.equal(url.searchParams.get('service'), 'https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html');
      return respond(200, '<form id="fm1" action="/cas/login?service=x"><input name="execution" value="e"></form>');
    }
    assert.equal(url.protocol, 'https:');
    if (url.pathname.endsWith('login_ssologin.html')) return respond(302, '', [['location', '/jwglxt/xtgl/index_initMenu.html'], ['set-cookie', 'JSESSIONID=J1; Path=/jwglxt'], ['set-cookie', 'route=R1; Path=/']]);
    if (url.pathname.endsWith('index_initMenu.html')) return respond(200, '<html>教务</html>');
    if (url.pathname.endsWith('xscjcx_cxXscjIndex.html')) {
      assert.match(cookie, /JSESSIONID=J1/);
      return respond(200, { items: [], totalResult: 0 });
    }
    return respond(404);
  });
  const { ctx } = await testContext(t, { env: CREDS, fetchImpl });
  const client = new ZdbkClient(ctx);
  await client.refreshSession();
  assert.equal(posts, 1);
  const saved = await readFile(ctx.sessions.path('zdbk'), 'utf8');
  assert.match(saved, /JSESSIONID/);
  assert.match(saved, /route/);
  assert.doesNotMatch(saved, /iPlanetDirectoryPro|synthetic-password/);
});

test('ZDBK responses: captcha, login page, redirects and null timetables are classified', async t => {
  let mode = 'captcha';
  const fetchImpl = mockFetch(() => {
    if (mode === 'captcha') return respond(200, '"captcha_error"', { 'content-type': 'text/plain' });
    if (mode === 'login') return respond(200, '<html><form action="/cas/login"><input name="password"></form></html>', { 'content-type': 'text/html' });
    if (mode === 'redirect') return respond(302, '', { location: 'https://zjuam.zju.edu.cn/cas/login' });
    if (mode === 'busy-once') {
      mode = 'grades-ok';
      return { status: 922, headers: new Headers(), body: null } as unknown as Response;
    }
    if (mode === 'grades-ok') return respond(200, { items: [] });
    if (mode === '901') return { status: 901, headers: new Headers(), body: null } as unknown as Response;
    if (mode === 'null') return respond(200, 'null', { 'content-type': 'application/json' });
    return respond(200, '<html>maintenance</html>', { 'content-type': 'text/html' });
  });
  const { ctx } = await testContext(t, { fetchImpl });
  await ctx.sessions.write({ platform: 'zdbk', mode: 'direct', saved_at: 'now', cookies: [{ name: 'JSESSIONID', value: 'j', domain: 'zdbk.zju.edu.cn', path: '/', expires: -1, secure: true, httpOnly: true, hostOnly: true }] });
  const client = new ZdbkClient(ctx);
  const reader = new ZdbkReader(client);
  const run = <T>(fn: () => Promise<T>) => client.withSession(fn);
  await assert.rejects(() => run(() => reader.timetable({ academic_year: '2025-2026', term: '秋' })), (e: any) => e.code === 'AUTH_CHALLENGE_REQUIRED');
  mode = 'login';
  await assert.rejects(() => run(() => reader.grades()), (e: any) => e.code === 'LOGIN_REQUIRED');
  mode = 'redirect';
  await assert.rejects(() => run(() => reader.exams()), (e: any) => e.code === 'LOGIN_REQUIRED');
  mode = '901';
  await assert.rejects(() => run(() => reader.grades()), (e: any) => e.code === 'LOGIN_REQUIRED');
  mode = 'busy-once';
  client.retryDelayMs = 0;
  fetchImpl.calls.length = 0;
  assert.equal((await run(() => reader.grades())).grades.length, 0);
  assert.equal(fetchImpl.calls.length, 2);
  mode = 'null';
  assert.equal((await run(() => reader.timetable({ academic_year: '2025-2026', term: '夏' }))).sessions.length, 0);
  mode = 'other';
  await assert.rejects(() => run(() => reader.grades()), (e: any) => e.code === 'UNEXPECTED_RESPONSE');
});
