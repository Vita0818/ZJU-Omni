# CC98 接口适配记录

整理日期：2026-10-12。登录流程和只读接口参考 [EviterLesRoses2/cc98-mcp](https://github.com/EviterLesRoses2/cc98-mcp)（MIT，上游 Lucent-Snow/CC98-CLI），写接口参考本地 cc98-desktop 前端（`src/lib/api.ts`）。真机验证需要配置 CC98 账号；校外需要 WebVPN。

## 登录

- OIDC 密码模式：`POST https://openid.cc98.org/connect/token`，表单 `grant_type=password&username&password&client_id&client_secret&scope=cc98-api openid offline_access`。client_id/secret 是第三方客户端通用的公开值。
- 令牌（access/refresh/过期时间）存为 `sessions/cc98.json`（600）；过期先用 refresh_token 换新，失败再用钥匙串密码登录。`invalid_grant` 报 `AUTHENTICATION_REQUIRED`，同一进程 15 分钟内不再自动重试。
- 网络：`auto` 先探测 `api.cc98.org`，不通走 WebVPN（Authorization 头经 WebVPN 转发）。

## 读接口（`https://api.cc98.org`，Bearer）

| 功能 | 路径 |
| --- | --- |
| 当前用户 | `/me`、未读数 `/me/unread-count` |
| 搜索 | `/topic/search?keyword&from&size` |
| 帖子 / 楼层 | `/topic/{id}`、`/Topic/{id}/post?from&size`（楼层 `content` + `contentType`：0 UBB，1 Markdown；每条带 `length` 总楼层数） |
| 十大 / 热门 | 匿名 `/config/index` 的 `hotTopic`；`/topic/hot-weekly`、`hot-monthly`、`hot-history` |
| 最新 / 版面 | `/topic/new`、匿名 `/Board/all`、`/board/{id}/topic`、精华 `/topic/best/board/{id}` |
| 用户 | `/user/{id}`、`/user/name/{name}` |
| 通知 | `/notification/{reply|at|system}?from&size`（不调用 read-all，不标记已读） |
| 私信 | `/message/recent-contact-users`、`/message/user/{id}` |

## 写接口（两步确认）

| 操作 | 请求 | 读回核对 |
| --- | --- | --- |
| 回帖 | `POST /topic/{id}/post`，`{title:"", content, contentType:0, parentId?}` | 读最后 10 层，找本人且内容一致的楼层 |
| 发帖 | `POST /board/{id}/topic`，`{title, content, contentType:0, type, notifyPoster:true}`，返回帖子 ID | `GET /topic/{id}` 标题一致 |
| 私信 | `POST /message`，`{receiverId, content}` | `GET /message/user/{id}` 中找到内容一致的消息 |

执行前再次核对当前账号与预览时一致；写请求不因 401 重放；结果无法核对时报告 `accepted_unverified`。
