import { ToolError } from '../../core/errors.ts';
import { PlanStore } from '../../core/plans.ts';
import type { Raw } from '../../core/util.ts';
import type { Cc98Api } from './client.ts';
import { asList, cc98Id, postText, WEB } from './reads.ts';

const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

function checkContent(content: string, max = 20000): string {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) throw new ToolError('EMPTY_CONTENT', '内容不能为空。');
  if (text.length > max) throw new ToolError('CONTENT_TOO_LONG', `内容超过 ${max} 字。`);
  return text;
}

export interface Cc98ActionApi extends Cc98Api {
  sessionFingerprint(): Promise<string>;
  me(): Promise<Raw>;
}

interface ReplyPayload { topic_id: number; topic_title: string; board: string | null; content: string; parent_id?: number; me: string }
interface TopicPayload { board_id: number; board: string; title: string; content: string; type: 0 | 1 | 2; me: string }
interface MessagePayload { receiver_id: number; receiver_name: string; content: string; me: string }

const PREVIEW_NOTE = '已生成预览，尚未发送。论坛发言公开可见且难以撤回；预览编号不代表用户授权，需用户确认具体内容后再执行。';

export class Cc98Actions {
  readonly api: Cc98ActionApi;
  readonly plans: PlanStore;
  constructor(api: Cc98ActionApi, dataDir: string) {
    this.api = api;
    this.plans = new PlanStore(dataDir, 'cc98');
  }

  private async whoami(): Promise<string> {
    const me = await this.api.me();
    if (!me?.name) throw new ToolError('SCHEMA_CHANGED', 'CC98 未返回当前用户名。');
    return String(me.name);
  }

  async prepareReply({ topic_id, content, parent_post_id }: { topic_id: unknown; content: string; parent_post_id?: unknown }) {
    const id = cc98Id(topic_id, '帖子 ID');
    const text = checkContent(content);
    const me = await this.whoami();
    const topic = await this.api.request<Raw>('GET', `/topic/${id}`);
    if (!topic?.id) throw new ToolError('SCHEMA_CHANGED', 'CC98 帖子详情格式无法识别。');
    if (topic.state === 1 || topic.isLocked === true) throw new ToolError('TOPIC_LOCKED', '该帖子已锁定，不能回复。');
    const payload: ReplyPayload = { topic_id: id, topic_title: String(topic.title ?? ''), board: topic.boardName ?? null, content: text, me };
    if (parent_post_id != null) payload.parent_id = cc98Id(parent_post_id, '楼层 ID');
    const plan = await this.plans.create('reply', await this.api.sessionFingerprint(), payload);
    return { plan_id: plan.id, operation: '回复帖子', as_user: me, topic: payload.topic_title, board: payload.board, content: text, expires_at: plan.expires_at, url: `${WEB}/topic/${id}`, note: PREVIEW_NOTE };
  }

  async reply(planId: string) {
    return this.plans.execute<ReplyPayload, Raw & { verified: boolean }>(planId, 'reply', () => this.api.sessionFingerprint(), async plan => {
      const p = plan.payload;
      if ((await this.whoami()) !== p.me) throw new ToolError('IDENTITY_CHANGED', '当前 CC98 账号与预览时不同，已停止。');
      await this.api.request('POST', `/topic/${p.topic_id}/post`, { body: { title: '', content: p.content, contentType: 0, ...(p.parent_id ? { parentId: p.parent_id } : {}) } });
      try {
        const topic = await this.api.request<Raw>('GET', `/topic/${p.topic_id}`);
        const total = Number(topic.replyCount ?? 0) + 1;
        const posts = asList(await this.api.request('GET', `/Topic/${p.topic_id}/post`, { query: { from: Math.max(0, total - 10), size: 10 } }));
        const mine = posts.reverse().find(post => post.userName === p.me && normalize(postText(post)) === normalize(p.content));
        if (mine) return { status: 'replied', verified: true, post_id: mine.id, floor: mine.floor, url: `${WEB}/topic/${p.topic_id}#${mine.floor}` };
      } catch {}
      return { status: 'accepted_unverified', verified: false, url: `${WEB}/topic/${p.topic_id}`, note: '接口已接受，但未在最新楼层核对到这条回复。请打开帖子查看，勿重复发送。' };
    });
  }

  async prepareTopic({ board_id, title, content, type = 0 }: { board_id: unknown; title: string; content: string; type?: 0 | 1 | 2 }) {
    const id = cc98Id(board_id, '版面 ID');
    const cleanTitle = checkContent(title, 100);
    const text = checkContent(content);
    const me = await this.whoami();
    const board = await this.api.request<Raw>('GET', `/board/${id}`);
    if (!board?.id) throw new ToolError('SCHEMA_CHANGED', 'CC98 版面信息格式无法识别。');
    if (board.canEntry === false || board.isLock === true) throw new ToolError('BOARD_UNAVAILABLE', '该版面当前不允许发帖或无权进入。');
    const payload: TopicPayload = { board_id: id, board: String(board.name ?? id), title: cleanTitle, content: text, type, me };
    const plan = await this.plans.create('topic', await this.api.sessionFingerprint(), payload);
    return { plan_id: plan.id, operation: '发新帖', as_user: me, board: payload.board, title: cleanTitle, content: text, type: ['普通', '校园活动', '学术信息'][type], expires_at: plan.expires_at, note: PREVIEW_NOTE };
  }

  async createTopic(planId: string) {
    return this.plans.execute<TopicPayload, Raw & { verified: boolean }>(planId, 'topic', () => this.api.sessionFingerprint(), async plan => {
      const p = plan.payload;
      if ((await this.whoami()) !== p.me) throw new ToolError('IDENTITY_CHANGED', '当前 CC98 账号与预览时不同，已停止。');
      const created = await this.api.request<unknown>('POST', `/board/${p.board_id}/topic`, { body: { title: p.title, content: p.content, contentType: 0, type: p.type, notifyPoster: true } });
      const topicId = Number(String(created ?? '').replace(/"/g, ''));
      if (Number.isSafeInteger(topicId) && topicId > 0) {
        try {
          const topic = await this.api.request<Raw>('GET', `/topic/${topicId}`);
          if (normalize(String(topic.title ?? '')) === normalize(p.title)) return { status: 'created', verified: true, topic_id: topicId, url: `${WEB}/topic/${topicId}` };
        } catch {}
        return { status: 'accepted_unverified', verified: false, topic_id: topicId, url: `${WEB}/topic/${topicId}`, note: '接口返回了帖子编号，但读回未能核对标题。请打开查看，勿重复发帖。' };
      }
      return { status: 'accepted_unverified', verified: false, note: '接口已接受，但未返回帖子编号。请到版面查看，勿重复发帖。' };
    });
  }

  async prepareMessage({ user_id, user_name, content }: { user_id?: unknown; user_name?: string; content: string }) {
    if (user_id == null && !user_name) throw new ToolError('INVALID_ARGUMENT', '请提供收信人 user_id 或 user_name。');
    const text = checkContent(content, 5000);
    const me = await this.whoami();
    const user = await this.api.request<Raw>('GET', user_id != null ? `/user/${cc98Id(user_id, '用户 ID')}` : `/user/name/${encodeURIComponent(user_name!)}`);
    if (!user?.id || !user.name) throw new ToolError('USER_NOT_FOUND', '没有找到这个 CC98 用户。');
    if (String(user.name) === me) throw new ToolError('INVALID_ARGUMENT', '不能给自己发私信。');
    const payload: MessagePayload = { receiver_id: Number(user.id), receiver_name: String(user.name), content: text, me };
    const plan = await this.plans.create('message', await this.api.sessionFingerprint(), payload);
    return { plan_id: plan.id, operation: '发送私信', as_user: me, to: payload.receiver_name, to_user_id: payload.receiver_id, content: text, expires_at: plan.expires_at, note: PREVIEW_NOTE.replace('论坛发言公开可见且难以撤回', '私信发出后无法撤回') };
  }

  async sendMessage(planId: string) {
    return this.plans.execute<MessagePayload, Raw & { verified: boolean }>(planId, 'message', () => this.api.sessionFingerprint(), async plan => {
      const p = plan.payload;
      if ((await this.whoami()) !== p.me) throw new ToolError('IDENTITY_CHANGED', '当前 CC98 账号与预览时不同，已停止。');
      await this.api.request('POST', '/message', { body: { receiverId: p.receiver_id, content: p.content } });
      try {
        const rows = asList(await this.api.request('GET', `/message/user/${p.receiver_id}`, { query: { from: 0, size: 10 } }));
        const sent = rows.find(m => Number(m.receiverId) === p.receiver_id && normalize(String(m.content ?? '')) === normalize(p.content));
        if (sent) return { status: 'sent', verified: true, message_id: sent.id, to: p.receiver_name };
      } catch {}
      return { status: 'accepted_unverified', verified: false, to: p.receiver_name, note: '接口已接受，但未在会话记录中核对到这条私信。请查看私信页面，勿重复发送。' };
    });
  }
}
