import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionStore } from '../../src/core/store.ts';
import { identityFromPage } from '../../src/platforms/xzzd/client.ts';
import { filesOf, submissionState } from '../../src/platforms/xzzd/shared.ts';
import { CourseReader } from '../../src/platforms/xzzd/reads.ts';
import { CourseActions } from '../../src/platforms/xzzd/actions.ts';
import { fingerprintFrom, tempDir, xzzdCfg, xzzdSession } from '../helpers.ts';

async function fixture(t: TestContext) {
  const root = await tempDir(t, 'zju-homework-');
  const dataDir = join(root, 'state');
  const store = new SessionStore(dataDir);
  await store.write(xzzdSession('synthetic'));
  const cfg = xzzdCfg(dataDir);
  const state = {
    activity: { id: 10, course_id: 20, type: 'homework', title: 'Homework', is_closed: false, data: { mode: 'normal', allow_retract: true } } as any,
    list: [] as any[],
    calls: [] as string[],
    group: { id: 50, name: 'Team' } as any,
    nextId: 100,
    writes: [] as any[],
    ignoreWrite: false,
    wrongComment: false,
  };
  const client = {
    cfg,
    sessionFingerprint: fingerprintFrom(store),
    currentUserId: async () => '30',
    uploadBytes: async () => {},
    downloadBytes: async () => ({ bytes: Buffer.from('answer'), contentType: 'text/plain' }),
    async json(path: string, options: any = {}) {
      state.calls.push(path);
      if (path === '/api/activities/10') return structuredClone(state.activity);
      if (path === '/api/courses/20') return { id: 20, name: 'Course' };
      if (path === '/api/group-sets/60/group') return { group: structuredClone(state.group) };
      if (/\/submission_list$/.test(path)) return { list: structuredClone(state.list) };
      state.writes.push({ path, ...options });
      if (path === '/api/uploads') return { id: ++state.nextId, upload_url: cfg.baseUrl + '/file', created_by_id: 30 };
      if (path === '/api/course/activities/10/submissions') {
        if (state.ignoreWrite) return {};
        const body = options.body;
        const row = {
          id: options.method === 'PUT' ? body.submission_id : ++state.nextId,
          is_draft: body.is_draft,
          is_latest_version: true,
          uploads: body.uploads.map((id: number) => ({ id, name: 'answer.txt' })),
          comment: state.wrongComment ? 'Different answer' : body.comment,
          can_retract: true,
        };
        state.list = state.list.filter(s => s.id !== row.id).map(s => ({ ...s, is_latest_version: false }));
        state.list.unshift(row);
        return { submission: row };
      }
      if (/\/retract$/.test(path)) {
        state.list[0].is_draft = true;
        return {};
      }
      throw new Error('Unexpected test route: ' + path);
    },
  };
  const reader = new CourseReader(client);
  const actions = new CourseActions(reader);
  const file = join(root, 'answer.txt');
  await writeFile(file, 'answer');
  return { root, cfg, state, reader, actions, file };
}

test('identity comes from the server identity script, not arbitrary HTML or activity readers', () => {
  const page = '<div>user: {id:999}</div><script>var globalData = { user: { id: 30, name: "Test" }, other: 1 };</script>';
  assert.equal(identityFromPage(page), '30');
  assert.throws(() => identityFromPage(page + page), (e: any) => e.code === 'IDENTITY_UNAVAILABLE');
  assert.throws(() => identityFromPage('<script type="text/ng-template">var globalData={user:{id:99}}</script>'), (e: any) => e.code === 'IDENTITY_UNAVAILABLE');
  assert.throws(() => identityFromPage('<script>var other = {user:{id:99}}</script>'), (e: any) => e.code === 'IDENTITY_UNAVAILABLE');
});

test('a new course with no reading records can query its owner submissions', async t => {
  const f = await fixture(t);
  const result = await f.reader.submissions({ activity_id: 10 });
  assert.equal(result.submission_status, 'unsubmitted');
  assert.ok(f.state.calls.includes('/api/activities/10/students/30/submission_list'));
  assert.ok(!f.state.calls.some(p => p.includes('activity-reads')));
});

test('nested activity files are merged and denied download references stay denied', () => {
  const files = filesOf({ uploads: [], data: { uploads: [{ id: 1, allow_download: false }], files: [{ id: 1, name: 'notes', allow_download: true }, { id: 2 }] } });
  assert.equal(files.length, 2);
  assert.equal(files[0].allow_download, false);
});

test('submission classification distinguishes redo, drafts and instructor placeholders', () => {
  assert.equal(submissionState([{ id: 1, is_draft: true, is_latest_version: true }, { id: 2, is_draft: false }]), 'draft');
  assert.equal(submissionState([{ id: 1, is_draft: false, is_redo: true }]), 'draft');
  assert.equal(submissionState([{ id: 1, is_draft: false, submit_by_instructor: true, marked_submitted: false }]), 'unknown');
  assert.equal(submissionState([{ id: 1, is_draft: false, submit_by_instructor: true, marked_submitted: true }]), 'submitted');
});

test('text-only submission is previewed without uploads and verified against exact text', async t => {
  const f = await fixture(t);
  const text = 'x < 3 && y > 1\n  return x';
  const plan = await f.actions.prepare('submit', { activity_id: 10, comment: text });
  assert.equal(f.state.writes.length, 0);
  assert.equal(plan.comment, text);
  const result = await f.actions.execute('submit', plan.plan_id);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'submitted');
  assert.equal(f.state.writes.length, 1);
  assert.deepEqual(f.state.writes[0].body.uploads, []);
  assert.match(f.state.writes[0].body.comment, /&lt;/);
});

test('empty content is rejected before any platform write', async t => {
  const f = await fixture(t);
  for (const kind of ['submit', 'draft'] as const) {
    await assert.rejects(() => f.actions.prepare(kind, { activity_id: 10, comment: '  ' }), (e: any) => e.code === 'EMPTY_SUBMISSION');
  }
  assert.equal(f.state.writes.length, 0);
});

test('saving a new draft uses POST and retains draft state on readback', async t => {
  const f = await fixture(t);
  const plan = await f.actions.prepare('draft', { activity_id: 10, file_paths: [f.file], comment: 'draft' });
  const result = await f.actions.execute('draft', plan.plan_id);
  assert.equal(result.status, 'draft_saved');
  assert.equal(result.verified, true);
  assert.equal(f.state.writes.at(-1).method, 'POST');
  assert.equal(f.state.writes.at(-1).body.is_draft, true);
});

test('editing and finalizing a draft keeps its ID, attachments and omitted comment', async t => {
  const f = await fixture(t);
  f.state.list = [{ id: 40, is_draft: true, uploads: [{ id: 70, name: 'old.pdf' }], comment: '<p>original</p>' }];
  const edit = await f.actions.prepare('draft', { activity_id: 10, submission_id: 40, comment: 'revised' });
  assert.equal((edit.retained_files as any[])[0].id, 70);
  assert.equal((await f.actions.execute('draft', edit.plan_id)).verified, true);
  assert.equal(f.state.writes.at(-1).method, 'PUT');
  assert.equal(f.state.writes.at(-1).body.submission_id, 40);
  const submit = await f.actions.prepare('submit', { activity_id: 10, submission_id: 40 });
  assert.equal(submit.comment, 'revised');
  assert.equal((await f.actions.execute('submit', submit.plan_id)).verified, true);
  assert.deepEqual(f.state.writes.at(-1).body.uploads, [70]);
  assert.equal(f.state.writes.at(-1).body.is_draft, false);
});

test('draft attachment selection can replace files but cannot reference arbitrary uploads', async t => {
  const f = await fixture(t);
  f.state.list = [{ id: 40, is_draft: true, uploads: [{ id: 70 }], comment: 'text' }];
  await assert.rejects(() => f.actions.prepare('draft', { activity_id: 10, submission_id: 40, keep_upload_ids: [99] }), (e: any) => e.code === 'FILE_NOT_IN_SUBMISSION');
  const plan = await f.actions.prepare('draft', { activity_id: 10, submission_id: 40, keep_upload_ids: [], file_paths: [f.file] });
  const result = await f.actions.execute('draft', plan.plan_id);
  assert.equal(result.verified, true);
  assert.ok(!f.state.writes.at(-1).body.uploads.includes(70));
});

test('already submitted records and multimedia drafts are not silently overwritten', async t => {
  const f = await fixture(t);
  f.state.list = [{ id: 40, is_draft: false, uploads: [] }];
  await assert.rejects(() => f.actions.prepare('draft', { activity_id: 10, submission_id: 40, comment: 'text' }), (e: any) => e.code === 'NOT_A_DRAFT');
  f.state.list[0] = { id: 40, is_draft: true, uploads: [], comment: '<img src="/image">' };
  await assert.rejects(() => f.actions.prepare('draft', { activity_id: 10, submission_id: 40, comment: 'text' }), (e: any) => e.code === 'UNSUPPORTED_DRAFT_CONTENT');
  assert.equal(f.state.writes.length, 0);
});

test('group homework resolves only the current user group and previews the shared target', async t => {
  const f = await fixture(t);
  Object.assign(f.state.activity, { submit_by_group: true, group_set_id: 60 });
  const plan = await f.actions.prepare('submit', { activity_id: 10, comment: 'Team answer' });
  assert.equal(plan.group?.id, '50');
  assert.ok(f.state.calls.includes('/api/activities/10/groups/50/submission_list'));
  assert.equal((await f.actions.execute('submit', plan.plan_id)).verified, true);
});

test('switching groups invalidates an existing preview before uploading', async t => {
  const f = await fixture(t);
  Object.assign(f.state.activity, { submit_by_group: true, group_set_id: 60 });
  const plan = await f.actions.prepare('draft', { activity_id: 10, comment: 'Team draft' });
  f.state.group.id = 51;
  await assert.rejects(() => f.actions.execute('draft', plan.plan_id), (e: any) => e.code === 'PLATFORM_STATE_CHANGED');
  assert.equal(f.state.writes.length, 0);
});

test('group homework without current group membership does not fall back to personal submissions', async t => {
  const f = await fixture(t);
  Object.assign(f.state.activity, { submit_by_group: true, group_set_id: 60 });
  f.state.group = null;
  await assert.rejects(() => f.actions.prepare('submit', { activity_id: 10, comment: 'text' }), (e: any) => e.code === 'GROUP_UNAVAILABLE');
  assert.equal(f.state.writes.length, 0);
});

test('submission readback rejects wrong text and pre-existing identical text-only records', async t => {
  const f = await fixture(t);
  f.state.wrongComment = true;
  let plan = await f.actions.prepare('submit', { activity_id: 10, comment: 'Expected answer' });
  assert.equal((await f.actions.execute('submit', plan.plan_id)).verified, false);
  f.state.wrongComment = false;
  f.state.ignoreWrite = true;
  f.state.list = [{ id: 99, is_draft: false, comment: 'Expected answer', uploads: [] }];
  plan = await f.actions.prepare('submit', { activity_id: 10, comment: 'Expected answer' });
  assert.equal((await f.actions.execute('submit', plan.plan_id)).verified, false);
});

test('closed, not-yet-open and submission-count limited assignments stop before writing', async t => {
  const f = await fixture(t);
  f.state.activity.is_started = false;
  await assert.rejects(() => f.actions.prepare('submit', { activity_id: 10, comment: 'text' }), (e: any) => e.code === 'HOMEWORK_NOT_STARTED');
  f.state.activity.is_started = true;
  f.state.activity.is_closed = true;
  await assert.rejects(() => f.actions.prepare('draft', { activity_id: 10, comment: 'text' }), (e: any) => e.code === 'HOMEWORK_CLOSED');
  Object.assign(f.state.activity, { is_closed: false, non_submit_times: false, submit_times: 1, user_submit_count: 1 });
  await assert.rejects(() => f.actions.prepare('submit', { activity_id: 10, comment: 'text' }), (e: any) => e.code === 'SUBMISSION_LIMIT_REACHED');
  assert.equal(f.state.writes.length, 0);
});

test('submission downloads validate both record ownership and attachment membership', async t => {
  const f = await fixture(t);
  f.state.list = [{ id: 40, is_draft: false, uploads: [{ id: 70, name: 'answer.txt', allow_download: true }] }];
  const args = { activity_id: 10, submission_id: 40, upload_id: 70, output_dir: join(f.root, 'downloads') };
  await assert.rejects(() => f.reader.downloadSubmission({ ...args, submission_id: 99 }), (e: any) => e.code === 'SUBMISSION_NOT_FOUND');
  await assert.rejects(() => f.reader.downloadSubmission({ ...args, upload_id: 99 }), (e: any) => e.code === 'FILE_NOT_IN_SUBMISSION');
  const result = await f.reader.downloadSubmission(args);
  assert.equal(result.bytes, 6);
});
