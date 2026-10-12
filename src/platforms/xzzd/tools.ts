import { z } from 'zod';
import type { FullTool, ToolBehavior } from '../../core/tools.ts';
import type { XzzdServices } from './index.ts';

export const identifier = z.union([z.string().regex(/^[1-9][0-9]*$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]);
const paging = { page: z.number().int().min(1).max(1000).default(1), page_size: z.number().int().min(1).max(100).default(30) };
export const scopeShape = {
  course_ids: z.array(identifier).min(1).max(100).optional(),
  semester_id: identifier.optional(),
  max_courses: z.number().int().min(1).max(100).default(50),
  max_pages: z.number().int().min(1).max(100).default(20),
  all_semesters: z.boolean().default(false),
};
export const submissionShape = {
  activity_id: identifier,
  file_paths: z.array(z.string().min(1)).max(20).default([]),
  comment: z.string().max(10000).optional(),
  submission_id: identifier.optional(),
  keep_upload_ids: z.array(identifier).max(20).optional(),
};
const bodyPaging = { offset: z.number().int().min(0).max(1000000).default(0), max_characters: z.number().int().min(100).max(24000).default(16000) };
export const statusEnum = z.enum(['all', 'pending', 'unsubmitted', 'submitted', 'draft', 'unknown']);
export const assignmentScanShape = {
  ...scopeShape,
  status: statusEnum.default('all'),
  include_submissions: z.boolean().default(true),
  include_closed: z.boolean().default(true),
  due_after: z.string().max(50).optional(),
  due_before: z.string().max(50).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(300).default(100),
};
export const searchShape = {
  ...scopeShape,
  keyword: z.string().min(1).max(120),
  types: z.array(z.string().max(60)).max(20).default([]),
  include_body: z.boolean().default(true),
  max_activities: z.number().int().min(1).max(1000).default(300),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
};
export const syncShape = {
  course_id: identifier,
  output_dir: z.string().min(1),
  activity_ids: z.array(identifier).min(1).max(200).optional(),
  include_assignments: z.boolean().default(true),
  dry_run: z.boolean().default(false),
  force: z.boolean().default(false),
  max_files: z.number().int().min(1).max(500).default(100),
  max_pages: z.number().int().min(1).max(100).default(20),
};
export const assignmentShape = { activity_id: identifier, ...bodyPaging };

export function xzzdTools(s: XzzdServices): FullTool[] {
  const { client, reader, actions, workflows, materials } = s;
  const tool = (name: string, title: string, description: string, input: FullTool['input'], fn: (args: any) => Promise<unknown>, behavior: ToolBehavior = {}): FullTool => ({
    name,
    title,
    description,
    input,
    platform: 'xzzd',
    ...behavior,
    run: args => client.withSession(() => fn(args), { readOnly: behavior.readOnly ?? true }),
  });
  return [
    tool('xzzd_list_semesters', '列出学期（学在浙大）', '读取当前账号可见的学期 ID，供按学期查询课程。', {}, () => reader.semesters()),
    tool('xzzd_list_courses', '查找我的课程（学在浙大）', '按课程名称和学期查询我的课程。返回 next_page 时继续翻页。历史课程优先使用明确 semester_id；原始 status 字段随平台版本变化。', { keyword: z.string().max(120).default(''), semester_id: identifier.optional(), ...paging }, args => reader.courses(args)),
    tool('xzzd_get_course', '读取课程详情', '获取指定课程名称、课程代码、说明和网页来源。course_id 来自我的课程列表。', { course_id: identifier }, args => reader.course(args.course_id)),
    tool('xzzd_list_todos', '查看课程待办', '读取平台待办及截止时间。待办列表不能证明所有作业都已提交；完整核对使用 xzzd_list_all_assignments。', {}, () => reader.todos()),
    tool('xzzd_list_activities', '查看课程活动与公告', '列出课程学习活动，包含类型和附件。可按平台返回的 type 筛选公告或资料，详情使用 xzzd_get_activity。', { course_id: identifier, type: z.string().max(60).optional(), ...paging }, args => reader.activities(args)),
    tool('xzzd_get_activity', '读取活动或公告', '读取课程活动正文、截止时间、附件和来源。长正文用 next_offset 继续。', { activity_id: identifier, ...bodyPaging }, args => reader.activity(args)),
    tool('xzzd_list_assignments', '查看课程作业', '分页读取作业。include_submissions=true 时核对本人／本人小组的提交、草稿、成绩和教师评语；状态查询失败明确报告为 unknown。', { course_id: identifier, include_submissions: z.boolean().default(false), ...paging }, args => reader.assignments(args)),
    tool('xzzd_get_assignment', '读取完整作业详情', '汇总作业要求、附件、开放／截止时间、提交次数限制、个人／小组目标及本人提交状态。草稿编号可用于编辑或正式提交。', assignmentShape, args => reader.assignment(args)),
    tool('xzzd_list_all_assignments', '跨课程汇总作业', '扫描指定课程或学期的作业并核对提交状态，按截止时间排序。pending 包含未交、草稿和未知状态。complete=false 时检查 errors 和 continuations；next_offset 表示结果分页。course_ids 与 semester_id 二选一；均省略时只扫描当前学期，all_semesters=true 扫描全部课程（较慢）。', assignmentScanShape, args => workflows.assignments(args)),
    tool('xzzd_list_materials', '查看课程课件', '分页读取课件活动和附件 ID。下载时需要对应 activity_id 和 upload_id。', { course_id: identifier, ...paging }, args => reader.materials(args)),
    tool('xzzd_download_file', '下载课件附件', '下载指定活动的附件到本机 output_dir。只接受活动中实际存在的文件 ID，返回本地路径和 SHA-256，不覆盖已有文件。', { activity_id: identifier, upload_id: identifier, output_dir: z.string().min(1) }, args => reader.download(args), { readOnly: false, idempotent: false }),
    tool('xzzd_get_submissions', '查看我的作业提交记录', '读取本人或本人所在小组的作业提交、草稿、附件、成绩和教师评语。操作结果不确定时使用本工具读回核对。', { activity_id: identifier }, args => reader.submissions(args)),
    tool('xzzd_download_submission_file', '下载本人作业附件', '从本人或本人小组的指定提交记录下载附件；不能使用其他同学或任意上传编号。', { activity_id: identifier, submission_id: identifier, upload_id: identifier, output_dir: z.string().min(1) }, args => reader.downloadSubmission(args), { readOnly: false, idempotent: false }),
    tool('xzzd_prepare_submission', '预览作业提交', '预览文字／附件作业正式提交，支持个人和本人小组。submission_id 指定现有草稿；省略 comment 保留草稿文字，省略 keep_upload_ids 保留草稿全部附件，空数组移除附件。file_paths 添加本地文件。文字与附件至少一项，附件合计最多 20 个，新上传总计不超过 100 MiB。预览不上传。', submissionShape, args => actions.prepare('submit', args), { readOnly: false }),
    tool('xzzd_prepare_draft', '预览保存作业草稿', '生成创建／编辑草稿的预览。参数语义同 xzzd_prepare_submission；提供 submission_id 编辑指定草稿。保存草稿会改变平台数据，小组草稿影响整个小组。', submissionShape, args => actions.prepare('draft', args), { readOnly: false }),
    tool('xzzd_save_draft', '保存作业草稿', '根据用户授权执行 xzzd_prepare_draft 预览，将文字和附件保存到平台草稿，不正式交付。检查 verified；结果不明先查提交记录，不重复写入。', { plan_id: z.string().uuid() }, args => actions.execute('draft', args.plan_id), { readOnly: false, destructive: true }),
    tool('xzzd_submit_assignment', '提交作业', '真实上传并交付预览对应的附件。仅依据用户对该课程、作业和文件的明确授权调用；若已有该具体授权，不重复询问。plan_id 来自 xzzd_prepare_submission。执行后核对 verified；结果未知不得自动重试。', { plan_id: z.string().uuid() }, args => actions.execute('submit', args.plan_id), { readOnly: false, destructive: true }),
    tool('xzzd_prepare_retraction', '预览作业撤回', '检查指定提交记录是否允许撤回，生成预览；不改变平台数据。submission_id 来自 xzzd_get_submissions。', { activity_id: identifier, submission_id: identifier }, args => actions.prepare('retract', args), { readOnly: false }),
    tool('xzzd_retract_assignment', '撤回作业', '将已交付作业撤回为草稿。仅在用户明确要求撤回预览对应的提交时调用。plan_id 来自 xzzd_prepare_retraction；核对 verified，结果不明时先读取提交状态。', { plan_id: z.string().uuid() }, args => actions.execute('retract', args.plan_id), { readOnly: false, destructive: true }),
    tool('xzzd_search_course_content', '搜索课程资料和作业要求', '跨课程搜索活动标题、附件文件名和可选的正文（默认当前学期，all_semesters=true 搜全部）。可按类型筛选；不搜索 PDF／Word 等附件内部文字。检查 complete、errors、continuations 和 next_offset。', searchShape, args => workflows.search(args)),
    tool('xzzd_sync_course_materials', '批量下载和同步课程资料', '首次批量下载课程课件及可选的作业要求附件，后续按更新时间和本地哈希增量同步。按课程和活动建目录，新版本另存，不删除或覆盖本地修改。dry_run=true 只检查；达到 max_files 后可重复运行继续。', syncShape, args => materials.sync(args), { readOnly: false, idempotent: true }),
  ];
}
