// Read-only smoke test against the real platforms with the locally configured
// account. Never calls write tools. Prints only counts and error codes.
// Usage: npm run smoke [-- --lite]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../../src/app.ts';
import { loadConfig } from '../../src/core/config.ts';

const lite = process.argv.includes('--lite');
const cfg = loadConfig({ ...process.env, MCP_TOOL_PROFILE: lite ? 'lite' : 'full' });
const { server } = buildServer(cfg);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: 'zju-omni-smoke', version: '1.0.0' });
await client.connect(clientSide);

const WRITE = /prepare|submit|save|retract|forget|download|sync/;
const enabled = (name: string) => !name.startsWith('zdbk_') || cfg.platforms.has('zdbk');
const allSteps: [string, Record<string, unknown>][] = lite
  ? [
      ['zju_courses', {}],
      ['zju_deadlines', {}],
      ['zju_schedule', {}],
      ['zju_exams', {}],
      ['zju_grades', {}],
    ]
  : [
      ['zju_auth_status', { check: true }],
      ['xzzd_list_semesters', {}],
      ['xzzd_list_courses', { page_size: 5 }],
      ['xzzd_list_todos', {}],
      ['xzzd_list_all_assignments', { status: 'pending', limit: 5, max_courses: 10 }],
      ['zdbk_get_timetable', {}],
      ['zdbk_list_exams', { upcoming_only: true }],
      ['zdbk_gpa_summary', {}],
    ];

const steps = allSteps.filter(([name]) => enabled(name));
let failures = 0;
for (const [name, args] of steps) {
  if (WRITE.test(name)) throw new Error(`smoke test refuses write-capable tool ${name}`);
  const started = Date.now();
  let result: any;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  } catch (e: any) {
    failures++;
    process.stdout.write(`✖ ${name} (${Date.now() - started} ms) ${e?.message ?? e}\n`);
    continue;
  }
  const text = result.content?.[0]?.text ?? '{}';
  const payload = JSON.parse(text);
  const data = lite ? payload : payload.data;
  const error = lite ? payload.error : payload.error;
  const summary = result.isError
    ? `ERROR ${error?.code}: ${error?.message}`
    : Object.entries(data ?? {})
        .map(([k, v]) => (Array.isArray(v) ? `${k}=${v.length}` : typeof v === 'boolean' || typeof v === 'number' ? `${k}=${v}` : null))
        .filter(Boolean)
        .join(' ');
  if (result.isError) failures++;
  process.stdout.write(`${result.isError ? '✖' : '✔'} ${name} (${Date.now() - started} ms) ${summary}\n`);
}
await client.close();
process.exitCode = failures ? 1 : 0;
