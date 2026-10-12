import test from 'node:test';
import assert from 'node:assert/strict';
import { CourseWorkflows, collectPages } from '../../src/platforms/xzzd/workflows.ts';
import { CourseReader } from '../../src/platforms/xzzd/reads.ts';
import { ToolError } from '../../src/core/errors.ts';
import { deadline } from '../../src/core/util.ts';
import { xzzdCfg } from '../helpers.ts';

function readerFixture() {
  const calls: any[] = [];
  const courses = [{ id: 10, name: 'A' }, { id: 20, name: 'B' }];
  const assignments: Record<number, any[]> = {
    10: [
      { id: 101, title: 'submitted', course_id: 10, submission_status: 'submitted', deadline: deadline('2026-09-24T00:00:00Z') },
      { id: 102, title: 'draft', course_id: 10, submission_status: 'draft', deadline: deadline('2026-09-21T00:00:00Z') },
    ],
    20: [
      { id: 201, title: 'missing', course_id: 20, submission_status: 'unsubmitted', deadline: deadline('2026-09-20T00:00:00Z') },
      { id: 202, title: 'unavailable', course_id: 20, submission_status: 'unknown', deadline: deadline('2026-09-19 12:00:00'), submission_error: { code: 'FORBIDDEN' } },
    ],
  };
  const reader: any = {
    courses: async (args: any) => {
      calls.push(args);
      return { courses, next_page: null };
    },
    course: async (courseId: unknown) => {
      const course = courses.find(c => String(c.id) === String(courseId));
      if (!course) throw new ToolError('FORBIDDEN', 'No access');
      return course;
    },
    assignments: async ({ course_id, page }: any) => ({ assignments: [assignments[course_id][page - 1]], next_page: page < 2 ? page + 1 : null }),
    activities: async () => ({ activities: [], next_page: null }),
  };
  return { calls, reader, assignments, workflows: new CourseWorkflows(reader) };
}

test('multi-course assignment scan traverses pages and includes unknowns in pending', async () => {
  const f = readerFixture();
  const result = await f.workflows.assignments({ status: 'pending', semester_id: 85 });
  assert.equal(f.calls[0].semester_id, 85);
  assert.deepEqual(result.assignments.map(a => a.id), [201, 102, 202]);
  assert.equal(result.assignments.at(-1)!.overdue, null);
  assert.deepEqual(result.counts, { submitted: 0, unsubmitted: 1, draft: 1, unknown: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].activity_id, 202);
});

test('result pagination is separate from source coverage and dates require explicit timezones', async () => {
  const f = readerFixture();
  const result = await f.workflows.assignments({ course_ids: [10], limit: 1 });
  assert.equal(result.complete, true);
  assert.equal(result.next_offset, 1);
  assert.equal(result.matched_count, 2);
  const second = await f.workflows.assignments({ course_ids: [10], limit: 1, offset: 1 });
  assert.equal(second.assignments[0].id, 101);
  assert.equal(second.next_offset, null);
  await assert.rejects(() => f.workflows.assignments({ due_before: '2026-09-21 12:00:00' }), (e: any) => e.code === 'INVALID_DATE');
  const filtered = await f.workflows.assignments({ due_before: '2026-09-22T00:00:00Z' });
  assert.deepEqual(filtered.assignments.map(a => a.id), [201, 102]);
  assert.equal(filtered.excluded_unknown_deadlines, 1);
});

test('course failures and scan limits cannot produce complete empty results', async () => {
  const f = readerFixture();
  const limited = await f.workflows.assignments({ max_courses: 1, max_pages: 1 });
  assert.equal(limited.complete, false);
  assert.deepEqual(limited.course_continuation?.course_ids, [20]);
  assert.equal(limited.continuations[0].next_page, 2);
  const failed = await f.workflows.assignments({ course_ids: [99] });
  assert.equal(failed.complete, false);
  assert.equal(failed.errors[0].course_id, '99');
  await assert.rejects(() => f.workflows.assignments({ course_ids: [10], semester_id: 85 }), (e: any) => e.code === 'INVALID_SCOPE');
});

test('a repeated upstream page is detected instead of looping or silently truncating', async () => {
  await assert.rejects(() => collectPages(async ({ page }) => ({ rows: [{ id: 1 }], next_page: page + 1 }), 'rows'), (e: any) => e.code === 'PAGINATION_STALLED');
  await assert.rejects(() => collectPages(async ({ page }) => ({ rows: [], next_page: page }), 'rows'), (e: any) => e.code === 'PAGINATION_STALLED');
});

test('per-assignment lookup errors are preserved alongside successful submission enrichment', async () => {
  const client = {
    cfg: xzzdCfg('/tmp'),
    currentUserId: async () => '30',
    json: async (path: string) => {
      if (path.endsWith('/homework-activities')) return { page: 1, pages: 1, homework_activities: [{ id: 101, course_id: 10 }, { id: 102, course_id: 10 }] };
      if (path.includes('/101/')) return { list: [{ id: 70, is_draft: false, score: 0, uploads: [] }] };
      throw new ToolError('FORBIDDEN', 'Hidden');
    },
  };
  const result = await new CourseReader(client).assignments({ course_id: 10, include_submissions: true });
  assert.equal(result.assignments[0].latest_submission.score, 0);
  assert.equal(result.assignments[1].submission_status, 'unknown');
  assert.equal(result.assignments[1].submission_error.code, 'FORBIDDEN');
});

test('search covers titles, filenames and bodies and reports detail-read failures', async () => {
  const f = readerFixture();
  f.reader.activities = async ({ course_id }: any) => ({
    activities: [
      { id: course_id * 10 + 1, course_id, title: 'Lab notes', type: 'material', files: [] },
      { id: course_id * 10 + 2, course_id, title: 'Exercises', type: 'homework', files: [{ id: 77, name: 'Lab.pdf' }] },
    ],
    next_page: null,
  });
  f.reader.rawActivity = async (activityId: number) => {
    if (activityId === 202) throw new ToolError('FORBIDDEN', 'Hidden');
    return { id: activityId, description: '<p>Find the eigenvalue of the matrix.</p>', uploads: [] };
  };
  let result = await f.workflows.search({ keyword: 'EIGENVALUE', limit: 2 });
  assert.equal(result.matched_count, 3);
  assert.equal(result.results.length, 2);
  assert.equal(result.next_offset, 2);
  assert.equal(result.complete, false);
  assert.match(result.results[0].excerpt, /eigenvalue/);
  result = await f.workflows.search({ keyword: 'lab', include_body: false });
  assert.equal(result.matched_count, 4);
  assert.equal(result.complete, true);
  assert.deepEqual(result.results[1].matched_fields, ['file_name']);
  result = await f.workflows.search({ keyword: 'lab', include_body: false, max_activities: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.activities_scanned, 1);
});

test('scans default to the active semester and all_semesters widens the scope', async () => {
  const f = readerFixture();
  f.reader.semesters = async () => ({ semesters: [{ id: 85, is_active: true }, { id: 84, is_active: false }] });
  const active = await f.workflows.assignments({});
  assert.deepEqual(f.calls.map(c => c.semester_id), ['85']);
  assert.deepEqual(active.scope.semesters, { mode: 'active', semester_ids: ['85'] });
  f.calls.length = 0;
  const all = await f.workflows.assignments({ all_semesters: true });
  assert.deepEqual(f.calls.map(c => c.semester_id), [undefined]);
  assert.equal(all.scope.semesters.mode, 'all');
  f.reader.semesters = async () => ({ semesters: [{ id: 84, is_active: false }] });
  f.calls.length = 0;
  assert.equal((await f.workflows.assignments({})).scope.semesters.mode, 'all');
});
