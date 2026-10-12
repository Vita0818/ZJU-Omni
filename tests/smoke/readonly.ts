// Read-only smoke test against the real platforms with the locally configured
// account. Never calls write tools. Prints only counts, error codes and (for
// schema discovery) field names — never field values.
// Usage: npm run smoke [-- --lite] [-- --only=zhiyun]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/app.ts';
import { loadConfig } from '../../src/core/config.ts';

const lite = process.argv.includes('--lite');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',');
const cfg = loadConfig({ ...process.env, MCP_TOOL_PROFILE: lite ? 'lite' : 'full' });
const { server, runtime } = buildServer(cfg);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: 'zju-omni-smoke', version: '1.0.0' });
await client.connect(clientSide);

const WRITE = /prepare|submit|save|retract|forget|download|sync/;
const platformOf = (name: string) => (name.startsWith('zju_auth') ? 'zju' : name.split('_')[0]);
const LITE_PLATFORM: Record<string, string> = { pta_problem: 'pta', zju_schedule: 'zdbk', zju_exams: 'zdbk', zju_grades: 'zdbk', zju_lectures: 'zhiyun', zju_transcript: 'zhiyun' };
const wanted = (name: string) => {
  const platform = lite ? LITE_PLATFORM[name] ?? 'xzzd' : platformOf(name);
  if (platform !== 'zju' && !cfg.platforms.has(platform as any)) return false;
  return !only || only.includes(platform);
};

let failures = 0;
async function step(name: string, args: Record<string, unknown>): Promise<any> {
  if (WRITE.test(name)) throw new Error(`smoke test refuses write-capable tool ${name}`);
  if (!wanted(name)) return null;
  const started = Date.now();
  let result: any;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  } catch (e: any) {
    failures++;
    process.stdout.write(`✖ ${name} (${Date.now() - started} ms) ${e?.message ?? e}\n`);
    return null;
  }
  const payload = JSON.parse(result.content?.[0]?.text ?? '{}');
  const data = lite ? payload : payload.data;
  const error = payload.error;
  const summary = result.isError
    ? `ERROR ${error?.code}: ${error?.message}${error?.hostname ? ` (${error.hostname})` : ''}`
    : Object.entries(data ?? {})
        .map(([k, v]) => (Array.isArray(v) ? `${k}=${v.length}` : typeof v === 'boolean' || typeof v === 'number' ? `${k}=${v}` : null))
        .filter(Boolean)
        .join(' ');
  if (result.isError) failures++;
  process.stdout.write(`${result.isError ? '✖' : '✔'} ${name} (${Date.now() - started} ms) ${summary}\n`);
  return result.isError ? null : data;
}

const keysOf = (value: unknown) => (value && typeof value === 'object' ? Object.keys(value).sort().join(',') : typeof value);

if (lite) {
  await step('zju_courses', {});
  await step('zju_deadlines', {});
  await step('zju_schedule', {});
  await step('zju_exams', {});
  await step('zju_grades', {});
  const lectures = await step('zju_lectures', { days: 7 });
  const sub = lectures?.lectures?.[0]?.sub_id;
  if (sub) await step('zju_transcript', { sub_id: Number(sub) });
} else {
  await step('zju_auth_status', { check: true });
  await step('xzzd_list_semesters', {});
  await step('xzzd_list_courses', { page_size: 5 });
  await step('xzzd_list_todos', {});
  await step('xzzd_list_all_assignments', { status: 'pending', limit: 5, max_courses: 10 });
  await step('zdbk_get_timetable', {});
  await step('zdbk_list_exams', { upcoming_only: true });
  await step('zdbk_gpa_summary', {});
  const mine = await step('zhiyun_my_lectures', { days: 7 });
  const lecture = mine?.lectures?.[0];
  if (lecture) {
    await step('zhiyun_list_lectures', { course_id: Number(lecture.course_id) });
    await step('zhiyun_get_transcript', { sub_id: Number(lecture.sub_id), max_characters: 500 });
    await step('zhiyun_get_ppt_timeline', { course_id: Number(lecture.course_id), sub_id: Number(lecture.sub_id) });
    await step('zhiyun_search_courses', { keyword: String(lecture.course_title).slice(0, 4) });
    const zhiyun = runtime.zhiyun;
    if (zhiyun && wanted('zhiyun_x')) {
      // Field names only, to refine parsing of loosely documented responses.
      try {
        await zhiyun.client.withSession(async () => {
          const ppt = await zhiyun.client.get('https://classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt', { course_id: lecture.course_id, sub_id: lecture.sub_id, page: 1, per_page: 100 });
          const item = ppt.list?.[0];
          let content: unknown = null;
          try {
            content = typeof item?.content === 'string' ? JSON.parse(item.content) : item?.content;
          } catch {}
          process.stdout.write(`  keys search-ppt: top=[${keysOf(ppt)}] item=[${keysOf(item)}] content=[${keysOf(content)}]\n`);
          const me = await zhiyun.client.profile();
          const search = await zhiyun.client.get('https://classroom.zju.edu.cn/pptnote/v1/searchlist', { tenant_id: 112, tenant_code: 112, user_id: me.id, user_name: me.account, page: 1, per_page: 16, title: String(lecture.course_title).slice(0, 4), realname: '', trans: '' });
          process.stdout.write(`  keys searchlist item=[${keysOf(search.total?.list?.[0])}]\n`);
          const day = await zhiyun.client.get('https://classroom.zju.edu.cn/courseapi/v2/course-live/get-my-course-day', { day: lecture.date });
          const groups = Array.isArray(day.list) ? day.list : Object.values(day.list ?? {});
          process.stdout.write(`  keys course-day group=[${keysOf(groups[0])}] course=[${keysOf((groups[0] as any)?.course?.[0])}]\n`);
        });
      } catch (e: any) {
        process.stdout.write(`  keys: ${e?.code ?? e?.message}\n`);
      }
    }
  } else if (wanted('zhiyun_x')) {
    process.stdout.write('  (最近 7 天没有智云堂次，跳过转录和 PPT)\n');
  }
}
if (runtime.pta && cfg.platforms.has('pta') && (!only || only.includes('pta'))) {
  if (!(await runtime.pta.client.status()).configured) process.stdout.write('  (拼题A 未导入 Cookie，跳过 PTA)\n');
  else if (lite) {
    const sets = await runtime.pta.reader.problemSets({ max_sets: 5 }).catch(() => null);
    const first = sets?.problem_sets[0];
    if (first) await step('pta_problem', { problem_set_id: first.id });
  } else {
    const sets = await step('pta_list_problem_sets', {});
    const first = sets?.problem_sets?.[0];
    if (first) {
      await step('pta_get_problem_set', { problem_set_id: first.id });
      const list = await step('pta_list_problems', { problem_set_id: first.id });
      const problem = list?.problems?.[0];
      if (problem) await step('pta_get_problem', { problem_set_id: first.id, problem_id: problem.id, max_characters: 500 });
    }
  }
}
await client.close();
process.exitCode = failures ? 1 : 0;
