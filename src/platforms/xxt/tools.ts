import { z } from 'zod';
import type { FullTool } from '../../core/tools.ts';
import type { XxtServices } from './index.ts';

export function xxtTools({ reader }: XxtServices): FullTool[] {
  const tool = (name: string, title: string, description: string, input: FullTool['input'], fn: (args: any) => Promise<unknown>): FullTool => ({ name, title, description, input, platform: 'xxt', readOnly: true, run: fn });
  return [
    tool('xxt_list_courses', '学习通课程', '列出学习通中本人的课程（课程 ID、教师）。需要先在本机导入浏览器 Cookie。', {}, () => reader.listCourses()),
    tool('xxt_list_homework', '学习通作业列表', '列出某门课的作业及状态。course 为课名关键词或课程 ID。', { course: z.string().min(1).max(60) }, args => reader.listHomework(args)),
    tool('xxt_homework_deadlines', '学习通作业截止', '汇总未完成作业及截止时间（逐份读取详情，较慢）。可用 course 限定一门课，horizon_days 只看未来若干天内截止的。', { course: z.string().max(60).optional(), horizon_days: z.number().int().min(1).max(365).default(90), max_courses: z.number().int().min(1).max(60).default(30) }, args => reader.deadlines(args)),
    tool('xxt_list_exams', '学习通考试', '列出学习通考试安排（时间、时长、状态、分数）。', {}, () => reader.exams()),
    tool('xxt_list_notices', '学习通通知', '读取学习通通知（标题、发送人、正文摘要），可只看未读或按关键词筛选；不会标记已读。', { limit: z.number().int().min(1).max(100).default(20), unread_only: z.boolean().default(false), keyword: z.string().max(40).default('') }, args => reader.notices(args)),
    tool('xxt_get_schedule', '学习通课表', '读取学习通课表的某一周（默认当前周）。', { week: z.number().int().min(1).max(30).optional() }, args => reader.schedule(args)),
  ];
}
