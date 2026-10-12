import { ToolError, safeError } from '../../core/errors.ts';
import { boundedText, deadline, id, type Raw } from '../../core/util.ts';
import { filesOf, publicFile } from './shared.ts';

export async function collectPages(load: (paging: { page: number; page_size: number }) => Promise<Raw>, key: string, { max_pages = 20, page_size = 100 } = {}) {
  const items: Raw[] = [];
  const seenItems = new Set<string>();
  const seenPages = new Set<string>();
  let page = 1;
  for (let count = 0; count < max_pages; count++) {
    const result = await load({ page, page_size });
    if (!Array.isArray(result[key])) throw new ToolError('SCHEMA_CHANGED', `列表缺少 ${key}。`);
    const signature = JSON.stringify(result[key].map((row: Raw) => row.id));
    if (result[key].length && seenPages.has(signature)) throw new ToolError('PAGINATION_STALLED', '平台重复返回同一页，已停止扫描，不能判断列表完整。');
    seenPages.add(signature);
    for (const row of result[key] as Raw[]) {
      const identity = id(row.id);
      if (!seenItems.has(identity)) {
        seenItems.add(identity);
        items.push(row);
      }
    }
    if (result.next_page == null) return { items, complete: true, next_page: null as number | null };
    if (!Number.isInteger(result.next_page) || result.next_page <= page) throw new ToolError('PAGINATION_STALLED', '平台分页未向前推进。');
    page = result.next_page;
  }
  return { items, complete: false, next_page: page as number | null };
}

export interface ScopeArgs {
  course_ids?: unknown[];
  semester_id?: unknown;
  max_courses?: number;
  max_pages?: number;
  all_semesters?: boolean;
}

export interface WorkflowReader {
  semesters?(): Promise<{ semesters: Raw[] }>;
  courses(args: Raw): Promise<Raw>;
  course(courseId: unknown): Promise<Raw>;
  assignments(args: Raw): Promise<Raw>;
  activities(args: Raw): Promise<Raw>;
  rawActivity?(activityId: unknown): Promise<Raw>;
}

export type AssignmentStatusFilter = 'all' | 'pending' | 'unsubmitted' | 'submitted' | 'draft' | 'unknown';

export interface AssignmentScanArgs extends ScopeArgs {
  include_submissions?: boolean;
  status?: AssignmentStatusFilter;
  include_closed?: boolean;
  due_after?: string;
  due_before?: string;
  offset?: number;
  limit?: number;
}

export interface SearchArgs extends ScopeArgs {
  keyword: string;
  include_body?: boolean;
  types?: string[];
  max_activities?: number;
  offset?: number;
  limit?: number;
}

function timeFilter(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = deadline(value);
  if (!parsed.iso) throw new ToolError('INVALID_DATE', '日期筛选必须使用带时区的 ISO 8601 时间。');
  return Date.parse(parsed.iso);
}

export class CourseWorkflows {
  readonly reader: WorkflowReader;
  constructor(reader: WorkflowReader) {
    this.reader = reader;
  }

  private async activeSemesters(): Promise<string[]> {
    if (!this.reader.semesters) return [];
    const { semesters } = await this.reader.semesters();
    return semesters.filter(s => s.is_active === true).map(s => id(s.id));
  }

  async courseScope({ course_ids, semester_id, max_courses = 50, max_pages = 20, all_semesters = false }: ScopeArgs = {}) {
    if (course_ids?.length && semester_id != null) throw new ToolError('INVALID_SCOPE', 'course_ids 与 semester_id 请选择一种，避免忽略筛选条件。');
    const errors: Raw[] = [];
    const courses: Raw[] = [];
    let complete = true;
    let continuation: Raw | null = null;
    let semesters: { mode: 'courses' | 'semester' | 'active' | 'all'; semester_ids: string[] } = { mode: 'courses', semester_ids: [] };
    if (course_ids?.length) {
      const ids = [...new Set(course_ids.map(id))];
      for (const courseId of ids.slice(0, max_courses)) {
        try {
          courses.push(await this.reader.course(courseId));
        } catch (e) {
          errors.push({ course_id: courseId, error: safeError(e) });
        }
      }
      if (ids.length > max_courses) {
        complete = false;
        continuation = { course_ids: ids.slice(max_courses) };
      }
    } else {
      const active = semester_id == null && !all_semesters ? await this.activeSemesters() : [];
      const targets: (unknown | undefined)[] = semester_id != null ? [semester_id] : active.length ? active : [undefined];
      semesters = semester_id != null ? { mode: 'semester', semester_ids: [id(semester_id)] } : active.length ? { mode: 'active', semester_ids: active } : { mode: 'all', semester_ids: [] };
      const items: Raw[] = [];
      const seen = new Set<string>();
      for (const target of targets) {
        const scanned = await collectPages(args => this.reader.courses({ ...args, semester_id: target }), 'courses', { max_pages });
        if (!scanned.complete) complete = false;
        for (const course of scanned.items) if (!seen.has(String(course.id))) (seen.add(String(course.id)), items.push(course));
      }
      courses.push(...items.slice(0, max_courses));
      if (items.length > max_courses) complete = false;
      if (!complete) continuation = { course_ids: items.slice(max_courses).map(c => c.id) };
    }
    return { courses, errors, complete: complete && errors.length === 0, continuation, semesters };
  }

  async assignments(args: AssignmentScanArgs = {}) {
    const { include_submissions = true, status = 'all', include_closed = true, due_after, due_before, offset = 0, limit = 100, max_pages = 20 } = args;
    const after = timeFilter(due_after);
    const before = timeFilter(due_before);
    if (after != null && before != null && after > before) throw new ToolError('INVALID_DATE_RANGE', 'due_after 不能晚于 due_before。');
    const scope = await this.courseScope(args);
    const assignments: Raw[] = [];
    const errors: Raw[] = [...scope.errors];
    const continuations: Raw[] = [];
    let complete = scope.complete;
    let scannedCount = 0;
    let unknownDeadlineCount = 0;
    for (const course of scope.courses) {
      try {
        const scan = await collectPages(paging => this.reader.assignments({ course_id: course.id, ...paging, include_submissions }), 'assignments', { max_pages });
        if (!scan.complete) {
          complete = false;
          continuations.push({ course_id: course.id, next_page: scan.next_page });
        }
        for (const a of scan.items) {
          scannedCount++;
          const state = a.submission_status || (a.submitted === true ? 'submitted' : a.submitted === false ? 'unsubmitted' : 'unknown');
          if (a.submission_error) {
            complete = false;
            errors.push({ course_id: course.id, activity_id: a.id, error: a.submission_error });
          }
          if (!include_closed && a.is_closed === true) continue;
          if (status !== 'all' && (status === 'pending' ? state === 'submitted' : state !== status)) continue;
          const timestamp = a.deadline?.iso ? Date.parse(a.deadline.iso) : null;
          if ((after != null || before != null) && timestamp == null) {
            unknownDeadlineCount++;
            continue;
          }
          if ((after != null && timestamp! < after) || (before != null && timestamp! > before)) continue;
          assignments.push({
            ...a,
            course_name: course.name,
            semester: course.semester ?? null,
            submission_status: state,
            status_source: include_submissions && !a.submission_error ? 'submission_records' : 'course_list',
            overdue: timestamp == null || state === 'unknown' ? null : timestamp < Date.now() && state !== 'submitted',
          });
        }
      } catch (e) {
        complete = false;
        errors.push({ course_id: course.id, error: safeError(e) });
      }
    }
    assignments.sort(
      (a, b) =>
        (a.deadline?.iso ? Date.parse(a.deadline.iso) : Infinity) - (b.deadline?.iso ? Date.parse(b.deadline.iso) : Infinity) ||
        String(a.course_id).localeCompare(String(b.course_id)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const counts: Record<string, number> = { submitted: 0, unsubmitted: 0, draft: 0, unknown: 0 };
    for (const a of assignments) counts[a.submission_status] = (counts[a.submission_status] ?? 0) + 1;
    return {
      assignments: assignments.slice(offset, offset + limit),
      matched_count: assignments.length,
      scanned_count: scannedCount,
      counts,
      courses_scanned: scope.courses.length,
      complete,
      next_offset: offset + limit < assignments.length ? offset + limit : null,
      scope: { semesters: scope.semesters, course_ids: scope.courses.map(c => c.id) },
      errors,
      continuations,
      course_continuation: scope.continuation,
      excluded_unknown_deadlines: unknownDeadlineCount,
      note: '未指定 course_ids/semester_id 时默认只扫描当前学期（semesters.mode=active），all_semesters=true 扫描全部课程。complete 表示本次扫描及状态核对是否完整；结果仍需按 next_offset 翻页。pending 包含未交、草稿和未知状态。未知时区的截止时间不参与日期筛选。',
    };
  }

  async search(args: SearchArgs) {
    const { keyword, include_body = true, types = [], max_pages = 20, max_activities = 300, offset = 0, limit = 50 } = args;
    const needle = keyword.trim().toLocaleLowerCase();
    if (!needle) throw new ToolError('INVALID_KEYWORD', '搜索关键词不能为空。');
    const scope = await this.courseScope(args);
    const results: Raw[] = [];
    const errors: Raw[] = [...scope.errors];
    const continuations: Raw[] = [];
    let complete = scope.complete;
    let inspected = 0;
    for (const course of scope.courses) {
      try {
        const scan = await collectPages(paging => this.reader.activities({ course_id: course.id, ...paging }), 'activities', { max_pages });
        if (!scan.complete) {
          complete = false;
          continuations.push({ course_id: course.id, next_page: scan.next_page });
        }
        for (const summary of scan.items) {
          if (types.length && !types.includes(summary.type)) continue;
          if (inspected >= max_activities) {
            complete = false;
            continuations.push({ course_id: course.id, activity_id: summary.id, reason: 'activity_limit' });
            break;
          }
          inspected++;
          let body = '';
          let files: Raw[] = summary.files;
          if (include_body && this.reader.rawActivity) {
            try {
              const raw = await this.reader.rawActivity(summary.id);
              body = boundedText(raw.description || raw.data?.description || raw.content || '', 1000000).text;
              files = filesOf(raw).map(publicFile);
            } catch (e) {
              complete = false;
              errors.push({ course_id: course.id, activity_id: summary.id, error: safeError(e) });
            }
          }
          const fields: string[] = [];
          if (String(summary.title).toLocaleLowerCase().includes(needle)) fields.push('title');
          const matchingFiles = files.filter(f => String(f.name).toLocaleLowerCase().includes(needle));
          if (matchingFiles.length) fields.push('file_name');
          const index = body.toLocaleLowerCase().indexOf(needle);
          if (index >= 0) fields.push('description');
          if (fields.length) {
            results.push({
              ...summary,
              course_name: course.name,
              files,
              matched_fields: fields,
              matching_files: matchingFiles,
              excerpt: index < 0 ? body.slice(0, 240) : body.slice(Math.max(0, index - 80), index + needle.length + 160),
            });
          }
        }
      } catch (e) {
        complete = false;
        errors.push({ course_id: course.id, error: safeError(e) });
      }
    }
    return {
      results: results.slice(offset, offset + limit),
      matched_count: results.length,
      activities_scanned: inspected,
      complete,
      next_offset: offset + limit < results.length ? offset + limit : null,
      errors,
      continuations,
      course_continuation: scope.continuation,
      semesters: scope.semesters,
      note: '检索活动标题、附件文件名和可选的活动正文；不搜索 PDF、Word 等附件内部文字。',
    };
  }
}
