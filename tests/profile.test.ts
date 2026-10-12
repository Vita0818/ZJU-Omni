import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogSize } from '../src/core/tools.ts';
import { baseEnv, connectServer, ROOT, tempDir } from './helpers.ts';

const LITE_TOOLS = ['pta_problem', 'zju_lectures', 'zju_transcript', 'zju_schedule', 'zju_exams', 'zju_grades', 'zju_deadlines', 'zju_courses', 'zju_assignment', 'zju_materials', 'zju_sync', 'zju_search', 'zju_prepare_submission', 'zju_submit'];
const LITE_BUDGET = 6000;

test('lite catalog is task-oriented, short and within the fixed character budget', async t => {
  const dataDir = await tempDir(t);
  const lite = await connectServer(t, baseEnv(dataDir, { MCP_TOOL_PROFILE: 'lite' }));
  const { tools } = await lite.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...LITE_TOOLS].sort());
  for (const tool of tools) {
    assert.equal(tool.outputSchema, undefined);
    assert.ok((tool.description ?? '').length <= 80, `${tool.name} description is too long`);
  }
  const size = catalogSize(tools);
  assert.ok(size <= LITE_BUDGET, `lite catalog ${size} exceeds ${LITE_BUDGET}`);
  const full = await connectServer(t, baseEnv(dataDir));
  const fullSize = catalogSize((await full.listTools()).tools);
  assert.ok(size * 3 < fullSize, `lite ${size} should stay under a third of full ${fullSize}`);
});

test('lite skill document stays within 1.5 KB', async () => {
  const { size } = await stat(join(ROOT, 'skills/zju-lite/SKILL.md'));
  assert.ok(size <= 1536, `skills/zju-lite/SKILL.md is ${size} bytes`);
});

test('lite tools validate against the strict schema and return compact errors', async t => {
  const dataDir = await tempDir(t);
  const client = await connectServer(t, baseEnv(dataDir, { MCP_TOOL_PROFILE: 'lite' }));
  const missingLogin: any = await client.callTool({ name: 'zju_courses', arguments: {} });
  assert.equal(missingLogin.isError, true);
  assert.equal(missingLogin.structuredContent, undefined);
  assert.equal(JSON.parse(missingLogin.content[0].text).error.code, 'LOGIN_REQUIRED');
  const invalid: any = await client.callTool({ name: 'zju_assignment', arguments: { activity_id: -5 } });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).error.code, 'INVALID_ARGUMENT');
  const badPlan: any = await client.callTool({ name: 'zju_submit', arguments: { plan_id: 'not-a-plan' } });
  assert.equal(JSON.parse(badPlan.content[0].text).error.code, 'INVALID_ARGUMENT');
});

test('platform switches remove disabled tools', async t => {
  const dataDir = await tempDir(t);
  const client = await connectServer(t, baseEnv(dataDir, { ZJU_PLATFORMS: 'zdbk,cc98' }));
  const { tools } = await client.listTools();
  assert.ok(tools.every(tool => !tool.name.startsWith('xzzd_')));
  assert.ok(tools.some(tool => tool.name === 'zdbk_get_timetable'));
  assert.ok(tools.some(tool => tool.name === 'zju_auth_status'));
  const status: any = await client.callTool({ name: 'zju_auth_status', arguments: {} });
  assert.deepEqual(status.structuredContent.data.platforms.map((p: any) => [p.platform, p.implemented]), [['zdbk', true], ['cc98', false]]);
  const login: any = await client.callTool({ name: 'zju_auth_login', arguments: { platform: 'xzzd' } });
  assert.equal(login.structuredContent.error.code, 'PLATFORM_DISABLED');
});

test('invalid configuration stops the server at startup', async t => {
  const dataDir = await tempDir(t);
  for (const extra of [{ MCP_TOOL_PROFILE: 'tiny' }, { ZJU_PLATFORMS: 'moodle' }, { ZJU_NETWORK: 'proxy' }] as Record<string, string>[]) {
    const result = spawnSync(process.execPath, [join(ROOT, 'src/server.ts')], { env: { PATH: process.env.PATH, ...baseEnv(dataDir, extra) }, input: '', encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 2, JSON.stringify(extra));
    assert.match(result.stderr, /zju-omni:/);
  }
});
