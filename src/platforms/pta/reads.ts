import { ToolError, safeError } from '../../core/errors.ts';
import { deadline, type Raw } from '../../core/util.ts';
import { PTA_BASE, type PtaApi } from './client.ts';

export const PROBLEM_TYPES = ['PROGRAMMING', 'CODE_COMPLETION', 'MULTIPLE_FILE', 'TRUE_OR_FALSE', 'MULTIPLE_CHOICE', 'MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER', 'FILL_IN_THE_BLANK', 'FILL_IN_THE_BLANK_FOR_PROGRAMMING', 'SUBJECTIVE'] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];
const TYPE_LABELS: Record<string, string> = {
  PROGRAMMING: '编程题', CODE_COMPLETION: '函数题', MULTIPLE_FILE: '多文件编程', TRUE_OR_FALSE: '判断题', MULTIPLE_CHOICE: '单选题',
  MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER: '多选题', FILL_IN_THE_BLANK: '填空题', FILL_IN_THE_BLANK_FOR_PROGRAMMING: '程序填空题', SUBJECTIVE: '主观题',
};

const ID = /^[0-9]{1,24}$/;
export function ptaId(value: unknown, label = 'ID'): string {
  const s = String(value ?? '').trim();
  if (!ID.test(s)) throw new ToolError('INVALID_ID', `拼题A ${label} 应为数字串（取自题集或题目网址）。`);
  return s;
}

const text = (value: unknown) => (value == null ? '' : String(value)).trim();
// PTA uses the Unix epoch as "no deadline".
const ptaDeadline = (value: unknown) => (/^1970-01-01T/.test(text(value)) ? deadline(null) : deadline(value));

export class PtaReader {
  readonly api: PtaApi;
  readonly now: () => Date;
  constructor(api: PtaApi, now: () => Date = () => new Date()) {
    this.api = api;
    this.now = now;
  }

  setUrl(id: string, problemId?: string, type?: string) {
    const pageType = type === 'PROGRAMMING' ? 7 : type === 'CODE_COMPLETION' ? 6 : null;
    return problemId && pageType ? `${PTA_BASE}/problem-sets/${id}/exam/problems/type/${pageType}?problemSetProblemId=${problemId}` : `${PTA_BASE}/problem-sets/${id}/exam/overview`;
  }

  private async exam(id: string): Promise<Raw> {
    return this.api.get(`/api/problem-sets/${id}/exams`);
  }

  private summarize(set: Raw, exam: Raw | null) {
    const e = exam?.exam ?? null;
    return {
      id: String(set.id),
      name: text(set.name) || '(无标题)',
      organization: text(set.organizationName) || null,
      owner: text(set.ownerNickname) || null,
      time_type: text(set.timeType) || null,
      status: text(exam?.status ?? set.status) || null,
      starts_at: ptaDeadline(e?.startAt ?? set.startAt),
      ends_at: ptaDeadline(e?.endAt ?? set.endAt),
      ended: typeof e?.ended === 'boolean' ? e.ended : null,
      score: e?.score ?? null,
      url: this.setUrl(String(set.id)),
    };
  }

  async problemSets({ active_only = true, max_sets = 30 }: { active_only?: boolean; max_sets?: number } = {}) {
    const filter = active_only ? JSON.stringify({ endAtAfter: this.now().toISOString() }) : '{}';
    const data = await this.api.get('/api/problem-sets', { filter }, { requireCookie: true });
    if (!Array.isArray(data.problemSets)) throw new ToolError('SCHEMA_CHANGED', '拼题A 题集列表缺少 problemSets。');
    const sets: Raw[] = data.problemSets;
    const rows = [];
    const errors: Raw[] = [];
    for (const set of sets.slice(0, max_sets)) {
      let exam: Raw | null = null;
      try {
        exam = await this.exam(String(set.id));
      } catch (e) {
        errors.push({ problem_set_id: String(set.id), error: safeError(e) });
      }
      rows.push(this.summarize(set, exam));
    }
    rows.sort((a, b) => (a.ends_at.iso ? Date.parse(a.ends_at.iso) : Infinity) - (b.ends_at.iso ? Date.parse(b.ends_at.iso) : Infinity));
    return { active_only, problem_sets: rows, total: sets.length, truncated: sets.length > max_sets, errors, note: 'ends_at 为题集（考试）截止时间。只读：不会替你开始考试或创建考试记录。' };
  }

  async progress(id: string): Promise<{ total: number; accepted: number; by_status: Record<string, number> } | null> {
    const data = await this.api.get(`/api/problem-sets/${id}/exam-problem-status`, {}, { requireCookie: true });
    if (!Array.isArray(data.problemStatus)) return null;
    const by: Record<string, number> = {};
    for (const p of data.problemStatus as Raw[]) by[text(p.problemSubmissionStatus) || 'UNKNOWN'] = (by[text(p.problemSubmissionStatus) || 'UNKNOWN'] ?? 0) + 1;
    return { total: data.problemStatus.length, accepted: by.PROBLEM_ACCEPTED ?? 0, by_status: by };
  }

  async problemSet({ problem_set_id }: { problem_set_id: unknown }) {
    const id = ptaId(problem_set_id, '题集 ID');
    const exam = await this.exam(id);
    const set = exam.problemSet ?? { id };
    const summaries = await this.api.get(`/api/problem-sets/${id}/problem-summaries`).catch(e => ({ error: safeError(e) }) as Raw);
    let progress = null;
    try {
      progress = await this.progress(id);
    } catch {}
    const types = summaries.summaries && typeof summaries.summaries === 'object'
      ? Object.entries(summaries.summaries as Record<string, Raw>).map(([type, s]) => ({ type, label: TYPE_LABELS[type] ?? type, total: s.total ?? null, total_score: s.totalScore ?? null }))
      : [];
    return { ...this.summarize(set, exam), description: text(set.description) || null, problem_types: types, progress, summaries_error: summaries.error ?? null };
  }

  /** Every problem of every type in one list (for small models that should not page by type). */
  async allProblems({ problem_set_id, max_problems = 80 }: { problem_set_id: unknown; max_problems?: number }) {
    const id = ptaId(problem_set_id, '题集 ID');
    const summaries = await this.api.get(`/api/problem-sets/${id}/problem-summaries`);
    const types = Object.keys(summaries.summaries ?? {}).sort((a, b) => PROBLEM_TYPES.indexOf(a as ProblemType) - PROBLEM_TYPES.indexOf(b as ProblemType));
    const problems: (Awaited<ReturnType<PtaReader['problems']>>['problems'][number] & { type_label: string })[] = [];
    let truncated = false;
    for (const type of types) {
      if (problems.length >= max_problems) {
        truncated = true;
        break;
      }
      const r = await this.problems({ problem_set_id: id, problem_type: type as ProblemType, limit: Math.min(200, max_problems - problems.length) });
      problems.push(...r.problems.map(p => ({ ...p, type_label: r.type_label ?? type })));
      if (r.next_page) truncated = true;
    }
    return { problem_set_id: id, total: problems.length, truncated, problems };
  }

  async problems({ problem_set_id, problem_type, page = 1, limit = 50 }: { problem_set_id: unknown; problem_type?: ProblemType; page?: number; limit?: number }) {
    const id = ptaId(problem_set_id, '题集 ID');
    let type = problem_type;
    if (!type) {
      const summaries = await this.api.get(`/api/problem-sets/${id}/problem-summaries`);
      const available = Object.keys(summaries.summaries ?? {});
      type = (['PROGRAMMING', 'CODE_COMPLETION', ...available].find(t => available.includes(t)) as ProblemType | undefined) ?? undefined;
      if (!type) return { problem_set_id: id, problem_type: null, problems: [], available_types: [], next_page: null };
    }
    const data = await this.api.get(`/api/problem-sets/${id}/exam-problem-list`, { problem_type: type, page: page - 1, limit });
    if (!Array.isArray(data.problemSetProblems)) throw new ToolError('SCHEMA_CHANGED', '拼题A 题目列表缺少 problemSetProblems。');
    let statuses = new Map<string, string>();
    try {
      const s = await this.api.get(`/api/problem-sets/${id}/exam-problem-status`, {}, { requireCookie: true });
      if (Array.isArray(s.problemStatus)) statuses = new Map((s.problemStatus as Raw[]).map(p => [String(p.id), text(p.problemSubmissionStatus)]));
    } catch {}
    const problems = (data.problemSetProblems as Raw[]).map(p => ({
      id: String(p.id),
      label: text(p.label) || null,
      title: text(p.title),
      score: p.score ?? null,
      deadline: ptaDeadline(p.deadline),
      accept_count: p.acceptCount ?? null,
      submit_count: p.submitCount ?? null,
      my_status: statuses.get(String(p.id)) || null,
    }));
    const total = Number(data.total);
    const more = Number.isFinite(total) ? page * limit < total : problems.length >= limit;
    return { problem_set_id: id, problem_type: type, type_label: TYPE_LABELS[type] ?? type, total: Number.isFinite(total) ? total : null, problems, next_page: more ? page + 1 : null };
  }

  async problem({ problem_set_id, problem_id, offset = 0, max_characters = 16000 }: { problem_set_id: unknown; problem_id: unknown; offset?: number; max_characters?: number }) {
    const id = ptaId(problem_set_id, '题集 ID');
    const pid = ptaId(problem_id, '题目 ID');
    const data = await this.api.get(`/api/problem-sets/${id}/exam-problems/${pid}`);
    const p = data.problemSetProblem;
    if (!p || typeof p !== 'object') throw new ToolError('SCHEMA_CHANGED', '拼题A 题目详情缺少 problemSetProblem。');
    const config = p.problemConfig?.programmingProblemConfig ?? p.problemConfig?.codeCompletionProblemConfig ?? p.problemConfig?.multipleFileProblemConfig ?? null;
    const content = text(p.content);
    return {
      problem_set_id: id,
      id: pid,
      label: text(p.label) || null,
      title: text(p.title),
      type: text(p.type) || null,
      type_label: TYPE_LABELS[text(p.type)] ?? null,
      score: p.score ?? null,
      author: text(p.author) || null,
      organization: text(data.organization?.name) || null,
      time_limit_ms: config?.timeLimit ?? null,
      memory_limit_kb: config?.memoryLimit ?? null,
      code_size_limit_kb: config?.codeSizeLimit ?? null,
      compiler: text(p.compiler) || null,
      deadline: ptaDeadline(p.deadline),
      content: content.slice(offset, offset + max_characters),
      next_offset: offset + max_characters < content.length ? offset + max_characters : null,
      total_characters: content.length,
      url: this.setUrl(id, pid, text(p.type)),
      note: '题面为拼题A 原始 Markdown（含 LaTeX 公式）。只读，不提交代码。',
    };
  }
}
