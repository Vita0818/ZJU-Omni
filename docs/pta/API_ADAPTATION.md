# 拼题A 接口适配记录

整理日期：2026-10-12。接口路径与 [jinzcdev/vscode-pintia](https://github.com/jinzcdev/vscode-pintia)（MIT）核对；Cookie 解析沿用 `Pintia-mcp`。2026-10-12 已用公开题集（id 12）匿名验证题集、题目列表、题面；个人题集与进度需导入 Cookie 后验证。

## 登录

拼题A 登录有短信验证，所以不存密码、不自动登录。用户在浏览器登录后复制任一 `/api` 请求的 cURL（或 Cookie 请求头、DevTools Cookies 表格、纯 Cookie 串），运行：

```sh
pbpaste | npm run cli -- pta-cookie
```

Cookie 存为 `sessions/pta.json`（600），domain 记为 `pintia.cn`，所以同时发给 `pintia.cn` 和 `passport.pintia.cn`。也可用 `PINTIA_COOKIE` 环境变量。401、跳转或 `UNAUTHORIZED` 类错误码报 `COOKIE_EXPIRED`，提示重新导入。

## 接口（均为 GET）

| 功能 | 路径 | 返回 |
| --- | --- | --- |
| 当前用户 | `passport.pintia.cn/api/u/current` | `user`（`nickname` 等） |
| 我的题集 | `/api/problem-sets?filter={"endAtAfter":"<ISO>"}`（未截止）或 `filter={}` | `problemSets[]`：`id`、`name`、`timeType`、`organizationName`、`ownerNickname` |
| 题集与考试窗口 | `/api/problem-sets/{id}/exams` | `status`、`exam`（`startAt`、`endAt`、`ended`、`score`）、`problemSet`、`permission` |
| 题型汇总 | `/api/problem-sets/{id}/problem-summaries` | `summaries`：`{题型: {total, totalScore}}` |
| 题目列表 | `/api/problem-sets/{id}/exam-problem-list?problem_type=&page=（从 0 开始）&limit=` | `problemSetProblems[]`：`id`、`label`、`title`、`score`、`deadline`、`acceptCount`、`submitCount` |
| 本人状态 | `/api/problem-sets/{id}/exam-problem-status` | `problemStatus[]`：`id`、`problemSubmissionStatus` |
| 题面 | `/api/problem-sets/{id}/exam-problems/{problemId}` | `problemSetProblem`：`title`、`content`（Markdown + LaTeX）、`type`、`score`、`problemConfig.*.timeLimit/memoryLimit`；`organization` |

## 不做

- `POST /api/problem-sets/{id}/exams`（开始考试、创建考试记录）和提交代码都是写操作，不调用。考试尚未开始的题集可能返回 403，如实报告。
- 不读浏览器 Cookie 数据库，不保存手机号或密码。
