# ZJU-Omni

浙大校园平台的统一 MCP 服务（服务名 `zju-omni`）。一份代码，两个档位：

- **full**（默认）：给 Codex、Claude Code 等长上下文客户端，按平台前缀提供全部读写工具。
- **lite**：给本地小模型 / DeepSeek Harness，少量任务型工具、短说明、压缩结果，保留交作业。

实施计划见 [PLAN.md](PLAN.md)。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 骨架与公共层：统一认证（CAS）、WebVPN、钥匙串、档位与平台开关、限速、体积测试 | 完成（直连已真机验证；WebVPN 待验证） |
| 2 | 学在浙大迁移（原 `zju-tronclass` 24 个工具 → 3 个 `zju_auth_*` + 21 个 `xzzd_*`） | 完成（真机只读冒烟通过） |
| 3 | 教务（ZDBK）：课表、成绩与绩点、考试安排（只读，4 个 `zdbk_*`） | 完成（真机只读冒烟通过） |
| 4 | 智云课堂：我的堂次、课程堂次、课堂转录、PPT 时间轴与截图下载（6 个 `zhiyun_*`） | 完成（待真机只读冒烟） |
| 5–8 | lite 补全与客户端包装、PTA、CC98、学习通 | 未开始 |

full 档目前 34 个工具。lite 档 13 个：`zju_deadlines`、`zju_courses`、`zju_assignment`、`zju_materials`、`zju_sync`、`zju_search`、`zju_prepare_submission`、`zju_submit`（学在浙大），`zju_schedule`、`zju_exams`、`zju_grades`（教务），`zju_lectures`、`zju_transcript`（智云）。

## 安装

需要 Node 22.18+。

```sh
npm install
npm run build
npm run configure -- zju   # 在自己的终端运行：账号输入一次，密码由 macOS security 隐藏读取并存入钥匙串
npm run login              # 可选：立即验证登录
```

已经配置过 `zju-tronclass` 的机器会自动只读复用它的钥匙串账号，无需重新配置（`status` 中显示 `legacy-zju-tronclass`）。

MCP 客户端配置示例见 [packaging/mcp.json](packaging/mcp.json)：`node /绝对路径/dist/server.js`，stdio。

## 环境变量

| 变量 | 取值 | 默认 |
| --- | --- | --- |
| `MCP_TOOL_PROFILE` | `full` / `lite`，其他值启动报错 | `full` |
| `ZJU_PLATFORMS` | 逗号分隔：`xzzd,zdbk,zhiyun,pta,cc98,xxt` | `xzzd,zdbk,zhiyun,pta,cc98`（`xxt` 需显式加入） |
| `ZJU_NETWORK` | `auto`（先直连，不通走 WebVPN）/ `direct` / `webvpn` | `auto` |
| `ZJU_OMNI_DATA_DIR` | 会话、预览计划等本地状态目录 | `~/.local/share/zju-omni` |
| `ZJU_USERNAME` / `ZJU_PASSWORD` | 不用钥匙串时的替代（需自行保护启动环境） | — |
| `ZJU_XZZD_STORAGE_HOSTS` | 学在浙大文件存储的额外允许域名 | — |

## 命令

```sh
npm run cli -- status [--check]                # 凭据、会话、网络模式
npm run cli -- login [平台]                    # 默认 xzzd
npm run cli -- forget [平台] [--credentials]   # 删除会话（及钥匙串账号）
npm run cli -- tools [full|lite]               # 工具目录与字符数
npm test                                       # 单元 + MCP 协议测试（无网络）
npm run typecheck
npm run smoke [-- --lite] [-- --only=zhiyun]   # 真机只读冒烟：只调用读工具，只输出计数、错误码和字段名
```

## 设计要点

- **账号**：只存 macOS 钥匙串（服务名 `zju-omni.zjuam` / `zju-omni.cc98` / `zju-omni.xxt`），`accounts.json` 只记账号名。
- **会话**：每个平台一个 `sessions/<平台>.json`（权限 600）。只保存平台自身 Cookie，统一认证票据只留在进程内存，用于同一进程内其他平台免密登录。WebVPN 票据单独保存在 `sessions/webvpn.json`。
- **认证**：真实 CAS HTTP 链路，密码按学校 RSA 方案加密，**只提交一次**；遇到密码错误、验证码、二次验证、WebVPN 多端确认立即停止并说明。
- **自动重登**：读操作会话失效时重登一次并重试；写操作先做只读预检，写请求一旦发出绝不重放。
- **写操作**：一律 `prepare`（预览 + `plan_id`，15 分钟有效）→ `execute` → 读回核对；结果不确定时报告 `accepted_unverified` / `OUTCOME_UNKNOWN`，不自动重试。
- **限速**：每个平台请求串行，最小间隔 200 ms。
- **输出**：full 返回 `structuredContent`（`{ok, data|error, meta}`）；lite 去掉 `null`、空数组、`url`、`meta`，正文默认 ≤6000 字，用 `next_offset` 续读。lite 工具目录由测试锁定 ≤6000 字符。

## 目录

```
src/
  core/        配置、错误、Cookie、HTTP（直连/WebVPN 传输）、限速、钥匙串、会话存储、会话生命周期、工具注册
  auth/        统一认证 CAS、WebVPN、跨平台 zju_auth_* 工具
  platforms/   xzzd/（client、reads、actions、workflows、sync、tools）、zdbk/（client、parse、reads、tools）、zhiyun/（client、reads、tools）
  lite/        小模型版任务型工具
  app.ts       组装服务；server.ts stdio 入口；cli.ts 命令行
skills/        zju/（正常版）、zju-lite/（小模型版，≤1.5 KB）
packaging/     mcp.json 通用示例（Codex / Claude Code / DSH 包装在第 5 阶段）
docs/          xzzd/、zdbk/、zhiyun/ 接口适配记录
tests/         node:test 单元与协议测试、smoke/ 真机只读脚本
```

## 致谢与许可

MIT。智云课堂接口用法参考 [8eoyw/zju-learning-cli](https://github.com/8eoyw/zju-learning-cli)（MIT）。WebVPN URL 加密与登录表单参考 [EviterLesRoses2/cc98-mcp](https://github.com/EviterLesRoses2/cc98-mcp)（MIT，其上游为 Lucent-Snow/CC98-CLI，MIT）。
