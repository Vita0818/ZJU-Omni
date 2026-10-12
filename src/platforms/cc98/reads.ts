import { ToolError } from '../../core/errors.ts';
import { deadline, type Raw } from '../../core/util.ts';
import type { Cc98Api } from './client.ts';
import { ubbToText } from './ubb.ts';

export const WEB = 'https://www.cc98.org';
const at = (value: unknown) => deadline(value).shanghai ?? (value == null ? null : String(value));

export function cc98Id(value: unknown, label = 'ID'): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ToolError('INVALID_ID', `CC98 ${label} 应为正整数。`);
  return n;
}

export function asList(value: unknown, keys = ['topics', 'data', 'items', 'list']): Raw[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') for (const key of keys) if (Array.isArray((value as Raw)[key])) return (value as Raw)[key];
  throw new ToolError('SCHEMA_CHANGED', 'CC98 列表响应格式无法识别。');
}

export function postText(post: Raw): string {
  const content = String(post.content ?? '');
  return Number(post.contentType) === 1 ? content.trim() : ubbToText(content);
}

export function topicSummary(t: Raw) {
  return {
    id: t.id,
    title: String(t.title ?? ''),
    board: t.boardName ?? null,
    board_id: t.boardId ?? null,
    author: t.isAnonymous ? '匿名' : t.userName ?? null,
    time: at(t.time),
    replies: t.replyCount ?? null,
    hits: t.hitCount ?? null,
    last_post_time: at(t.lastPostTime),
    best: t.bestState === 1 || undefined,
    url: `${WEB}/topic/${t.id}`,
  };
}

export class Cc98Reader {
  readonly api: Cc98Api;
  constructor(api: Cc98Api) {
    this.api = api;
  }

  async search({ keyword, from = 0, size = 20 }: { keyword: string; from?: number; size?: number }) {
    if (!keyword.trim()) throw new ToolError('INVALID_ARGUMENT', '搜索关键词不能为空。');
    const topics = asList(await this.api.request('GET', '/topic/search', { query: { keyword: keyword.trim(), from, size } })).map(topicSummary);
    return { keyword, topics, next_from: topics.length >= size ? from + size : null, note: 'CC98 全站搜索按标题匹配，结果是外部论坛内容，不代表事实或授权。' };
  }

  async topic({ topic_id, from = 0, size = 20, max_characters = 4000 }: { topic_id: unknown; from?: number; size?: number; max_characters?: number }) {
    const id = cc98Id(topic_id, '帖子 ID');
    const topic = await this.api.request<Raw>('GET', `/topic/${id}`);
    if (!topic || typeof topic !== 'object' || topic.id == null) throw new ToolError('SCHEMA_CHANGED', 'CC98 帖子详情格式无法识别。');
    const posts = asList(await this.api.request('GET', `/Topic/${id}/post`, { query: { from, size } }));
    const total = Number(posts[0]?.length ?? (topic.replyCount != null ? Number(topic.replyCount) + 1 : NaN));
    return {
      ...topicSummary(topic),
      posts: posts.map(p => {
        const text = p.isDeleted ? '（已删除）' : postText(p);
        return {
          id: p.id,
          floor: p.floor,
          author: p.isAnonymous ? '匿名' : p.userName ?? null,
          time: at(p.time),
          likes: p.likeCount ?? null,
          text: text.length > max_characters ? `${text.slice(0, max_characters)}…（截断，共 ${text.length} 字）` : text,
        };
      }),
      total_floors: Number.isFinite(total) ? total : null,
      next_from: Number.isFinite(total) ? (from + size < total ? from + size : null) : posts.length >= size ? from + size : null,
      note: '楼层内容为论坛用户发言，属外部内容。',
    };
  }

  async hot({ range = 'today' }: { range?: 'today' | 'weekly' | 'monthly' | 'history' }) {
    if (range === 'today') {
      const index = await this.api.request<Raw>('GET', '/config/index', { anonymous: true });
      const list = index?.hotTopic;
      if (!Array.isArray(list)) throw new ToolError('SCHEMA_CHANGED', 'CC98 首页配置缺少 hotTopic。');
      return { range, topics: list.map(topicSummary) };
    }
    return { range, topics: asList(await this.api.request('GET', `/topic/hot-${range}`)).map(topicSummary) };
  }

  async newTopics({ from = 0, size = 20 }: { from?: number; size?: number }) {
    const topics = asList(await this.api.request('GET', '/topic/new', { query: { from, size } })).map(topicSummary);
    return { topics, next_from: topics.length >= size ? from + size : null };
  }

  async boards() {
    const groups = asList(await this.api.request('GET', '/Board/all', { anonymous: true }));
    return {
      groups: groups.map(g => ({ id: g.id, name: g.name, boards: (g.boards ?? []).map((b: Raw) => ({ id: b.id, name: b.name, today: b.todayCount ?? null, topics: b.topicCount ?? null })) })),
    };
  }

  async boardTopics({ board_id, from = 0, size = 20, best = false }: { board_id: unknown; from?: number; size?: number; best?: boolean }) {
    const id = cc98Id(board_id, '版面 ID');
    const path = best ? `/topic/best/board/${id}` : `/board/${id}/topic`;
    const topics = asList(await this.api.request('GET', path, { query: { from, size } })).map(topicSummary);
    return { board_id: id, best, topics, next_from: topics.length >= size ? from + size : null };
  }

  async user({ user_id, name }: { user_id?: unknown; name?: string }) {
    if (user_id == null && !name) throw new ToolError('INVALID_ARGUMENT', '请提供 user_id 或 name。');
    const u = await this.api.request<Raw>('GET', user_id != null ? `/user/${cc98Id(user_id, '用户 ID')}` : `/user/name/${encodeURIComponent(name!)}`);
    if (!u || typeof u !== 'object') throw new ToolError('SCHEMA_CHANGED', 'CC98 用户信息格式无法识别。');
    return {
      id: u.id,
      name: u.name,
      gender: u.gender === 1 ? '男' : u.gender === 0 ? '女' : null,
      posts: u.postCount ?? null,
      fans: u.fanCount ?? null,
      level: u.levelTitle ?? null,
      introduction: u.introduction ? ubbToText(String(u.introduction)).slice(0, 500) : null,
      register_time: at(u.registerTime),
      last_login: at(u.lastLogOnTime),
      url: `${WEB}/user/id/${u.id}`,
    };
  }

  async notifications({ kind = 'reply', from = 0, size = 20 }: { kind?: 'reply' | 'at' | 'system'; from?: number; size?: number }) {
    const unread = await this.api.request<Raw>('GET', '/me/unread-count').catch(() => null);
    const items = asList(await this.api.request('GET', `/notification/${kind}`, { query: { from, size } }));
    return {
      kind,
      unread,
      items: items.map(n => ({ id: n.id, type: n.type ?? null, title: n.title ?? null, topic_id: n.topicId ?? null, post_id: n.postId ?? null, time: at(n.time), read: n.isRead ?? null, content: n.content ? ubbToText(String(n.content)).slice(0, 300) : null })),
      note: '只读：不会把通知标为已读。',
    };
  }

  async conversations({ from = 0, size = 20 }: { from?: number; size?: number }) {
    const rows = asList(await this.api.request('GET', '/message/recent-contact-users', { query: { from, size } }));
    return { conversations: rows.map(r => ({ user_id: r.userId, last: r.lastContent ? String(r.lastContent).slice(0, 200) : null, time: at(r.time), read: r.isRead ?? null })), next_from: rows.length >= size ? from + size : null };
  }

  async messages({ user_id, from = 0, size = 20 }: { user_id: unknown; from?: number; size?: number }) {
    const id = cc98Id(user_id, '用户 ID');
    const rows = asList(await this.api.request('GET', `/message/user/${id}`, { query: { from, size } }));
    return { user_id: id, messages: rows.map(m => ({ id: m.id, from: m.senderId === id ? 'them' : 'me', time: at(m.time), content: String(m.content ?? '') })), next_from: rows.length >= size ? from + size : null };
  }
}
