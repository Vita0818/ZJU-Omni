import { z } from 'zod';
import type { LiteTool } from '../core/tools.ts';
import type { Deadline, Raw } from '../core/util.ts';
import type { Runtime } from '../platforms/index.ts';
import type { XzzdServices } from '../platforms/xzzd/index.ts';
import type { ZdbkServices } from '../platforms/zdbk/index.ts';
import type { ZhiyunServices } from '../platforms/zhiyun/index.ts';
import { courseLecturesShape, myLecturesShape, transcriptShape } from '../platforms/zhiyun/tools.ts';
import { courseCodeOfKey, TERMS } from '../platforms/zdbk/parse.ts';
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

function xzzdLite(x: XzzdServices, zdbk?: ZdbkServices): LiteTool[] {
  const { client, reader, workflows, materials, actions } = x;
  const read = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: true });
  const write = <T>(fn: () => Promise<T>) => client.withSession(fn, { readOnly: false });
  return [
    {
      name: 'zju_deadlines',
      title: '作业截止汇总',
      description: '汇总各课作业截止时间和提交状态。默认 pending（未交/草稿/未知）。',
      input: { status: z.enum(['pending', 'all', 'submitted']).optional(), due_before: z.string().optional(), course_ids: nums.optional(), offset: num.optional() },
      strict: assignmentScanShape,
      defaults: { status: 'pending', limit: 30 },
      run: args =>
        read(async () => {
          const r = await workflows.assignments(args);
          return {
            items: r.assignments.map(a => ({ activity_id: a.id, course: a.course_name, title: a.title, due: when(a.deadline), status: a.submission_status, overdue: a.overdue || undefined, group: a.is_group || undefined })),
            total: r.matched_count,
            next_offset: r.next_offset,
            complete: r.complete,
            error_codes: errorCodes(r.errors),
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
          return {
            courses: r.courses.map(c => ({ course_id: c.id, name: c.name, code: courseCodeOfKey(c.course_code) ?? c.course_code, credit: credits?.get(String(c.course_code)), semester: c.semester, teachers: c.instructors.join('、') || undefined })),
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
      description: '搜索本学期课程活动标题和附件名；include_body=true 连正文一起搜（较慢）。',
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

const shortTime = (iso: string | null) => (iso ? iso.slice(5, 16).replace('T', ' ') : null);
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
          return { exams: r.exams.map(e => ({ course: e.name, type: e.type === 'midterm' ? '期中' : '期末', time: e.start ? `${shortTime(e.start)}-${e.end!.slice(11, 16)}` : e.time_text, place: e.location, seat: e.seat })) };
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
          return {
            gpa: r.summary.gpa_5,
            gpa_4_3: r.summary.gpa_4_3,
            avg: r.summary.average_score,
            credits: r.summary.earned_credits,
            grades: r.grades.slice(0, 80).map(g => ({ course: g.name, term: g.academic_year ? `${g.academic_year}-${g.semester}` : undefined, credit: g.credit, score: g.score, gp: g.grade_point })),
            more: r.grades.length > 80 ? r.grades.length - 80 : undefined,
          };
        }),
    },
  ];
}

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
      description: '读取某堂课（sub_id）的语音转录文字。长文用 next_offset 续读。',
      input: { sub_id: num, offset: num.optional() },
      strict: transcriptShape,
      defaults: { max_characters: 6000 },
      run: args =>
        read(async () => {
          const r = await reader.transcript(args);
          return { available: r.available, text: r.text, next_offset: r.next_offset, total: r.total_characters, note: r.available ? undefined : r.note };
        }),
    },
  ];
}

export function liteTools(runtime: Runtime): LiteTool[] {
  const tools: LiteTool[] = [];
  if (runtime.xzzd) tools.push(...xzzdLite(runtime.xzzd, runtime.zdbk));
  if (runtime.zdbk) tools.push(...zdbkLite(runtime.zdbk));
  if (runtime.zhiyun) tools.push(...zhiyunLite(runtime.zhiyun));
  return tools;
}
