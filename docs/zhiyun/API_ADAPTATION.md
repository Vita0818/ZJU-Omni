# 智云课堂接口适配记录

整理日期：2026-10-12。接口用法参考 [8eoyw/zju-learning-cli](https://github.com/8eoyw/zju-learning-cli)（MIT）。2026-10-12 已用真实账号只读验证。

## 登录

- 入口：`https://tgmedia.cmc.zju.edu.cn/index.php?r=auth/login&auType=cmc&tenant_code=112&forward=https://classroom.zju.edu.cn/`，经统一认证返回。
- CAS 回调可能是 `http://`，只对智云相关主机（classroom、*.cmc.zju.edu.cn）升级为 https。
- 访问令牌在一个 PHP 序列化的 Cookie 里（`"_token";…"<令牌>"`），通常设在 `.zju.edu.cn` 父域。只保存这一个 Cookie 和智云主机自己的 Cookie，不保存统一认证票据。
- 接口请求带 `Authorization: Bearer <令牌>`。

## 接口（GET）

| 功能 | 地址 | 参数 | 返回 |
| --- | --- | --- | --- |
| 用户信息 | `classroom…/userapi/v1/infosimple` | — | `params.id`、`params.account` |
| 搜索课程 | `classroom…/pptnote/v1/searchlist` | `tenant_id=112&tenant_code=112&user_id&user_name&page&per_page=16&title&realname&trans=` | `code`、`total.list[]`、`total.total` |
| 课程堂次 | `yjapi.cmc…/courseapi/v3/multi-search/get-course-detail` | `course_id&student=<account>` | `data.title`；`data.sub_list` 按年→月→周嵌套，叶子含 `id`、`sub_title`、`lecturer_name`、`class_begin`（Unix 秒） |
| 某天我的课 | `classroom…/courseapi/v2/course-live/get-my-course-day` | `day=YYYY-MM-DD` | `list` 按“上午/下午”分组（`section`），每组 `course` 是**对象**（键为序号）：`id`、`title`、`sub_id`、`sub_title`、`realname`、`course_begin`（Unix 秒字符串）、`room_name` |
| 转录 | `yjapi.cmc…/courseapi/v3/web-socket/search-trans-result` | `sub_id&format=json` | `list[0].all_content[]`：`BeginSec`、`EndSec`、`Text`；`code=10002` 表示暂无语音数据 |
| PPT | `classroom…/pptnote/v1/schedule/search-ppt` | `course_id&sub_id&page&per_page=100` | `total`、`list[]`：`created_sec`（截图在录像中的秒数），`content` 为 JSON 字符串，含 `pptimgurl`、`pptthumb`、`created`（同 `created_sec`） |

## 已知坑

- `search-ppt` 不遵守 `per_page`，常在第 1 页返回全部、下一页重复：按顺序去重，没有新内容或达到 `total` 就停。
- PPT 图片地址常是 `http://`：学校主机升级为 https，下载不带 Cookie 和令牌。所有 http 请求一律不带 Cookie（SSO Cookie 没设 Secure）。
- `created_sec` 在正在直播的堂次里可能出现异常大的值（实测出现约 1,015,000）。超过 12 小时的值当作无效，置为 null。
