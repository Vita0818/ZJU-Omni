import { z } from 'zod';
import type { FullTool, ToolBehavior } from '../../core/tools.ts';
import { identifier } from '../xzzd/tools.ts';
import type { ZhiyunServices } from './index.ts';

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
export const myLecturesShape = { date: dateString.optional(), days: z.number().int().min(1).max(14).default(1) };
export const transcriptShape = {
  sub_id: identifier,
  offset: z.number().int().min(0).max(5000000).default(0),
  max_characters: z.number().int().min(200).max(30000).default(16000),
  with_timestamps: z.boolean().default(true),
};
export const courseLecturesShape = { course_id: identifier };

export function zhiyunTools({ client, reader }: ZhiyunServices): FullTool[] {
  const tool = (name: string, title: string, description: string, input: FullTool['input'], fn: (args: any) => Promise<unknown>, behavior: ToolBehavior = {}): FullTool => ({
    name,
    title,
    description,
    input,
    platform: 'zhiyun',
    ...behavior,
    run: args => client.withSession(() => fn(args), { readOnly: behavior.readOnly ?? true }),
  });
  return [
    tool('zhiyun_my_lectures', '我的课堂回放（智云）', '列出本人课表在指定日期（默认今天，北京时间）及之前 days 天的智云课堂堂次，返回 course_id、sub_id、开课时间。旁听课不在此列表。', myLecturesShape, args => reader.myLectures(args)),
    tool('zhiyun_search_courses', '搜索智云课程', '按课程名和教师搜索智云课堂课程，返回智云 course_id（与学在浙大课程 ID 不同）。', { keyword: z.string().max(80).default(''), teacher: z.string().max(40).default(''), page: z.number().int().min(1).max(100).default(1) }, args => reader.searchCourses(args)),
    tool('zhiyun_list_lectures', '列出课程全部堂次（智云）', '列出某门智云课程的所有堂次（sub_id、标题、教师、开课时间），按时间排序。', courseLecturesShape, args => reader.courseLectures(args)),
    tool('zhiyun_get_transcript', '读取课堂转录（智云）', '读取某堂课的自动语音转录全文，每行带录像内时间戳。长文按 next_offset 续读；available=false 表示暂无转录。转录可能有识别错误。', transcriptShape, args => reader.transcript(args)),
    tool('zhiyun_get_ppt_timeline', '读取 PPT 时间轴（智云）', '列出某堂课自动截取的 PPT 页（图片地址，平台提供时附录像内时间）。需要 course_id 和 sub_id。', { course_id: identifier, sub_id: identifier }, args => reader.slides(args)),
    tool('zhiyun_download_ppt', '下载 PPT 截图（智云）', '把某堂课的 PPT 截图按页序下载到本机 output_dir 下的子目录，不覆盖已有文件，不携带登录 Cookie。', { course_id: identifier, sub_id: identifier, output_dir: z.string().min(1), max_files: z.number().int().min(1).max(500).default(300) }, args => reader.downloadSlides(args), { readOnly: false, idempotent: true }),
  ];
}
