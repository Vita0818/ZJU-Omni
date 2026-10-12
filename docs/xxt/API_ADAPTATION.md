# 学习通接口适配记录

整理日期：2026-10-12。请求形态与页面解析移植自 `~/ThirdParty/XXT-mcp/zju-chaoxing`（MIT；上游 © Wu Jiale，补充 © Vita0818）。默认不加载，需在 `ZJU_PLATFORMS` 中加入 `xxt`。真机验证需要先导入 Cookie。

## 登录

学习通账号密码登录（`passport2.chaoxing.com/fanyalogin`）自 2025 年起常弹滑块验证码，这里不实现，只用浏览器 Cookie：

```sh
pbpaste | npm run cli -- xxt-cookie
```

Cookie 存为 `sessions/xxt.json`（600），domain 记为 `chaoxing.com`，只发往 `*.chaoxing.com`。必需字段 `UID`、`_uid`、`fid`，缺了会在导入结果里列出。跳到 `passport2.chaoxing.com/login` 或返回“用户登录”页报 `COOKIE_EXPIRED`。请求间隔至少 1 秒。

## 接口

| 功能 | 地址 | 说明 |
| --- | --- | --- |
| 基础信息 / fid | `GET https://i.chaoxing.com/base` | 页面里取 `fid` |
| 课程列表 | `GET mooc2-ans…/visit/courselistdata?courseType=1&courseFid=&courseTeacherid=0&courseOrderBy=0` | HTML，按 `stucoursemiddle?courseid&clazzid&cpi` 解析 |
| 课程中间页 | `GET mooc1…/visit/stucoursemiddle?courseid&clazzid&cpi&ismooc2=1&v=2` | 隐藏域 `workEnc`、`openc`、`enc` |
| 作业列表 | `GET mooc1…/mooc2/work/list?courseId&classId&cpi&ut=s&openc&enc=<workEnc>&t&stuenc=<enc>&isdisplaytable=2` | `goTask` 条目：详情链接、标题、状态；进度 `done/total` |
| 作业详情 | 列表条目里的链接 | 文本中的“题量、满分、作答时间 MM-DD HH:MM 至 MM-DD HH:MM” |
| 考试 | `GET mooc1-api…/exam-ans/exam/test/examcode/examlist` | `tr.dataTr` 表格 |
| 通知 | `POST notice.chaoxing.com/pc/notice/getNoticeList` | `notices.list`、`lastGetId` 翻页（最多 5 页） |
| 课表 | `POST kb.chaoxing.com/pc/curriculum/getMyLessons`（可带 `week`） | `data.curriculum`、`data.lessonArray`；节次时间取 `lessonTimeConfigArray` |

作业截止时间没有年份，按离今天最近的年份补全（北京时间）。已完成、已提交、待批阅、已批阅的作业不读详情。

## 暂未移植

章节任务点课件解析与增量同步、资料区、云盘、章节进度、ICS 导出、账号密码登录。
