import { z } from 'zod';
import type { FullTool } from '../../core/tools.ts';
import type { ZdbkServices } from './index.ts';
import { TERMS } from './parse.ts';

export const academicYear = z.string().regex(/^\d{4}-\d{4}$/, '学年格式应为 2025-2026');
export const semester = z.union([z.literal(1), z.literal(2)]);
export const term = z.enum(TERMS);
export const gradesShape = { academic_year: academicYear.optional(), semester: semester.optional(), major_only: z.boolean().default(false) };
export const examsShape = { academic_year: academicYear.optional(), semester: semester.optional(), upcoming_only: z.boolean().default(false) };
export const timetableShape = { academic_year: academicYear.optional(), term: term.optional() };

export function zdbkTools({ client, reader }: ZdbkServices): FullTool[] {
  const tool = (name: string, title: string, description: string, input: FullTool['input'], fn: (args: any) => Promise<unknown>): FullTool => ({
    name,
    title,
    description,
    input,
    platform: 'zdbk',
    readOnly: true,
    run: args => client.withSession(() => fn(args)),
  });
  return [
    tool('zdbk_get_timetable', '查看课表（教务）', '读取本科教务系统的个人课表。academic_year 如 2025-2026，term 为 秋/冬/春/夏；省略时按当前日期推断（inferred_term=true）。返回星期、节次、推算时间、单双周、教师和地点。教务要求验证码时停止并说明。', timetableShape, args => reader.timetable(args)),
    tool('zdbk_list_grades', '查询成绩（教务）', '读取本科教务系统成绩，可按学年、学期（1=秋冬，2=春夏）筛选；major_only=true 只看主修课程。附本地计算的 GPA 摘要（五分制、4.3 制、加权均分），以官方成绩单为准。', gradesShape, args => reader.grades(args)),
    tool('zdbk_gpa_summary', '绩点汇总（教务）', '汇总全部课程与主修课程的 GPA、获得学分，以及按学期（如 2025-2026-1）的绩点。本地计算，以官方成绩单为准。', {}, () => reader.gpaSummary()),
    tool('zdbk_list_exams', '查询考试安排（教务）', '读取本科教务系统的期中、期末考试安排（时间、考场、座位号），按时间排序。upcoming_only=true 只看尚未结束的考试；尚未排定日期的考试保留 time_text。', examsShape, args => reader.exams(args)),
  ];
}
