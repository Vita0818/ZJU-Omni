// One merged, pre-sorted deadline list: small models mis-order dates when
// they have to combine several lists themselves.

export type DeadlineSource = '学在浙大' | '拼题A' | '学习通';

export interface DeadlineInput {
  source: DeadlineSource;
  course?: string | null;
  title: string;
  due_iso: string | null;
  status: string;
  activity_id?: unknown;
  problem_set_id?: string;
  solved?: string;
  group?: boolean;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const parts = (date: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );

/** "2026-10-13 12:00 周二" in Beijing time. */
export function beijing(iso: string | null, withTime = true): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = parts(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay()];
  return withTime ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${weekday}` : `${p.year}-${p.month}-${p.day} ${weekday}`;
}

/** "还剩 7 小时" / "还剩 2 天 3 小时" / "已过期 5 天". */
export function remaining(iso: string | null, now: Date): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const diff = t - now.getTime();
  const minutes = Math.floor(Math.abs(diff) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const span = days > 0 ? `${days} 天${hours ? ` ${hours} 小时` : ''}` : hours > 0 ? `${hours} 小时` : `${Math.max(minutes, 1)} 分钟`;
  if (diff < 0) return `已过期 ${days > 0 ? `${days} 天` : span}`;
  return `还剩 ${span}`;
}

const URGENT_MS = 24 * 3600 * 1000;

/** Upcoming (soonest first), then overdue (most recent first), then unknown deadlines. */
export function mergeDeadlines(items: DeadlineInput[], now: Date) {
  const nowMs = now.getTime();
  const urgent = (item: DeadlineInput) => {
    const t = item.due_iso ? Date.parse(item.due_iso) : NaN;
    return Number.isFinite(t) && t >= nowMs && t - nowMs <= URGENT_MS;
  };
  const rank = (item: DeadlineInput) => {
    const t = item.due_iso ? Date.parse(item.due_iso) : NaN;
    if (!Number.isFinite(t)) return { group: 2, key: 0 };
    return t >= nowMs ? { group: 0, key: t } : { group: 1, key: -t };
  };
  return items
    .map(item => ({ item, r: rank(item) }))
    .sort((a, b) => a.r.group - b.r.group || a.r.key - b.r.key)
    .map(({ item, r }, index) => ({
      no: index + 1,
      source: item.source,
      course: item.course ?? undefined,
      title: item.title,
      due: beijing(item.due_iso) ?? '截止时间未知',
      left: remaining(item.due_iso, now),
      urgent: urgent(item) || undefined,
      overdue: r.group === 1 || undefined,
      status: item.status,
      solved: item.solved,
      group: item.group || undefined,
      activity_id: item.activity_id ?? undefined,
      problem_set_id: item.problem_set_id,
    }));
}
