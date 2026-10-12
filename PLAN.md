# ZJU-mcp 实施计划

浙大校园平台的统一 MCP 服务。一份代码，两个版本：

- **正常版（full）**：给 Codex 等长上下文客户端，覆盖各平台全部读写能力。
- **小模型版（lite）**：给本地小模型 + DeepSeek Harness（DSH），工具少、说明短、结果压缩，保留最基础的写操作（交作业）。

## 1. 范围与优先级

| 平台 | 站点 | 优先级 | 说明 |
| --- | --- | --- | --- |
| 学在浙大（XZZD） | courses.zju.edu.cn | **主力** | 作业、课件、公告默认都以这里为准 |
| 教务（ZDBK） | zdbk.zju.edu.cn | 高 | 课表、成绩与绩点、考试安排，只读 |
| 智云课堂（ZhiYun） | classroom.zju.edu.cn | 高 | 回放列表、课堂转录、PPT 时间轴，只读 |
| 拼题A（PTA） | pintia.cn | 中 | 题集、题面；提交代码最后再评估 |
| CC98 | cc98.org | 中 | 先读，再加发帖、回复、私信 |
| 学习通（XXT） | chaoxing.com | **低，可选** | 用得少；默认不加载，需要时用 `ZJU_PLATFORMS` 打开 |

明确不做：刷课、自动答题、选课与抢课、批量抓取他人内容。

## 2. 技术选型

- Node 22+、TypeScript、官方 `@modelcontextprotocol/sdk`、`zod`；测试用 `node:test`。
- 仓库：`~/ThirdParty/ZJU-mcp`，MIT 许可。插件显示名 **ZJU-Omni**，插件 ID 与 MCP 服务名 `zju-omni`。
- 环境变量：
  - `MCP_TOOL_PROFILE=full|lite`，默认 `full`，其他值启动报错。
  - `ZJU_PLATFORMS`，逗号分隔；默认 `xzzd,zdbk,zhiyun,pta,cc98`，`xxt` 需显式加入。
  - `ZJU_NETWORK=auto|direct|webvpn`，默认 `auto`。

### 分发方式

核心产物只有两样，都不绑定 Codex：

- **MCP 服务**（`node dist/server.js`，stdio）：任何 MCP 客户端都能接，如 Codex、Claude Code、Cursor、OpenCode、DSH。
- **技能文档**（`skills/*/SKILL.md`）：Codex、Claude Code、OpenCode、DSH 都能读这种格式。

各客户端只需一层很薄的包装，放在 `packaging/`：

| 客户端 | 包装 | 版本 |
| --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` + `.mcp.json` + `skills/` | full |
| Claude Code | 插件清单 + MCP 配置 + `skills/`（格式实现时核对） | full |
| DSH | `cordis.patch.yml` 预设片段：`dsh-mcp-client` + `skill-filesystem` | lite |
| 其他 MCP 客户端 | `mcp.json` 示例 | full 或 lite |

## 3. 目录结构

```
src/
  core/        配置、档位、结果压缩、错误格式、钥匙串、会话存储、带 Cookie 的 HTTP 客户端、限速
  auth/        浙大统一认证（CAS）、WebVPN、CC98 OpenID、学习通登录、PTA Cookie 导入
  platforms/   xzzd/ zdbk/ zhiyun/ pta/ cc98/ xxt/，各含 client、reads、actions、tools
  lite/        小模型版的任务型工具，组合调用各平台
  server.ts
skills/        zju/（正常版 SKILL.md）、zju-lite/（小模型版，≤1.5 KB）
packaging/     codex/（Codex 插件清单）、claude/（Claude Code 插件清单）、dsh/（预设片段）、mcp.json（通用配置示例）
tests/         单元测试（脱敏接口样例）、工具目录体积测试、只读真机冒烟脚本
```

## 4. 公共层

| 部分 | 做法 |
| --- | --- |
| 账号 | 全部存 macOS 钥匙串，只配置一次。浙大统一认证一份，供 XZZD、ZDBK、智云、WebVPN 共用；CC98、学习通各一份；PTA 登录有短信二次验证，沿用导入浏览器 Cookie |
| 会话 | 每个平台一个会话文件（权限 600），过期自动重登；遇到验证码或二次验证立即停止并说明，不自动重试 |
| 网络 | `auto` 先直连，失败再走 WebVPN；ZDBK、智云、CC98 在校外很可能需要 WebVPN |
| 写操作 | 一律两步：`prepare` 生成预览和 `plan_id` → `execute` 执行 → 读回核对；结果不确定时不自动重试 |
| 输出 | full 返回 `structuredContent`；lite 去掉 `null`、空数组、`url`、`meta`，正文默认 ≤6000 字，按 `next_offset` 续读 |
| 限速 | 每个平台串行请求并设最小间隔，避免给学校服务器造成压力 |

## 5. 工具设计

### 5.1 正常版

各平台工具带前缀：`xzzd_*`、`zdbk_*`、`zhiyun_*`、`pta_*`、`cc98_*`、`xxt_*`，另加少量跨平台汇总工具。总数按现有项目估计在 60–90 个之间，以实际实现为准。

写操作：XZZD 交作业、存草稿、撤回；CC98 发帖、回复、私信；PTA 提交代码（最后评估）。

### 5.2 小模型版

约 15 个任务型工具，用测试锁定工具目录（名称 + 说明 + 输入 schema）总计 ≤6,000 字符。作业、课件、搜索默认只查 XZZD；只有启用 `xxt` 时才把学习通并入。

| 工具 | 数据来源 |
| --- | --- |
| `zju_deadlines` | XZZD 作业 + PTA 题集截止（启用时加 XXT） |
| `zju_schedule` | ZDBK 课表 |
| `zju_exams` | ZDBK 考试安排 |
| `zju_grades` | ZDBK 成绩与绩点 |
| `zju_courses` | XZZD 课程（ZDBK 补充课程代码、学分） |
| `zju_assignment` | XZZD 作业详情（要求、附件、截止、本人提交状态） |
| `zju_materials`、`zju_sync` | XZZD 课件列表与增量同步 |
| `zju_search` | XZZD 课程资料搜索 |
| `zju_lectures`、`zju_transcript` | 智云回放列表、课堂转录 |
| `pta_problem` | PTA 题面 |
| `cc98_search`、`cc98_topic` | CC98 搜帖、读帖 |
| `zju_prepare_submission`、`zju_submit` | XZZD 交作业（先预览，再确认） |

## 6. 现有资产

| 来源 | 现状（2026-10-12 核对） | 用法 |
| --- | --- | --- |
| `~/ThirdParty/XZZD-mcp/zju-tronclass` | Node/JS，24 个工具，65 个 Node 测试 + 9 个 Python 测试；已有 `MCP_TOOL_PROFILE=lite`（10 个工具，工具目录 3,263 字符，full 为 13,989） | 整体迁入，统一认证逻辑抽到公共层 |
| `~/ThirdParty/Pintia-mcp` | TS，6 个只读工具，Cookie 登录 | 迁入 |
| `~/ThirdParty/cc98-desktop` | Tauri：Rust 负责 OpenID 登录、令牌存储和通用请求转发；接口调用在 TS 前端 | 参考前端的接口用法和 Rust 的登录流程重写 |
| `~/ThirdParty/XXT-mcp/zju-chaoxing` | Python，24 个工具；支持 Cookie 导入和 AES 加密的账号密码登录 | 最后按需改写 |

## 7. 外部参考（按许可证区分）

| 项目 | 许可证 | 用法 |
| --- | --- | --- |
| EviterLesRoses2/cc98-mcp | MIT | 可借用代码，注明出处（CC98 只读 + WebVPN 回退） |
| DanMo661/Xuexitong-mcp | MIT | 可借用代码（学习通课表、考试、通知、进度） |
| 8eoyw/zju-learning-cli | MIT | 可借用代码（智云转录、PPT） |
| Lucent-Snow/zju-scholar | GPL-3.0 | 只参考接口思路，不复制代码（教务、智云、CC98、WebVPN） |
| Celechron/Celechron | GPL-3.0 | 只参考接口思路（教务） |
| Cillo-x/zjuam-auth | GPL-3.0 | 只参考接口思路（统一认证） |
| EviterLesRoses2/vibe-learning-in-zju | 未声明 | 只参考思路，不使用代码 |
| jinzcdev/vscode-pintia | 未核对 | PTA 提交流程参考，使用前核对许可证 |

## 8. 阶段

每个阶段的验收：全部测试通过、真机只读冒烟通过、文档更新。

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| 1 | 骨架与公共层：统一认证、WebVPN、钥匙串、档位与平台开关、体积测试 | — |
| 2 | 迁移 XZZD（24 个工具 + 现有测试） | 替代 `zju-tronclass` |
| 3 | ZDBK：课表、成绩与绩点、考试（只读） | 课表、考试、成绩 |
| 4 | 智云：回放列表、转录、PPT 时间轴（只读） | 课堂转录 |
| 5 | 小模型版：lite 工具、两份 SKILL.md、各客户端包装（Codex、Claude Code、DSH、通用 mcp.json）；用固定题目实测本地模型 | 两个版本可用 |
| 6 | PTA：迁移读取 | 题面 |
| 7 | CC98：先读，再写（两步确认） | 论坛 |
| 8 | 学习通（可选）：改写为 TS，按需补功能 | 替代 `zju-chaoxing` |

小模型版提前到第 5 阶段：做完 XZZD、ZDBK、智云就已覆盖它的核心用途。

## 9. 真机测试约定

- 读操作可直接用本人账号测试。
- 写操作只在用户点名具体作业、帖子时测试，且必须先展示预览。
- 测试数据、Cookie、令牌不写入仓库；接口样例脱敏后再存为测试夹具。

## 10. 风险

| 风险 | 应对 |
| --- | --- |
| 接口随时变 | 用接口样例写测试，字段缺失明确报 `SCHEMA_CHANGED` |
| 验证码、二次验证 | 停止并说明，不自动重试 |
| 校外访问 | WebVPN 在第 1 阶段解决 |
| 学习通登录 | 已有 AES 账号密码登录和 Cookie 导入两条路 |

## 11. 待确认

- 第 3、4 阶段用本人账号真机只读测试。
