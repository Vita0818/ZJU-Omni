import { z } from 'zod';
import type { FullTool } from '../../core/tools.ts';
import type { PtaServices } from './index.ts';
import { PROBLEM_TYPES } from './reads.ts';

export const ptaIdSchema = z.union([z.string().regex(/^[0-9]{1,24}$/), z.number().int().positive()]);
export const problemShape = {
  problem_set_id: ptaIdSchema,
  problem_id: ptaIdSchema,
  offset: z.number().int().min(0).max(1000000).default(0),
  max_characters: z.number().int().min(200).max(30000).default(16000),
};

export function ptaTools({ reader }: PtaServices): FullTool[] {
  const tool = (name: string, title: string, description: string, input: FullTool['input'], fn: (args: any) => Promise<unknown>): FullTool => ({ name, title, description, input, platform: 'pta', readOnly: true, run: fn });
  return [
    tool('pta_list_problem_sets', '我的题集（拼题A）', '列出本人加入的拼题A 题集及截止时间（默认只列未截止的），按截止时间排序。需要先在本机导入浏览器 Cookie。', { active_only: z.boolean().default(true), max_sets: z.number().int().min(1).max(100).default(30) }, args => reader.problemSets(args)),
    tool('pta_get_problem_set', '题集详情（拼题A）', '读取题集信息、各题型数量与分值、开始/截止时间和本人完成进度。', { problem_set_id: ptaIdSchema }, args => reader.problemSet(args)),
    tool('pta_list_problems', '题目列表（拼题A）', '列出题集中某一题型的题目（编号、标题、分值；导入 Cookie 后含本人状态）。省略 problem_type 时优先编程题、函数题。', { problem_set_id: ptaIdSchema, problem_type: z.enum(PROBLEM_TYPES).optional(), page: z.number().int().min(1).max(100).default(1), limit: z.number().int().min(1).max(200).default(50) }, args => reader.problems(args)),
    tool('pta_get_problem', '读取题面（拼题A）', '读取一道题的完整题面（Markdown，含公式）、时间/内存限制和分值。公开题集无需 Cookie。只读，不提交代码。', problemShape, args => reader.problem(args)),
  ];
}
