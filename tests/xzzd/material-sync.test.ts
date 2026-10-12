import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../../src/core/errors.ts';
import { MaterialSync } from '../../src/platforms/xzzd/sync.ts';
import { tempDir, xzzdCfg } from '../helpers.ts';

async function fixture(t: TestContext) {
  const root = await tempDir(t, 'zju-sync-');
  const cfg = xzzdCfg(join(root, 'state'));
  const state = {
    user: '30',
    downloads: 0,
    content: 'first',
    contentType: 'text/plain',
    calls: [] as string[],
    activities: [{ id: 10, course_id: 20, title: 'Lecture', uploads: [{ id: 70, name: 'notes.txt', size: 5, updated_at: '2026-09-20T00:00:00Z', allow_download: true }] as any[] }],
  };
  const client = {
    downloadBytes: async (uploadId: string) => {
      state.downloads++;
      state.calls.push(uploadId);
      return { bytes: Buffer.from(state.content), contentType: state.contentType };
    },
  };
  const reader: any = {
    cfg,
    client,
    course: async () => ({ id: 20, name: 'Course' }),
    currentUserId: async () => state.user,
    materials: async () => ({ activities: state.activities, next_page: null }),
    assignments: async () => ({ assignments: [], next_page: null }),
    rawActivity: async (activityId: unknown) => state.activities.find(a => String(a.id) === String(activityId)),
    activityUrl: (course: unknown, activity: unknown) => `${cfg.baseUrl}/course/${course}/activity/${activity}`,
  };
  return { root, state, reader, sync: new MaterialSync(reader), args: { course_id: 20, output_dir: join(root, 'downloads') } };
}

test('initial sync downloads and subsequent sync skips unchanged files using hashes', async t => {
  const f = await fixture(t);
  const first = await f.sync.sync(f.args);
  assert.equal(first.complete, true);
  assert.equal(first.counts.downloaded, 1);
  assert.equal(f.state.downloads, 1);
  assert.equal(await readFile(first.results[0].path, 'utf8'), 'first');
  const second = await f.sync.sync(f.args);
  assert.equal(second.counts.unchanged, 1);
  assert.equal(f.state.downloads, 1);
  const manifest = JSON.parse(await readFile(first.manifest_path!, 'utf8'));
  assert.equal(manifest.user_id, '30');
  assert.equal(manifest.files['10:70'].sha256, first.results[0].sha256);
});

test('remote updates are versioned and existing files are retained', async t => {
  const f = await fixture(t);
  const first = await f.sync.sync(f.args);
  f.state.content = 'second';
  f.state.activities[0].uploads[0].updated_at = '2026-09-21T00:00:00Z';
  const second = await f.sync.sync(f.args);
  assert.equal(second.counts.updated, 1);
  assert.notEqual(first.results[0].path, second.results[0].path);
  assert.equal(await readFile(first.results[0].path, 'utf8'), 'first');
  assert.equal(await readFile(second.results[0].path, 'utf8'), 'second');
});

test('locally edited materials are preserved and a clean remote copy is saved separately', async t => {
  const f = await fixture(t);
  const first = await f.sync.sync(f.args);
  await writeFile(first.results[0].path, 'my annotations');
  const second = await f.sync.sync(f.args);
  assert.equal(second.results[0].local_modified, true);
  assert.equal(f.state.downloads, 2);
  assert.equal(await readFile(first.results[0].path, 'utf8'), 'my annotations');
  assert.equal(await readFile(second.results[0].path, 'utf8'), 'first');
});

test('missing remote timestamps require byte validation rather than assuming unchanged content', async t => {
  const f = await fixture(t);
  delete f.state.activities[0].uploads[0].updated_at;
  await f.sync.sync(f.args);
  await f.sync.sync(f.args);
  assert.equal(f.state.downloads, 2);
});

test('dry-run neither downloads bytes nor creates directories or manifests', async t => {
  const f = await fixture(t);
  const result = await f.sync.sync({ ...f.args, dry_run: true });
  assert.equal(result.counts.would_download, 1);
  assert.equal(f.state.downloads, 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.equal(result.manifest_path, null);
});

test('current activity permission is checked even when its previous copy was allowed', async t => {
  const f = await fixture(t);
  await f.sync.sync(f.args);
  f.state.activities[0].uploads[0].allow_download = false;
  const result = await f.sync.sync(f.args);
  assert.equal(result.counts.restricted, 1);
  assert.equal(f.state.downloads, 1);
});

test('file limits are resumable because unchanged files do not consume the next run budget', async t => {
  const f = await fixture(t);
  f.state.activities[0].uploads.push({ ...f.state.activities[0].uploads[0], id: 71, name: 'other.txt' });
  const first = await f.sync.sync({ ...f.args, max_files: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.deferred_files, 1);
  const second = await f.sync.sync({ ...f.args, max_files: 1 });
  assert.equal(second.complete, true);
  assert.equal(second.counts.unchanged, 1);
  assert.equal(second.counts.downloaded, 1);
});

test('manifest ownership prevents a different account reusing private course downloads', async t => {
  const f = await fixture(t);
  await f.sync.sync(f.args);
  f.state.user = '31';
  await assert.rejects(() => f.sync.sync(f.args), (e: any) => e.code === 'SYNC_ACCOUNT_MISMATCH');
  assert.equal(f.state.downloads, 1);
});

test('limited runs reach new files even when previous files lack modification times', async t => {
  const f = await fixture(t);
  delete f.state.activities[0].uploads[0].updated_at;
  f.state.activities[0].uploads.push({ id: 71, name: 'other.txt', allow_download: true });
  await f.sync.sync({ ...f.args, max_files: 1 });
  const result = await f.sync.sync({ ...f.args, max_files: 1 });
  assert.equal(result.counts.downloaded, 1);
  assert.deepEqual(f.state.calls, ['70', '71']);
});

test('symlinked activity directories and manifest traversal are rejected', async t => {
  const f = await fixture(t);
  const first = await f.sync.sync(f.args);
  const manifest = JSON.parse(await readFile(first.manifest_path!, 'utf8'));
  manifest.files['10:70'].relative_path = '../../outside';
  await writeFile(first.manifest_path!, JSON.stringify(manifest));
  let result = await f.sync.sync(f.args);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].error.code, 'SYNC_MANIFEST_INVALID');
  await rm(join(first.directory, 'activity-10'), { recursive: true });
  await mkdir(join(f.root, 'outside'));
  await symlink(join(f.root, 'outside'), join(first.directory, 'activity-10'));
  result = await f.sync.sync(f.args);
  assert.equal(result.errors[0].error.code, 'UNSAFE_SYNC_PATH');
  assert.equal(f.state.downloads, 1);
});

test('removed remote materials are reported and local copies are retained', async t => {
  const f = await fixture(t);
  const first = await f.sync.sync(f.args);
  f.state.activities = [];
  const second = await f.sync.sync(f.args);
  assert.deepEqual(second.missing_from_remote_catalog, ['10:70']);
  assert.equal(await readFile(first.results[0].path, 'utf8'), 'first');
});

test('catalog errors and HTML login responses are explicit failures, not successful empty syncs', async t => {
  const f = await fixture(t);
  f.reader.assignments = async () => {
    throw new ToolError('FORBIDDEN', 'Hidden');
  };
  let result = await f.sync.sync(f.args);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].kind, 'assignments');
  f.state.contentType = 'text/html';
  f.state.content = '<html>Login</html>';
  result = await f.sync.sync({ ...f.args, force: true });
  assert.ok(result.errors.some(e => e.error.code === 'UNEXPECTED_RESPONSE'));
});
