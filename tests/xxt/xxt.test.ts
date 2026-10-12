import test from 'node:test';
import assert from 'node:assert/strict';
import { XxtClient } from '../../src/platforms/xxt/client.ts';
import { XxtReader, isPending, nearestDate, parseCourses, parseHomeworkDetail } from '../../src/platforms/xxt/reads.ts';
import { mockFetch, respond, testContext } from '../helpers.ts';

const COURSE_HTML = `<a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=111&clazzid=222&cpi=333&ismooc2=1"><span class="course-name" title="数据结构">数据结构</span></a><p class="overHidden2" title="">张老师</p>`;
const MIDDLE = '<input type="hidden" id="workEnc" value="WE"><input type="hidden" id="openc" value="OC"><input type="hidden" id="enc" value="PE">';
const WORKLIST = `<span>1/2</span></div></div>
<li onclick="goTask(this);" data="https%3A%2F%2Fmooc1.chaoxing.com%2Fmooc-ans%2Fmooc2%2Fwork%2Ftask%3Fid%3D1"><p class="overHidden2 fl">实验一</p><p class="status fl">已完成</p></li>
<li onclick="goTask(this);" data="https%3A%2F%2Fmooc1.chaoxing.com%2Fmooc-ans%2Fmooc2%2Fwork%2Ftask%3Fid%3D2"><p class="overHidden2 fl">实验二</p><p class="status fl">未交</p></li>`;
const DETAIL = '<title>作业详情</title><div>作业详情 实验二 题量: 3 满分: 100 作答时间: 10-01 08:00 至 10-20 23:59</div>';

test('course list, homework detail and status parsing follow the web pages', () => {
  assert.deepEqual(parseCourses(COURSE_HTML + COURSE_HTML), [{ name: '数据结构', teacher: '张老师', courseid: '111', clazzid: '222', cpi: '333' }]);
  assert.deepEqual(parseHomeworkDetail(DETAIL), { title: '实验二', question_count: 3, full_score: 100, start_time: '10-01 08:00', deadline: '10-20 23:59', score: null });
  assert.equal(isPending('待批阅'), false);
  assert.equal(isPending('未交'), true);
  assert.equal(nearestDate('01-05 23:59', new Date('2026-12-20T00:00:00Z')), '2027-01-05T23:59:00+08:00');
  assert.equal(nearestDate('02-30 08:00', new Date('2026-02-01T00:00:00Z')), null);
});

test('deadlines read only pending homework details and sort by due time', async t => {
  const fetchImpl = mockFetch(url => {
    if (url.hostname === 'i.chaoxing.com') return respond(200, 'var fid = \'427\'', { 'content-type': 'text/html' });
    if (url.pathname.endsWith('/courselistdata')) return respond(200, COURSE_HTML, { 'content-type': 'text/html' });
    if (url.pathname.endsWith('/stucoursemiddle')) return respond(200, MIDDLE, { 'content-type': 'text/html' });
    if (url.pathname.endsWith('/work/list')) {
      assert.equal(url.searchParams.get('enc'), 'WE');
      return respond(200, WORKLIST, { 'content-type': 'text/html' });
    }
    if (url.pathname.endsWith('/work/task')) {
      assert.equal(url.searchParams.get('id'), '2');
      return respond(200, DETAIL, { 'content-type': 'text/html' });
    }
    return respond(404, '');
  });
  const { ctx } = await testContext(t, { fetchImpl });
  const client = new XxtClient(ctx);
  await assert.rejects(() => client.get('https://i.chaoxing.com/base'), (e: any) => e.code === 'COOKIE_IMPORT_REQUIRED');
  const saved = await client.importCookie('Cookie: UID=1; _uid=1; fid=427; xxtenc=abc');
  assert.deepEqual(saved.missing_required, []);
  const reader = new XxtReader(client, () => new Date('2026-10-12T00:00:00Z'));
  const r = await reader.deadlines();
  assert.deepEqual(r.items, [{ course: '数据结构', title: '实验二', status: '未交', deadline: '2026-10-20T23:59:00+08:00' }]);
  assert.equal(fetchImpl.calls.filter(c => c.url.pathname.endsWith('/work/task')).length, 1);
  await assert.rejects(() => client.get('https://evil.example/x'), (e: any) => e.code === 'INVALID_PATH');
});

test('a login page response is reported as an expired cookie', async t => {
  const fetchImpl = mockFetch(() => respond(302, '', { location: 'https://passport2.chaoxing.com/login?refer=x' }));
  const { ctx } = await testContext(t, { fetchImpl });
  const client = new XxtClient(ctx);
  await client.importCookie('UID=1; _uid=1; fid=427');
  assert.deepEqual(await client.checkLogin(), { authenticated: false, reason: 'COOKIE_EXPIRED' });
});
