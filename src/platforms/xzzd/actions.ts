import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { ToolError, safeError } from '../../core/errors.ts';
import { privateDir, readJson, withLock, writePrivate } from '../../core/store.ts';
import { deadline, hash, id, plain, type Raw } from '../../core/util.ts';
import type { CourseReader, XzzdApi } from './reads.ts';
import { isGroupHomework, publicFile } from './shared.ts';

export type ActionKind = 'submit' | 'draft' | 'retract';

export interface SubmissionArgs {
  activity_id: unknown;
  file_paths?: string[];
  comment?: string;
  submission_id?: unknown;
  keep_upload_ids?: unknown[];
}

const normalizedComment = (value: unknown) => plain(value || '').replace(/\r\n/g, '\n').trim();
const textToHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
const groupKey = (group: Raw | null | undefined) => (group ? `${group.group_set_id}:${group.id}` : null);
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function submissionSnapshot(list: Raw[]): string {
  return hash(
    JSON.stringify(
      list
        .map(s => ({
          id: s.id,
          is_draft: s.is_draft,
          is_redo: s.is_redo,
          can_retract: s.can_retract,
          uploads: (s.uploads || []).map((u: Raw) => String(u.id)).sort(),
          comment: s.comment || '',
          updated_at: s.updated_at ?? null,
          slides: s.slides ?? [],
          other_resources: s.other_resources ?? [],
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ),
  );
}

interface LocalFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

export class CourseActions {
  readonly reader: CourseReader;
  readonly client: XzzdApi;
  readonly plansDir: string;

  constructor(reader: CourseReader) {
    this.reader = reader;
    this.client = reader.client;
    this.plansDir = join(reader.cfg.dataDir, 'plans', 'xzzd');
  }

  private get cfg() {
    return this.reader.cfg;
  }

  private async fingerprint(): Promise<string> {
    if (!this.client.sessionFingerprint) throw new ToolError('INTERNAL_ERROR', '当前客户端无法确认登录会话。');
    return this.client.sessionFingerprint();
  }

  async file(path: string): Promise<LocalFile> {
    if (!isAbsolute(path)) throw new ToolError('INVALID_PATH', '提交文件必须使用绝对路径。');
    let resolved: string;
    let info;
    try {
      resolved = await realpath(path);
      info = await stat(resolved);
    } catch {
      throw new ToolError('FILE_UNAVAILABLE', '提交文件不存在或无法读取。');
    }
    const stateRoot = await realpath(this.cfg.dataDir).catch(() => this.cfg.dataDir);
    const rel = relative(stateRoot, resolved);
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) {
      throw new ToolError('PRIVATE_STATE_FILE', '插件的登录会话和内部状态文件不能作为作业上传。');
    }
    if (!info.isFile() || info.size > this.cfg.maxFileBytes) throw new ToolError('FILE_TOO_LARGE', '请使用不超过 100 MiB 的普通文件。');
    const bytes = await readFile(resolved);
    if (bytes.length > this.cfg.maxFileBytes) throw new ToolError('FILE_TOO_LARGE', '文件超过 100 MiB。');
    return { path: resolved, name: basename(resolved), size: bytes.length, sha256: hash(bytes), bytes };
  }

  async target(activityId: unknown) {
    const activity = await this.reader.rawActivity(activityId);
    if (activity.type !== 'homework') throw new ToolError('UNSUPPORTED_ACTIVITY', '当前写入工具只支持 homework 类型的作业。');
    if (activity.data?.mode && activity.data.mode !== 'normal') throw new ToolError('UNSUPPORTED_HOMEWORK_MODE', '当前支持普通文字和附件作业；多选等特殊作业模式需要对应答题流程。');
    const course = await this.reader.course(activity.course_id);
    const { userId, group = null, list } = await this.reader.rawSubmissions(activity);
    if (isGroupHomework(activity) && !group) throw new ToolError('GROUP_UNAVAILABLE', '无法确认这份作业对应的本人小组。');
    return { activity, course, userId, group, list };
  }

  checkOpen(activity: Raw, kind: ActionKind): void {
    if (activity.is_closed === true) throw new ToolError('HOMEWORK_CLOSED', '平台标记这份作业已关闭。');
    if (activity.is_started === false) throw new ToolError('HOMEWORK_NOT_STARTED', '作业尚未开放。');
    const unlimited = activity.non_submit_times ?? activity.data?.non_submit_times;
    const limit = activity.submit_times ?? activity.data?.submit_times;
    if (kind === 'submit' && unlimited === false && typeof limit === 'number' && typeof activity.user_submit_count === 'number' && activity.user_submit_count >= limit) {
      throw new ToolError('SUBMISSION_LIMIT_REACHED', '当前账号已达到平台规定的提交次数。');
    }
  }

  async prepare(kind: ActionKind, args: SubmissionArgs) {
    if (!['submit', 'draft', 'retract'].includes(kind)) throw new ToolError('INVALID_ACTION', '未知作业操作。');
    await privateDir(this.plansDir);
    const session = await this.fingerprint();
    const { activity, course, userId, group, list } = await this.target(args.activity_id);
    const plan: Raw = {
      schema_version: 2,
      id: randomUUID(),
      kind,
      status: 'prepared',
      session,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      activity_id: id(activity.id),
      course_id: id(activity.course_id),
      user_id: userId,
      group,
      snapshot: submissionSnapshot(list),
      previous_ids: list.map(s => String(s.id)),
      course_name: course.name,
      activity_title: activity.title,
      url: this.reader.activityUrl(activity.course_id, activity.id),
    };
    if (kind !== 'retract') {
      this.checkOpen(activity, kind);
      const draft = args.submission_id == null ? null : list.find(s => String(s.id) === String(args.submission_id));
      if (args.submission_id != null && (!draft || draft.is_draft !== true)) {
        throw new ToolError('NOT_A_DRAFT', '只能编辑或提交本人／本人小组记录中明确标记为草稿的提交；已交作业需先按明确指令撤回。');
      }
      if (draft && ((draft.slides || []).length || (draft.other_resources || []).length || (draft.uploads_in_rich_text || []).length || /<(img|audio|video)\b/i.test(draft.comment || ''))) {
        throw new ToolError('UNSUPPORTED_DRAFT_CONTENT', '这份草稿含内嵌媒体或特殊资源，当前不能完整保留，请在网页编辑。');
      }
      if (draft) plan.submission_id = id(draft.id);
      const retained: Raw[] =
        args.keep_upload_ids === undefined
          ? draft?.uploads || []
          : args.keep_upload_ids.map(uploadId => {
              const file = (draft?.uploads || []).find((u: Raw) => String(u.id) === String(uploadId));
              if (!file) throw new ToolError('FILE_NOT_IN_SUBMISSION', '保留的附件必须来自所选草稿，不能引用任意上传编号。');
              return file;
            });
      plan.retained_files = retained.map(publicFile);
      if (new Set(retained.map(f => String(f.id))).size !== retained.length) throw new ToolError('DUPLICATE_FILE', '保留附件列表包含重复项。');
      const paths = args.file_paths || [];
      if (paths.length + retained.length > 20) throw new ToolError('TOO_MANY_FILES', '一次作业最多包含 20 个附件。');
      const files: Omit<LocalFile, 'bytes'>[] = [];
      let total = 0;
      for (const path of paths) {
        const { bytes: _bytes, ...file } = await this.file(path);
        total += file.size;
        files.push(file);
      }
      if (total > this.cfg.maxFileBytes) throw new ToolError('FILES_TOO_LARGE', '一次新上传文件总大小不能超过 100 MiB。');
      if (new Set(files.map(f => f.path)).size !== files.length) throw new ToolError('DUPLICATE_FILE', '文件列表包含重复项。');
      plan.files = files;
      plan.comment = args.comment === undefined ? draft?.comment || '' : textToHtml(args.comment.trim());
      if (!files.length && !retained.length && !normalizedComment(plan.comment)) throw new ToolError('EMPTY_SUBMISSION', '文字或附件至少提供一项，不能保存或提交空作业。');
    } else {
      const submission = list.find(s => String(s.id) === String(args.submission_id));
      if (!submission || submission.is_draft !== false) throw new ToolError('NOT_SUBMITTED', '所选记录不是已交付的作业。');
      if (submission.can_retract !== true || activity.data?.allow_retract === false) throw new ToolError('RETRACTION_UNAVAILABLE', '平台未明确允许撤回这次提交。');
      plan.submission_id = id(submission.id);
    }
    if (session !== (await this.fingerprint())) throw new ToolError('SESSION_CHANGED', '登录账号或会话已更换，请重新预览。');
    await writePrivate(join(this.plansDir, `${plan.id}.json`), plan);
    return {
      plan_id: plan.id as string,
      operation: { submit: '提交作业', draft: '保存作业草稿', retract: '撤回作业' }[kind],
      course: course.name,
      assignment: activity.title,
      activity_id: plan.activity_id,
      group,
      files: plan.files,
      retained_files: plan.retained_files,
      comment: plan.comment == null ? undefined : normalizedComment(plan.comment),
      submission_id: plan.submission_id,
      deadline: deadline(activity.end_time),
      expires_at: plan.expires_at,
      source_url: plan.url,
      note: '已生成操作预览，尚未上传或改变平台数据。小组操作会影响整个小组；预览编号本身不代表用户授权。',
    };
  }

  async execute(kind: ActionKind, planId: string) {
    if (!PLAN_ID.test(planId)) throw new ToolError('INVALID_PLAN', '无效操作预览编号。');
    await privateDir(this.plansDir);
    const path = join(this.plansDir, `${planId}.json`);
    return withLock(`${path}.lock`, async () => {
      const plan = await readJson<Raw>(path);
      if (!plan || plan.kind !== kind) throw new ToolError('INVALID_PLAN', '该预览不存在或操作类型不匹配。');
      if (plan.schema_version !== 2) throw new ToolError('PLAN_VERSION_UNSUPPORTED', '插件已升级，请重新生成操作预览。');
      return withLock(join(this.plansDir, `activity-${id(plan.activity_id)}.lock`), () => this.executeLocked(plan, path), '该作业有操作正在执行或上次结果未知。请先查询提交状态，勿重复提交。');
    }, '该操作正在执行或上次结果未知。请先查询提交状态，勿重复提交。');
  }

  private async executeLocked(plan: Raw, path: string) {
    const kind = plan.kind as ActionKind;
    if (plan.status !== 'prepared') throw new ToolError('PLAN_CONSUMED', '该预览已经执行过。请先查询平台状态，不能重复执行。', { previous_status: plan.status });
    if (Date.parse(plan.expires_at) < Date.now()) throw new ToolError('PLAN_EXPIRED', '操作预览已超过 15 分钟，请重新生成。');
    if (plan.session !== (await this.fingerprint())) throw new ToolError('SESSION_CHANGED', '登录会话已更换，请重新预览。');
    const current = await this.target(plan.activity_id);
    if (id(current.activity.course_id) !== plan.course_id || current.userId !== plan.user_id || groupKey(current.group) !== groupKey(plan.group) || submissionSnapshot(current.list) !== plan.snapshot) {
      throw new ToolError('PLATFORM_STATE_CHANGED', '作业提交状态或所属小组已改变，请读取最新状态并重新预览。');
    }
    const files: LocalFile[] = [];
    if (kind !== 'retract') {
      this.checkOpen(current.activity, kind);
      for (const expected of plan.files as Raw[]) {
        const actual = await this.file(expected.path);
        if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new ToolError('FILE_CHANGED', '文件内容在预览后发生变化，请重新预览。');
        files.push(actual);
      }
    } else {
      const selected = current.list.find(s => String(s.id) === plan.submission_id);
      if (selected?.can_retract !== true || current.activity.data?.allow_retract === false) throw new ToolError('RETRACTION_UNAVAILABLE', '平台现在不允许撤回。');
    }
    if (plan.session !== (await this.fingerprint())) throw new ToolError('SESSION_CHANGED', '登录会话已更换，请重新预览。');
    plan.status = 'executing';
    plan.executed_at = new Date().toISOString();
    await writePrivate(path, plan);
    try {
      let outcome: Raw;
      if (kind !== 'retract') {
        const uploadIds: string[] = (plan.retained_files as Raw[]).map(f => id(f.id));
        for (const file of files) {
          const reservation = await this.client.json('/api/uploads', {
            method: 'POST',
            body: { name: file.name, size: file.size, parent_type: 'submission_upload', parent_id: 0, is_scorm: false, embed_material_type: '' },
          });
          if (!reservation.id || !reservation.upload_url) throw new ToolError('UPLOAD_SCHEMA_CHANGED', '上传占位响应格式无法识别，作业尚未提交。');
          if (reservation.created_by_id != null && String(reservation.created_by_id) !== plan.user_id) throw new ToolError('IDENTITY_CHANGED', '上传身份与预览身份不一致，已停止提交。');
          if (!this.client.uploadBytes) throw new ToolError('INTERNAL_ERROR', '当前客户端不支持上传。');
          await this.client.uploadBytes(reservation.upload_url, file.bytes, file.name);
          uploadIds.push(id(reservation.id));
        }
        plan.upload_ids = uploadIds;
        await writePrivate(path, plan);
        const response = await this.client.json(`/api/course/activities/${plan.activity_id}/submissions`, {
          method: plan.submission_id ? 'PUT' : 'POST',
          body: {
            uploads: uploadIds.map(Number),
            comment: plan.comment,
            slides: [],
            is_draft: kind === 'draft',
            mode: 'normal',
            other_resources: [],
            uploads_in_rich_text: [],
            ...(plan.submission_id ? { submission_id: Number(plan.submission_id) } : {}),
          },
        });
        if (response.submission?.id != null) plan.result_submission_id = id(response.submission.id);
        outcome = await this.verifySubmission(plan, current.activity);
      } else {
        await this.client.json(`/api/submissions/${plan.submission_id}/retract`, { method: 'PUT', body: {} });
        outcome = await this.verifyRetraction(plan, current.activity);
      }
      plan.status = outcome.verified ? 'verified' : 'unverified';
      plan.result = outcome;
      await writePrivate(path, plan);
      return outcome;
    } catch (e) {
      plan.status = 'failed_or_unknown';
      plan.error = safeError(e);
      await writePrivate(path, plan);
      throw e;
    }
  }

  private async verifySubmission(plan: Raw, activity: Raw): Promise<Raw> {
    try {
      const { list, group = null } = await this.reader.rawSubmissions(activity);
      const match =
        groupKey(group) === groupKey(plan.group) &&
        list.find(
          s =>
            (plan.submission_id ? String(s.id) === plan.submission_id : !plan.previous_ids.includes(String(s.id)) && (!plan.result_submission_id || String(s.id) === plan.result_submission_id)) &&
            s.is_draft === (plan.kind === 'draft') &&
            normalizedComment(s.comment) === normalizedComment(plan.comment) &&
            (s.uploads || []).length === plan.upload_ids.length &&
            plan.upload_ids.every((uploadId: string) => s.uploads.some((u: Raw) => String(u.id) === uploadId)),
        );
      if (match) {
        return { status: plan.kind === 'draft' ? 'draft_saved' : 'submitted', verified: true, group, submission: this.reader.publicSubmission(match), source_url: plan.url };
      }
    } catch {}
    return this.unverified(plan, '接口已接受操作，但尚未从本人／本人小组记录中核对到匹配的提交编号、文字、附件和草稿状态。');
  }

  private async verifyRetraction(plan: Raw, activity: Raw): Promise<Raw> {
    try {
      const { list, group = null } = await this.reader.rawSubmissions(activity);
      const match = groupKey(group) === groupKey(plan.group) && list.find(s => String(s.id) === plan.submission_id && s.is_draft === true);
      if (match) return { status: 'retracted', verified: true, group, submission_id: plan.submission_id, source_url: plan.url };
    } catch {}
    return this.unverified(plan, '撤回接口已接受操作，但尚未验证草稿状态。');
  }

  private unverified(plan: Raw, message: string): Raw {
    return { status: 'accepted_unverified', verified: false, source_url: plan.url, note: `${message}请查询 xzzd_get_submissions，勿自动重复写入。` };
  }
}
