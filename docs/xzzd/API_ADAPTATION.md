# 作业和课件接口适配记录

核对日期：2026-09-20。本文记录接口依据与验证范围，不包含账号数据、Cookie、课程正文或平台脚本副本。

## 当前平台前端依据

通过已登录账号读取课程页面，定位其实际加载的 JavaScript 和按需加载的 activity 模块，只读检查请求构造。接口适配独立实现，没有打包平台脚本。

| 能力 | 观察到的请求／字段 | 前端来源 |
| --- | --- | --- |
| 新建作业／草稿 | `POST /api/course/activities/{activity_id}/submissions`；`comment`、`uploads`、`slides`、`is_draft`、`mode`、`other_resources`、`uploads_in_rich_text` | [activity 模块](https://courses.zju.edu.cn/static/88788.74894ac5.js) |
| 编辑或交付已有草稿 | 同一路径使用 `PUT`，请求体增加 `submission_id`；`is_draft` 决定保存或正式交付 | 同上 |
| 本人所在小组 | `GET /api/group-sets/{group_set_id}/group`，返回 `group` | [课程公共接口模块](https://courses.zju.edu.cn/static/92963-d5071145.js) |
| 个人提交历史 | `GET /api/activities/{activity_id}/students/{user_id}/submission_list`，返回 `list` | [作业接口模块](https://courses.zju.edu.cn/static/55200.ff8ac69f.js) |
| 小组提交历史 | `GET /api/activities/{activity_id}/groups/{group_id}/submission_list`，返回 `list` | 同上 |
| 草稿与最新记录 | `is_draft`、`is_latest_version`、`is_redo`、`submit_by_instructor`、`marked_submitted` | activity 模块 |
| 当前用户身份 | 登录后的 `/user/index` 服务端脚本中的 `globalData.user.id` | 当前课程页面；不执行脚本，只解析唯一身份字段 |

小组写入使用同一个作业提交接口，平台由当前账号与作业分组配置确定目标小组。连接器在预览和执行时分别读取本人小组、核对分组编号与提交状态；没有让调用者指定任意其他学生或其他小组的入口。

新输入的文字按纯文字进行 HTML 编码并保留换行。保留现有草稿时保留其原文字和选择的附件。含内嵌图片、音视频、在线幻灯片或特殊资源的草稿暂不编辑，避免漏传关联资源。多选等非 normal 作业模式需要单独适配。

平台学生操作语义也参考了 [TronClass 作业说明](https://support.tronclass.com/cn/question/homework/)和[撤回／草稿更新说明](https://support.tronclass.com/cn/updated/updated_1_66/)。平台通用说明不代表浙大部署的所有配置完全相同。

## 在现有接口上组合的能力

- 跨课程作业汇总：课程列表 → 每门课的全部作业分页 → 本人或本人小组提交记录；分页、权限或身份失败都显式记录。
- 内容检索：课程活动分页 → 可选活动正文；搜索范围为标题、正文、附件文件名，不包括附件内文字。
- 课件同步：课件分页和作业要求附件 → 最新活动附件与下载权限 → 下载字节；在用户选择的本地目录记录账号／课程绑定的清单、平台更新时间和 SHA-256。新版本另存，不删除旧文件。
- 本人作业附件下载：本人／本人小组提交历史 → 指定记录中的附件 → 现有文件下载接口。

## 验证范围

本地模拟测试覆盖纯文字、创建／编辑／交付草稿、旧附件选择、小组查询与组别变化、错误回读、下载权限、同步版本和本地冲突、分页与部分失败。MCP 协议测试实际启动服务器并检查全部 24 个工具。

真实账号完成了 3 门课程作业扫描、作业正文与本人记录查询、正文检索、一份课件首次下载和重复运行跳过；真实账号未执行上传、保存草稿、正式提交或撤回。小组写入与草稿写入的证据为线上前端请求结构和本地模拟测试，不能据此宣称已经完成真实写入验收。

当前仍不包含特殊模式作业答题、复杂富文本草稿编辑、评分批注文件导出、附件内部全文索引、超 100 MiB 文件、断点续传、后台通知、考试／讨论／教师端或智云课堂操作。
