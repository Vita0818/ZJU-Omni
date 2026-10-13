import { z } from 'zod';
import type { LiteTool } from '../core/tools.ts';
import type { Deadline, Raw } from '../core/util.ts';
import type { Runtime } from '../platforms/index.ts';
import { beijing, mergeDeadlines, type DeadlineInput } from './deadlines.ts';
import type { XzzdServices } from '../platforms/xzzd/index.ts';
import type { ZdbkServices } from '../platforms/zdbk/index.ts';
import type { ZhiyunServices } from '../platforms/zhiyun/index.ts';
import type { PtaServices } from '../platforms/pta/index.ts';
import type { XxtServices } from '../platforms/xxt/index.ts';
import type { Cc98Services } from '../platforms/cc98/index.ts';
import { searchShape as cc98SearchShape, topicShape as cc98TopicShape } from '../platforms/cc98/tools.ts';
import { problemShape } from '../platforms/pta/tools.ts';
import { courseLecturesShape, myLecturesShape, transcriptShape } from '../platforms/zhiyun/tools.ts';
import { courseCodeOfKey, currentTerm, TERMS } from '../platforms/zdbk/parse.ts';
import { examsShape, gradesShape, timetableShape } from '../platforms/zdbk/tools.ts';
import { assignmentScanShape, assignmentShape, identifier, searchShape, submissionShape, syncShape } from '../platforms/xzzd/tools.ts';

const num = z.coerce.number();
const nums = z.array(num);
const when = (d: Deadline | null | undefined) => d?.shanghai ?? d?.raw ?? null;
const errorCodes = (errors: Raw[] | undefined) => (errors?.length ? errors.slice(0, 5).map(e => e.error?.code ?? e.code) : undefined);

async function creditMap(zdbk: ZdbkServices): Promise<Map<string, number>> {
  return zdbk.client.withSession(async () => {
    const map = new Map<string, number>();
    for (const g of (await zdbk.reader.grades()).grades) map.set(g.course_key, g.credit);
    for (const e of (await zdbk.reader.exams()).exams) if (e.credit != null && Number.isFinite(e.credit)) map.set(e.course_key, e.credit);
    return map;
  });
}

const STATUS_LABELS: Record<string, string> = { unsubmitted: '未交', draft: '草稿', submitted: '已交', unknown: '状态未知' };

async function ptaDeadlines(pta: PtaServices, status: string): Promise<{ items: DeadlineInput[]; note?: string }> {
  if (!(await pta.client.status()).configured) return { items: [], note: '拼题A 未导入 Cookie，未包含题集' };
  try {
    const sets = await pta.reader.problemSets({ active_only: true, max_sets: 10 });
    const items: DeadlineInput[] = [];
    for (const set of sets.problem_sets) {
      let progress: { accepted: number; total: number } | null = null;
      try {
        progress = await pta.reader.progress(set.id);
      } catch {}
      const done = progress != null && progress.total > 0 && progress.accepted >= progress.total;
      if ((status === 'pending' && done) || (status === 'submitted' && !done)) continue;
      items.push({ source: '拼题A', course: null, title: set.name, due_iso: set.ends_at.iso, status: done ? '已完成' : '未完成', solved: progress ? `${progress.accepted}/${progress.total}` : undefined, problem_set_id: set.id });
    }
    return { items };
  } catch (e: any) {
    return { items: [], note: `拼题A 读取失败（${e?.code ?? 'INTERNAL_ERROR'}）` };
  }
}

async function xxtDeadlines(xxt: XxtServices, status: string): Promise<{ items: DeadlineInput[]; note?: string }> {
  if (status === 'submitted') return { items: [] };
  if (!(await xxt.client.status()).configured) return { items: [], note: '学习通未导入 Cookie，未包含学习通作业' };
  try {
    const r = await xxt.reader.deadlines({ horizon_days: 60, max_courses: 15 });
    return { items: r.items.map(i => ({ source: '学习通' as const, course: i.course, title: i.title, due_iso: i.deadline, status: i.status })) };
  } catch (e: any) {
    return { items: [], note: `学习通读取失败（${e?.code ?? 'INTERNAL_ERROR'}）` };
  }
}

// Course codes such as "_uuid_…" are internal identifiers, not useful to show.
const displayCode = (code: unknown) => {
  const short = courseCodeOfKey(code) ?? String(code ?? '');
  return /^[A-Z]{2,}[0-9A-Z]*\d/.test(short) ? short : undefined;
};

function xzzdLite(x: XzzdServices, zdbk?: ZdbkServices, pta?: PtaServices, xxt?: XxtServices): LiteTool[] {
  const { client, reader, workflows, materials, actions } = x;
  const read = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: true });
  const write = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: false });
  return [
    {
      name: 'zju_deadlines',
      title: '作业截止汇总',
      description: '本学期作业和拼题A题集截止，已合并并按截止时间排好序。默认未完成。',
      input: { status: z.enum(['pending', 'all', 'submitted']).optional(), due_before: z.string().optional(), course_ids: nums.optional(), offset: num.optional() },
      strict: assignmentScanShape,
      defaults: { status: 'pending', limit: 30 },
      run: args =>
        read(async () => {
          const offset = Number(args.offset ?? 0);
          const limit = Number(args.limit ?? 30);
          const r = await workflows.assignments({ ...args, offset: 0, limit: 300 });
          const inputs: DeadlineInput[] = r.assignments.map(a => ({ source: '学在浙大', course: a.course_name, title: a.title, due_iso: a.deadline?.iso ?? null, status: STATUS_LABELS[a.submission_status] ?? a.submission_status, activity_id: a.id, group: a.is_group }));
          const notes: string[] = [];
          for (const extra of [pta ? await ptaDeadlines(pta, args.status) : null, xxt ? await xxtDeadlines(xxt, args.status) : null]) {
            if (!extra) continue;
            inputs.push(...extra.items);
            if (extra.note) notes.push(extra.note);
          }
          const now = new Date();
          const merged = mergeDeadlines(inputs, now);
          return {
            today: beijing(now.toISOString(), false),
            items: merged.slice(offset, offset + limit),
            total: merged.length,
            next_offset: offset + limit < merged.length ? offset + limit : null,
            complete: r.complete && r.matched_count <= 300,
            error_codes: errorCodes(r.errors),
            note: ['已按截止时间排好序：先列未到期的（最近的在前），再列已过期的，最后是截止时间未知的。按 no 顺序引用即可。', ...notes].join(' '),
          };
        }),
    },
    {
      name: 'zju_courses',
      title: '我的课程',
      description: '列出本学期课程（course_id、代码、学分）。keyword 按名称搜全部学期。',
      input: { keyword: z.string().optional(), semester_id: num.optional(), all_semesters: z.boolean().optional(), page: num.optional() },
      strict: { keyword: z.string().max(120).default(''), semester_id: identifier.optional(), all_semesters: z.boolean().default(false), page: z.number().int().min(1).max(1000).default(1), page_size: z.number().int().min(1).max(100).default(30) },
      run: args =>
        read(async () => {
          let semester_id = args.semester_id;
          let scope = semester_id != null ? 'semester' : 'all';
          if (semester_id == null && !args.keyword && !args.all_semesters) {
            const active = (await reader.semesters()).semesters.filter(s => s.is_active === true);
            if (active.length === 1) {
              semester_id = active[0].id;
              scope = `current:${active[0].name}`;
            }
          }
          const r = await reader.courses({ ...args, semester_id });
          let credits: Map<string, number> | null = null;
          let creditError: string | undefined;
          if (zdbk && r.courses.length) {
            try {
              credits = await creditMap(zdbk);
            } catch (e: any) {
              creditError = e?.code ?? 'INTERNAL_ERROR';
            }
          }
          const courses = r.courses.map(c => ({ course_id: c.id, name: c.name, code: displayCode(c.course_code), credit: credits?.get(String(c.course_code)), semester: c.semester, teachers: c.instructors.join('、') || undefined }));
          const known = courses.filter(c => typeof c.credit === 'number');
          const creditSummary = credits
            ? {
                credit_total: Math.round(known.reduce((sum, c) => sum + (c.credit as number), 0) * 10) / 10,
                credit_missing: courses.filter(c => typeof c.credit !== 'number').map(c => c.name),
                credit_note: `credit_total 已算好，是 ${known.length} 门有学分课程的合计；credit_missing 里的课程平台没有给出学分，原因未知，不要猜测。`,
              }
            : {};
          return {
            courses,
            course_count: courses.length,
            ...creditSummary,
            scope,
            next_page: r.next_page,
            credit_error: creditError,
          };
        }),
    },
    {
      name: 'zju_assignment',
      title: '作业详情',
      description: '读取作业要求、附件、截止时间和本人提交状态。长正文用 next_offset 续读。',
      input: { activity_id: num, offset: num.optional() },
      strict: assignmentShape,
      defaults: { max_characters: 6000 },
      run: args =>
        read(async () => {
          const a: Raw = await reader.assignment(args);
          return {
            activity_id: a.id,
            course_id: a.course_id,
            title: a.title,
            due: when(a.deadline),
            opens: when(a.start_time),
            closed: a.is_closed || undefined,
            group: a.group ? a.group.name || a.group.id : undefined,
            status: a.submission_status,
            draft_ids: a.draft_ids,
            files: a.files.map((f: Raw) => ({ upload_id: f.id, name: f.name })),
            description: a.description,
            next_offset: a.next_offset,
            max_submissions: a.requirements.max_submissions,
            submitted_count: a.requirements.user_submit_count,
            score: a.latest_submission?.score,
          };
        }),
    },
    {
      name: 'zju_materials',
      title: '课件列表',
      description: '列出课程课件和附件（activity_id、upload_id）。',
      input: { course_id: num, page: num.optional() },
      strict: { course_id: identifier, page: z.number().int().min(1).max(1000).default(1), page_size: z.number().int().min(1).max(100).default(20) },
      run: args =>
        read(async () => {
          const r = await reader.materials(args);
          return {
            materials: r.activities.map(a => ({ activity_id: a.id, title: a.title, files: a.files.map(f => ({ upload_id: f.id, name: f.name, size: f.size })) })),
            next_page: r.next_page,
          };
        }),
    },
    {
      name: 'zju_sync',
      title: '同步课件到本地',
      description: '把课程课件增量下载到本机目录，不覆盖本地修改。dry_run=true 只检查。',
      input: { course_id: num, output_dir: z.string(), dry_run: z.boolean().optional() },
      strict: syncShape,
      readOnly: false,
      idempotent: true,
      run: args =>
        read(async () => {
          const r = await materials.sync(args);
          return {
            directory: r.directory,
            counts: r.counts,
            complete: r.complete,
            deferred: r.deferred_files || undefined,
            files: r.results.slice(0, 40).map(f => ({ name: f.name, status: f.status, path: f.path })),
            error_codes: errorCodes(r.errors),
          };
        }),
    },
    {
      name: 'zju_search',
      title: '搜索课程资料',
      description: '搜索学在浙大课程资料（活动标题、附件名）；include_body=true 连正文（较慢）。',
      input: { keyword: z.string(), include_body: z.boolean().optional(), course_ids: nums.optional(), semester_id: num.optional(), offset: num.optional() },
      strict: searchShape,
      defaults: { limit: 20, include_body: false },
      run: args =>
        read(async () => {
          const r = await workflows.search(args);
          return {
            results: r.results.map(h => ({ course: h.course_name, activity_id: h.id, title: h.title, type: h.type, matched: h.matched_fields.join(','), excerpt: h.excerpt || undefined })),
            total: r.matched_count,
            next_offset: r.next_offset,
            complete: r.complete,
            error_codes: errorCodes(r.errors),
          };
        }),
    },
    {
      name: 'zju_prepare_submission',
      title: '预览交作业',
      description: '预览交作业（文字和/或本地绝对路径文件），返回 plan_id，不上传。',
      input: { activity_id: num, comment: z.string().optional(), file_paths: z.array(z.string()).optional(), submission_id: num.optional() },
      strict: submissionShape,
      readOnly: false,
      run: args =>
        read(async () => {
          const p = await actions.prepare('submit', args);
          return {
            plan_id: p.plan_id,
            course: p.course,
            assignment: p.assignment,
            group: p.group ? p.group.name || p.group.id : undefined,
            files: (p.files as Raw[]).map(f => f.name),
            kept_files: (p.retained_files as Raw[]).map(f => f.name),
            comment: p.comment,
            due: when(p.deadline),
            expires_at: p.expires_at,
            note: '尚未提交。用户确认后调用 zju_submit。',
          };
        }),
    },
    {
      name: 'zju_submit',
      title: '确认交作业',
      description: '用户确认后执行 zju_prepare_submission 的 plan_id。结果不明时勿重试。',
      input: { plan_id: z.string() },
      strict: { plan_id: z.string().uuid() },
      readOnly: false,
      destructive: true,
      run: args =>
        write(async () => {
          const r: Raw = await actions.execute('submit', args.plan_id);
          return { status: r.status, verified: r.verified, submission_id: r.submission?.id, note: r.note };
        }),
    },
  ];
}

const periodRange = (periods: number[]) => (periods.length > 1 ? `${periods[0]}-${periods[periods.length - 1]}` : String(periods[0]));

function zdbkLite({ client, reader }: ZdbkServices): LiteTool[] {
  const read = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: true });
  return [
    {
      name: 'zju_schedule',
      title: '课表',
      description: '查教务课表。academic_year 如 2025-2026，term 为秋/冬/春/夏；省略则取当前学期。',
      input: { academic_year: z.string().optional(), term: z.enum(TERMS).optional() },
      strict: timetableShape,
      run: args =>
        read(async () => {
          const r = await reader.timetable(args);
          return {
            academic_year: r.academic_year,
            term: r.term,
            classes: r.sessions.map(s => ({ day: s.weekday_name, periods: periodRange(s.periods), time: s.time, course: s.name, place: s.location, teacher: s.teacher, weeks: s.weeks === 'all' ? undefined : s.weeks === 'odd' ? '单周' : '双周' })),
          };
        }),
    },
    {
      name: 'zju_exams',
      title: '考试安排',
      description: '查教务考试安排（时间、考场、座位）。默认只看未结束的。',
      input: { upcoming_only: z.boolean().optional(), academic_year: z.string().optional(), semester: num.optional() },
      strict: examsShape,
      defaults: { upcoming_only: true },
      run: args =>
        read(async () => {
          const r = await reader.exams(args);
          return {
            exams: r.exams.map(e => ({ course: e.name, type: e.type === 'midterm' ? '期中' : '期末', time: e.start ? `${e.start.slice(0, 10)} ${e.start.slice(11, 16)}-${e.end!.slice(11, 16)}` : e.time_text, place: e.location ?? '未公布', seat: e.seat ?? '未公布' })),
            note: r.exams.length ? '“未公布”表示教务尚未排定考场或座位，这是完整结果，无需重复查询。' : '没有符合条件的考试。',
          };
        }),
    },
    {
      name: 'zju_grades',
      title: '成绩与绩点',
      description: '查教务成绩和 GPA，可按学年、学期（1秋冬/2春夏）筛选。',
      input: { academic_year: z.string().optional(), semester: num.optional(), major_only: z.boolean().optional() },
      strict: gradesShape,
      run: args =>
        read(async () => {
          const r = await reader.grades(args);
          const now = currentTerm();
          const label = (year: string | null, semester: number | null) => (year ? `${year} ${semester === 1 ? '秋冬' : semester === 2 ? '春夏' : ''}`.trim() : undefined);
          return {
            current_semester: `${now.academic_year} ${now.term === '春' || now.term === '夏' ? '春夏' : '秋冬'}`,
            note: 'gpa/avg/credits 是全部已出成绩的累计值；term 是每门课所属学期，当前学期的课一般要期末后才出成绩。',
            gpa: r.summary.gpa_5,
            gpa_4_3: r.summary.gpa_4_3,
            avg: r.summary.average_score,
            credits: r.summary.earned_credits,
            grades: r.grades.slice(0, 80).map(g => ({ course: g.name, term: label(g.academic_year, g.semester), credit: g.credit, score: g.score, gp: g.grade_point })),
            more: r.grades.length > 80 ? r.grades.length - 80 : undefined,
          };
        }),
    },
  ];
}

const TRANSCRIPT_PAGE = 8000;

function zhiyunLite({ client, reader }: ZhiyunServices): LiteTool[] {
  const read = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: true });
  return [
    {
      name: 'zju_lectures',
      title: '课堂回放',
      description: '列出智云课堂堂次（sub_id）。默认今天；days 往前多查几天；course_id 查整门课。',
      input: { date: z.string().optional(), days: num.optional(), course_id: num.optional() },
      strict: { ...myLecturesShape, course_id: courseLecturesShape.course_id.optional() },
      run: args =>
        read(async () => {
          const r = args.course_id != null ? await reader.courseLectures({ course_id: args.course_id }) : await reader.myLectures(args);
          return { lectures: r.lectures.map(l => ({ sub_id: l.sub_id, course_id: l.course_id, course: l.course_title, title: l.title, time: l.begins_at?.replace(' +08:00', '') ?? l.date, teacher: l.teacher, place: l.room })) };
        }),
    },
    {
      name: 'zju_transcript',
      title: '课堂转录',
      description: '读取某堂课（sub_id）的语音转录文字（每 5 分钟一个时间戳）。长文用 next_offset 续读。',
      input: { sub_id: num, offset: num.optional() },
      strict: transcriptShape,
      defaults: { max_characters: TRANSCRIPT_PAGE },
      run: args =>
        read(async () => {
          const r = await reader.transcript({ ...args, timestamp_every_sec: 300 });
          if (!r.available) return { available: false, note: r.note };
          const pages = Math.max(1, Math.ceil(r.total_characters / TRANSCRIPT_PAGE));
          const page = Math.floor(Number(args.offset ?? 0) / TRANSCRIPT_PAGE) + 1;
          return {
            available: true,
            page: `${page}/${pages}`,
            text: r.text,
            next_offset: r.next_offset,
            note:
              r.next_offset == null
                ? '已是最后一段。'
                : `全文共 ${pages} 段。只需概括时，读完 1–2 段即可回答，并说明概括基于课程前半部分；用户要细节或完整内容时再用 next_offset 续读。`,
          };
        }),
    },
  ];
}

function ptaLite({ reader }: PtaServices): LiteTool[] {
  return [
    {
      name: 'pta_problem',
      title: '拼题A题面',
      description: '拼题A：只给 problem_set_id 列出全部题目；再给 problem_id 读题面。',
      input: { problem_set_id: z.string(), problem_id: z.string().optional(), offset: num.optional() },
      strict: { ...problemShape, problem_id: problemShape.problem_id.optional() },
      defaults: { max_characters: 6000 },
      run: async args => {
        if (args.problem_id == null) {
          const r = await reader.allProblems({ problem_set_id: args.problem_set_id });
          return { total: r.total, problems: r.problems.map(p => ({ problem_id: p.id, label: p.label, type: p.type_label, title: p.title.slice(0, 60), score: p.score, status: p.my_status })), truncated: r.truncated || undefined, note: '这是全部题目，无需翻页。读题面请再传 problem_id。' };
        }
        const p = await reader.problem(args);
        return { title: `${p.label ?? ''} ${p.title}`.trim(), type: p.type_label, score: p.score, time_limit_ms: p.time_limit_ms, memory_limit_kb: p.memory_limit_kb, due: when(p.deadline), content: p.content, next_offset: p.next_offset };
      },
    },
  ];
}

function cc98Lite({ reader }: Cc98Services): LiteTool[] {
  return [
    {
      name: 'cc98_search',
      title: 'CC98搜帖',
      description: '搜索 CC98 论坛帖子（网友讨论）。找课程资料用 zju_search。',
      input: { keyword: z.string(), from: num.optional() },
      strict: cc98SearchShape,
      defaults: { size: 15 },
      run: async args => {
        const r = await reader.search(args);
        return { topics: r.topics.map(t => ({ topic_id: t.id, title: t.title, board: t.board, replies: t.replies, time: t.time })), next_from: r.next_from };
      },
    },
    {
      name: 'cc98_topic',
      title: 'CC98读帖',
      description: '读取 CC98 帖子楼层内容。from 翻页。',
      input: { topic_id: num, from: num.optional() },
      strict: cc98TopicShape,
      defaults: { size: 10, max_characters: 1500 },
      run: async args => {
        const r = await reader.topic(args);
        return { title: r.title, board: r.board, floors: r.total_floors, posts: r.posts.map(p => ({ floor: p.floor, author: p.author, text: p.text })), next_from: r.next_from };
      },
    },
  ];
}

export function liteTools(runtime: Runtime): LiteTool[] {
  const tools: LiteTool[] = [];
  if (runtime.xzzd) tools.push(...xzzdLite(runtime.xzzd, runtime.zdbk, runtime.pta, runtime.xxt));
  if (runtime.pta) tools.push(...ptaLite(runtime.pta));
  if (runtime.cc98) tools.push(...cc98Lite(runtime.cc98));
  if (runtime.zdbk) tools.push(...zdbkLite(runtime.zdbk));
  if (runtime.zhiyun) tools.push(...zhiyunLite(runtime.zhiyun));
  return tools;
}
