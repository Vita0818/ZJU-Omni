import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { ToolError, safeError } from '../../core/errors.ts';
import { boundedText, deadline, hash, id, pageInfo, requiredArray, type Raw } from '../../core/util.ts';
import type { JsonOptions, XzzdConfig } from './client.ts';
import { filesOf, isGroupHomework, publicFile, submissionState } from './shared.ts';

export interface XzzdApi {
  cfg: XzzdConfig;
  json(path: string, options?: JsonOptions): Promise<Raw>;
  listCourses?(query: Raw): Promise<Raw>;
  currentUserId?(): Promise<string>;
  downloadBytes?(uploadId: string): Promise<{ bytes: Buffer; contentType: string }>;
  uploadBytes?(url: string, buffer: Buffer, name: string): Promise<void>;
  sessionFingerprint?(): Promise<string>;
}

export interface Paging {
  page?: number;
  page_size?: number;
}

export class CourseReader {
  readonly client: XzzdApi;
  readonly cfg: XzzdConfig;

  constructor(client: XzzdApi) {
    this.client = client;
    this.cfg = client.cfg;
  }

  courseUrl(courseId: unknown): string {
    return `${this.cfg.baseUrl}/course/${id(courseId)}/content`;
  }

  activityUrl(courseId: unknown, activityId: unknown): string {
    return `${this.cfg.baseUrl}/course/${id(courseId)}/learning-activity/full-screen#/${id(activityId)}`;
  }

  async courses(args: { keyword?: string; semester_id?: unknown } & Paging = {}) {
    const data = this.client.listCourses ? await this.client.listCourses(args) : await this.client.json('/api/my-courses', { method: 'POST', readOnly: true, body: args });
    const rows = requiredArray(data, 'courses');
    return {
      courses: rows.map(c => ({
        id: c.id,
        name: c.name,
        course_code: c.course_code,
        status: c.status ?? null,
        semester: c.semester?.name ?? null,
        semester_id: c.semester?.id ?? null,
        academic_year: c.academic_year?.name ?? null,
        instructors: (c.instructors || []).map((x: Raw) => x.name),
        url: this.courseUrl(c.id),
      })),
      ...pageInfo(data, args.page || 1, args.page_size || 30, rows.length),
    };
  }

  async semesters() {
    const data = await this.client.json('/api/my-semesters');
    return { semesters: requiredArray(data, 'semesters').map(s => ({ id: s.id, name: s.name, is_active: s.is_active ?? null })) };
  }

  async course(courseId: unknown) {
    const raw = await this.client.json(`/api/courses/${id(courseId)}`);
    const c = raw.course || raw;
    if (String(c.id) !== String(courseId)) throw new ToolError('SCHEMA_CHANGED', '课程详情 ID 与请求不一致。');
    return { id: c.id, name: c.name, course_code: c.course_code, description: boundedText(c.description || c.introduction), url: this.courseUrl(c.id) };
  }

  async todos() {
    const data = await this.client.json('/api/todos');
    return {
      todos: requiredArray(data, 'todo_list').map(t => ({
        id: t.id,
        title: t.title,
        type: t.type,
        course_id: t.course_id ?? null,
        course_name: t.course_name ?? null,
        deadline: deadline(t.end_time),
        url: t.course_id ? this.activityUrl(t.course_id, t.id) : `${this.cfg.baseUrl}/user/index`,
      })),
      note: '平台待办列表不等于全部未交作业；核对某门课的完整作业请调用 xzzd_list_assignments。',
    };
  }

  activitySummary(a: Raw, courseId: unknown) {
    return {
      id: a.id,
      course_id: a.course_id ?? courseId,
      title: a.title ?? '',
      type: a.type ?? null,
      deadline: deadline(a.end_time),
      submitted: typeof a.submitted === 'boolean' ? a.submitted : null,
      is_closed: typeof a.is_closed === 'boolean' ? a.is_closed : null,
      start_time: deadline(a.start_time),
      is_started: a.is_started ?? null,
      is_group: isGroupHomework(a),
      group_set_id: a.group_set_id ?? null,
      module_id: a.module_id ?? null,
      syllabus_id: a.syllabus_id ?? null,
      updated_at: a.updated_at ?? null,
      weight_percent: a.score_percentage ?? a.data?.score_percentage ?? null,
      files: filesOf(a).map(publicFile),
      url: this.activityUrl(a.course_id ?? courseId, a.id),
    };
  }

  async activities({ course_id, page = 1, page_size = 30, type }: { course_id: unknown; type?: string } & Paging) {
    const data = await this.client.json(`/api/courses/${id(course_id)}/activities`, { query: { sub_course_id: 0, page, page_size } });
    if (data.pages != null || data.page != null) {
      const raw = requiredArray(data, 'activities');
      return { activities: raw.filter(a => !type || a.type === type).map(a => this.activitySummary(a, course_id)), ...pageInfo(data, page, page_size, raw.length) };
    }
    const rows = requiredArray(data, 'activities').filter(a => !type || a.type === type);
    const items = rows.slice((page - 1) * page_size, page * page_size);
    return { activities: items.map(a => this.activitySummary(a, course_id)), ...pageInfo({ total: rows.length }, page, page_size, items.length) };
  }

  async assignments({ course_id, page = 1, page_size = 30, include_submissions = false }: { course_id: unknown; include_submissions?: boolean } & Paging) {
    const data = await this.client.json(`/api/courses/${id(course_id)}/homework-activities`, { query: { page, page_size } });
    const rows = requiredArray(data, 'homework_activities');
    const assignments: Raw[] = [];
    let userId: string | undefined;
    let identityError: Raw | undefined;
    if (include_submissions && rows.length) {
      try {
        userId = await this.currentUserId(course_id);
      } catch (e) {
        identityError = safeError(e);
      }
    }
    for (const a of rows) {
      const summary: Raw = this.activitySummary(a, course_id);
      if (include_submissions) {
        if (identityError) Object.assign(summary, { submission_status: 'unknown', submission_error: identityError });
        else Object.assign(summary, await this.assignmentSubmission({ ...a, course_id: a.course_id ?? course_id }, userId));
      }
      assignments.push(summary);
    }
    return { assignments, ...pageInfo(data, page, page_size, rows.length) };
  }

  async rawActivity(activityId: unknown): Promise<Raw> {
    const a = await this.client.json(`/api/activities/${id(activityId)}`, { query: { sub_course_id: 0 } });
    if (String(a.id) !== String(activityId) || !a.course_id) throw new ToolError('SCHEMA_CHANGED', '活动详情 ID 或所属课程无法确认。');
    return a;
  }

  async activity({ activity_id, offset = 0, max_characters = 16000 }: { activity_id: unknown; offset?: number; max_characters?: number }) {
    const a = await this.rawActivity(activity_id);
    const text = boundedText(a.description || a.data?.description || a.content || '', 1000000);
    return {
      ...this.activitySummary(a, a.course_id),
      description: text.text.slice(offset, offset + max_characters),
      next_offset: offset + max_characters < text.total_characters ? offset + max_characters : null,
      total_characters: text.total_characters,
      allow_retract: typeof a.data?.allow_retract === 'boolean' ? a.data.allow_retract : null,
    };
  }

  async materials({ course_id, page = 1, page_size = 30 }: { course_id: unknown } & Paging) {
    const conditions = JSON.stringify({ category: null, itemsSortBy: { predicate: 'chapter', reverse: false }, ignore_activity_types: ['lesson'] });
    const data = await this.client.json(`/api/course/${id(course_id)}/coursewares`, { query: { page, page_size, conditions } });
    const rows = requiredArray(data, 'activities');
    return { activities: rows.map(a => this.activitySummary(a, course_id)), ...pageInfo(data, page, page_size, rows.length) };
  }

  async currentUserId(courseId: unknown): Promise<string> {
    if (this.client.currentUserId) return this.client.currentUserId();
    const data = await this.client.json(`/api/course/${id(courseId)}/activity-reads-for-user`);
    const records = requiredArray(data, 'activity_reads');
    const ids = [...new Set(records.map(r => r.created_for_id).filter(x => x != null).map(String))];
    if (ids.length !== 1) throw new ToolError('IDENTITY_UNAVAILABLE', '平台未返回唯一的当前学生 ID，无法可靠查询本人的提交记录。');
    return id(ids[0]);
  }

  async rawSubmissions(activity: Raw, knownUserId?: string): Promise<{ userId: string; group: Raw | null; list: Raw[] }> {
    const userId = knownUserId || (await this.currentUserId(activity.course_id));
    let group: Raw | null = null;
    if (isGroupHomework(activity)) {
      if (!activity.group_set_id) throw new ToolError('GROUP_UNAVAILABLE', '小组作业未返回分组方案，无法确认本人小组。');
      const data = await this.client.json(`/api/group-sets/${id(activity.group_set_id)}/group`);
      if (!data.group?.id) throw new ToolError('GROUP_UNAVAILABLE', '当前账号尚未加入这份作业对应的小组。');
      group = { id: id(data.group.id), name: data.group.name ?? '', group_set_id: id(activity.group_set_id) };
    }
    const target = group ? `groups/${group.id}` : `students/${id(userId)}`;
    const data = await this.client.json(`/api/activities/${id(activity.id)}/${target}/submission_list`);
    return { userId, group, list: requiredArray(data, 'list') };
  }

  publicSubmission(s: Raw) {
    return {
      id: s.id,
      is_draft: s.is_draft ?? null,
      is_latest_version: s.is_latest_version ?? null,
      is_redo: s.is_redo ?? null,
      can_retract: s.can_retract ?? null,
      submitted_at: deadline(s.submitted_at),
      updated_at: s.updated_at ?? null,
      uploads: (s.uploads || []).map(publicFile),
      comment: boundedText(s.comment, 10000),
      score: s.final_score ?? s.score ?? s.submission_correct?.instructor_score ?? null,
      graded_at: deadline(s.score_at),
      instructor_comment: boundedText(s.instructor_comment ?? s.submission_correct?.comment, 10000),
    };
  }

  async assignmentSubmission(activity: Raw, userId?: string): Promise<Raw> {
    try {
      const { list, group } = await this.rawSubmissions(activity, userId);
      const latest = list.find(s => s.is_latest_version === true) || list.find(s => s.is_draft === false && s.is_redo !== true) || list[0];
      return {
        submission_status: submissionState(list, activity.submitted),
        group,
        latest_submission: latest ? this.publicSubmission(latest) : null,
        submission_count: list.length,
        draft_ids: list.filter(s => s.is_draft === true).map(s => s.id),
      };
    } catch (e) {
      return { submission_status: 'unknown', submission_error: safeError(e) };
    }
  }

  async assignment({ activity_id, offset = 0, max_characters = 16000 }: { activity_id: unknown; offset?: number; max_characters?: number }) {
    const a = await this.rawActivity(activity_id);
    if (a.type !== 'homework') throw new ToolError('UNSUPPORTED_ACTIVITY', '所选活动不是作业。');
    const body = boundedText(a.description || a.data?.description || a.content || '', 1000000);
    return {
      ...this.activitySummary(a, a.course_id),
      description: body.text.slice(offset, offset + max_characters),
      next_offset: offset + max_characters < body.text.length ? offset + max_characters : null,
      total_characters: body.total_characters,
      requirements: {
        homework_type: a.data?.homework_type ?? null,
        mode: a.data?.mode ?? 'normal',
        allow_retract: a.data?.allow_retract ?? null,
        unlimited_submissions: a.non_submit_times ?? a.data?.non_submit_times ?? null,
        max_submissions: a.submit_times ?? a.data?.submit_times ?? null,
        user_submit_count: a.user_submit_count ?? null,
      },
      ...(await this.assignmentSubmission(a)),
    };
  }

  async submissions({ activity_id }: { activity_id: unknown }) {
    const activity = await this.rawActivity(activity_id);
    const { list, group } = await this.rawSubmissions(activity);
    return {
      activity_id,
      title: activity.title,
      group,
      submission_status: submissionState(list, activity.submitted),
      url: this.activityUrl(activity.course_id, activity.id),
      submissions: list.map(s => this.publicSubmission(s)),
    };
  }

  async download({ activity_id, upload_id, output_dir }: { activity_id: unknown; upload_id: unknown; output_dir: string }) {
    if (!isAbsolute(output_dir)) throw new ToolError('INVALID_PATH', 'output_dir 必须是本地绝对路径。');
    const activity = await this.rawActivity(activity_id);
    const file = filesOf(activity).find(f => String(f.id ?? f.upload_id) === String(upload_id));
    if (!file) throw new ToolError('FILE_NOT_IN_ACTIVITY', '所选文件不在该活动附件列表中，请重新读取活动详情。');
    return this.saveFile(file, upload_id, output_dir, this.activityUrl(activity.course_id, activity.id));
  }

  async downloadSubmission({ activity_id, submission_id, upload_id, output_dir }: { activity_id: unknown; submission_id: unknown; upload_id: unknown; output_dir: string }) {
    const activity = await this.rawActivity(activity_id);
    const { list } = await this.rawSubmissions(activity);
    const submission = list.find(s => String(s.id) === String(submission_id));
    if (!submission) throw new ToolError('SUBMISSION_NOT_FOUND', '所选提交不在本人或本人小组的记录中。');
    const file = (submission.uploads || []).find((f: Raw) => String(f.id ?? f.upload_id) === String(upload_id));
    if (!file) throw new ToolError('FILE_NOT_IN_SUBMISSION', '所选附件不属于这份提交记录。');
    return this.saveFile(file, upload_id, output_dir, this.activityUrl(activity.course_id, activity.id));
  }

  async saveFile(file: Raw, upload_id: unknown, output_dir: string, source_url: string) {
    if (!isAbsolute(output_dir)) throw new ToolError('INVALID_PATH', 'output_dir 必须是本地绝对路径。');
    if (file.allow_download === false) throw new ToolError('DOWNLOAD_NOT_ALLOWED', '平台未允许下载此附件，请在课程页面中查看。');
    if (!this.client.downloadBytes) throw new ToolError('INTERNAL_ERROR', '当前客户端不支持下载。');
    const filename = `${id(upload_id)}-${basename(file.name || file.file_name || 'material').replace(/[\x00-\x1f\\/]/g, '_')}`;
    const result = await this.client.downloadBytes(id(upload_id));
    if (/text\/html/i.test(result.contentType) && !/\.html?$/i.test(filename)) throw new ToolError('UNEXPECTED_RESPONSE', '下载返回了网页，未将它保存为课件。');
    await mkdir(output_dir, { recursive: true });
    const path = join(output_dir, filename);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (e: any) {
      if (e?.code === 'EEXIST') throw new ToolError('FILE_EXISTS', '目标文件已存在，请选择其他目录。');
      throw e;
    }
    try {
      await handle.writeFile(result.bytes);
    } catch (e) {
      await handle.close();
      handle = null;
      await unlink(path);
      throw e;
    } finally {
      if (handle) await handle.close();
    }
    return { path, name: filename, bytes: result.bytes.length, sha256: hash(result.bytes), source_url };
  }
}
