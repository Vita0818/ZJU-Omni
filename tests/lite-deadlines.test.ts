import test from 'node:test';
import assert from 'node:assert/strict';
import { beijing, mergeDeadlines, remaining } from '../src/lite/deadlines.ts';

test('deadlines from all sources are merged into one Beijing-time list: upcoming, overdue, unknown', () => {
  const now = new Date('2026-10-12T04:00:00Z');
  const merged = mergeDeadlines([
    { source: '学在浙大', course: '大学物理', title: '第四次作业', due_iso: '2026-10-24T15:59:00Z', status: '未交', activity_id: 1 },
    { source: '拼题A', title: 'HW4', due_iso: '2026-10-13T04:00:00Z', status: '未完成', solved: '0/7', problem_set_id: '9' },
    { source: '拼题A', title: 'P2', due_iso: '2026-10-20T15:00:00Z', status: '未完成' },
    { source: '学在浙大', course: '实验', title: '旧报告', due_iso: '2026-10-01T15:59:00Z', status: '未交' },
    { source: '学在浙大', course: '实验', title: '更旧的报告', due_iso: '2026-09-20T15:59:00Z', status: '未交' },
    { source: '学习通', course: '数据结构', title: '无截止', due_iso: null, status: '未交' },
  ], now);
  assert.deepEqual(merged.map(m => m.title), ['HW4', 'P2', '第四次作业', '旧报告', '更旧的报告', '无截止']);
  assert.deepEqual(merged.map(m => m.no), [1, 2, 3, 4, 5, 6]);
  assert.equal(merged[0].due, '2026-10-13 12:00 周二');
  assert.equal(merged[0].overdue, undefined);
  assert.equal(merged[0].left, '还剩 1 天');
  assert.equal(merged[0].urgent, true);
  assert.equal(merged[1].urgent, undefined);
  assert.equal(merged[3].urgent, undefined);
  assert.equal(merged[3].left, '已过期 10 天');
  assert.equal(merged[5].left, undefined);
  assert.equal(remaining('2026-10-12T11:30:00Z', now), '还剩 7 小时');
  assert.equal(remaining('2026-10-14T07:00:00Z', now), '还剩 2 天 3 小时');
  assert.equal(remaining('2026-10-12T04:20:00Z', now), '还剩 20 分钟');
  assert.equal(merged[3].overdue, true);
  assert.equal(merged[5].due, '截止时间未知');
  assert.equal(beijing('2026-10-12T04:00:00Z', false), '2026-10-12 周一');
});
