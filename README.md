# ZJU-Omni

浙大校园平台的统一 MCP 服务（服务名 `zju-omni`）。一份代码，两个档位：

- **full**（默认）：给 Codex、Claude Code 等长上下文客户端，按平台前缀提供全部读写工具。
- **lite**：给本地小模型 / DeepSeek Harness，少量任务型工具、短说明、压缩结果，保留交作业。

实施计划见 [PLAN.md](PLAN.md)。

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 骨架与公共层：统一认证（CAS）、WebVPN、钥匙串、档位与平台开关、限速、体积测试 | 完成（直连与 WebVPN 均已真机验证） |
| 2 | 学在浙大迁移（原 `zju-tronclass` 24 个工具 → 3 个 `zju_auth_*` + 21 个 `xzzd_*`） | 完成（真机只读冒烟通过） |
| 3 | 教务（ZDBK）：课表、成绩与绩点、考试安排（只读，4 个 `zdbk_*`） | 完成（真机只读冒烟通过） |
| 4 | 智云课堂：我的堂次、课程堂次、课堂转录、PPT 时间轴与截图下载（6 个 `zhiyun_*`） | 完成（真机只读冒烟通过） |
| 5 | lite 补全（课程学分）、技能文档、Codex / Claude Code / DSH / 通用客户端包装、本地模型固定题实测 | 完成（直连 LM Studio：ornith-1.5-9b 10/10；真实 DSH：9B、27B 各 9/10，见 [docs/lite-eval.md](docs/lite-eval.md)） |
| 6 | 拼题A：我的题集与截止、题集详情与进度、题目列表、题面（只读，4 个 `pta_*`；浏览器 Cookie 导入） | 完成（真机只读冒烟通过） |
| 7 | CC98：搜帖、读帖、十大、版面、用户、通知、私信（读）；回帖、发帖、私信（两步确认写，16 个 `cc98_*`） | 完成（读接口经 WebVPN 真机验证；写操作未实测，需你点名具体帖子） |
| 8 | 学习通（可选，默认不加载）：课程、作业与截止、考试、通知、课表（只读，6 个 `xxt_*`；浏览器 Cookie 导入）；启用后 `zju_deadlines` 并入学习通作业 | 完成（真机只读验证）；课件同步、资料区、云盘暂未移植 |

full 档目前 54 个工具（启用学习通后 60 个）。lite 档 16 个（工具目录约 4,600 字符）：`zju_deadlines`、`zju_courses`、`zju_assignment`、`zju_materials`、`zju_sync`、`zju_search`、`zju_prepare_submission`、`zju_submit`（学在浙大），`zju_schedule`、`zju_exams`、`zju_grades`（教务），`zju_lectures`、`zju_transcript`（智云），`pta_problem`（拼题A），`zju_deadlines` 把学在浙大作业、拼题A 题集（和启用时的学习通作业）合并成一个按截止时间排好序的列表，`cc98_search`、`cc98_topic`（CC98）。

## 安装

需要 Node 22.18+。

```sh
npm install
npm run build
npm run configure -- zju   # 在自己的终端运行：账号输入一次，密码由 macOS security 隐藏读取并存入钥匙串
npm run login              # 可选：立即验证登录
pbpaste | npm run cli -- pta-cookie   # 拼题A：浏览器登录后复制任一 /api 请求的 cURL 或 Cookie，再运行
npm run configure -- cc98             # CC98 论坛账号（可选）
pbpaste | npm run cli -- xxt-cookie   # 学习通（需 ZJU_PLATFORMS 含 xxt）：浏览器登录后复制 cURL 或 Cookie
npm run configure -- webvpn           # 校外访问需要：WebVPN 用“上网账号”，与统一认证是两套系统
```

已经配置过 `zju-tronclass` 的机器会自动只读复用它的钥匙串账号，无需重新配置（`status` 中显示 `legacy-zju-tronclass`）。

## 客户端接入

`npm run package -- <codex|claude|dsh|all>` 在 `build/` 下生成各客户端的包装（`build/` 不进仓库）：

| 客户端 | 生成物 | 安装 |
| --- | --- | --- |
| Codex | `build/codex/zju-omni/`：`.codex-plugin/plugin.json`、`.mcp.json`、`skills/zju`、`dist`、生产依赖（Codex 会把插件复制进缓存，所以自包含） | 在 `~/.agents/plugins/marketplace.json` 加一条本地来源，`codex plugin add zju-omni@personal`（命令会打印具体条目） |
| Claude Code | `build/claude/`：本地插件市场 + `zju-omni/` 插件（`.claude-plugin/plugin.json`、`.mcp.json` 用 `${CLAUDE_PLUGIN_ROOT}`、`skills/zju`） | `claude plugin marketplace add <build/claude 绝对路径>`，`claude plugin install zju-omni@zju-omni` |
| DSH | `build/dsh/zju-omni.cordis.patch.yml`：`dsh-mcp-client`（lite，工具超时 120 s）+ `dsh-skill-filesystem`（只加载 `zju-lite`） | 把片段追加到 `~/.dsh/profiles/<profile>/cordis.patch.yml`，重启 DSH。工具名形如 `mcp__zju__zju_deadlines` |
| DSH：ZJU-Omni 预设 | 组合包（bundle），补丁是 [packaging/dsh/preset.patch.yml](packaging/dsh/preset.patch.yml)：加入 ZJU-Omni（lite），并把整个 profile 变成精简的校园助手 | 见下方“DSH 预设”。适合本地小模型；会去掉整个 profile 的 bash、文件等工具，请装在单独的 profile 里 |
| 其他 MCP 客户端 | [packaging/mcp.json](packaging/mcp.json) | `node /绝对路径/dist/server.js`，stdio；`MCP_TOOL_PROFILE` 选 full 或 lite |

包装模板在 `packaging/`，生成脚本是 `scripts/package.ts`。

### DSH 预设

ZJU-Omni 本身就是一个 DSH 组合包：`package.json` 的 `dsh.bundle.patch` 指向 `packaging/dsh/preset.patch.yml`。装进某个 profile 后：

- 加入 ZJU-Omni MCP 服务（lite），用 DSH 自带的 Node 运行（`process.execPath` + `ELECTRON_RUN_AS_NODE`），从 profile 的 `node_modules/zju-omni` 启动，不依赖本机路径；
- 去掉 bash、PowerShell、文件、网页、子代理、计划、待办、技能等工具和编程人设，换成中文提示“你是 ZJU-Omni……”，要求不编造、不自己推算日期和学分、写操作先确认；
- 每次请求从约 40 KB（43 个工具）降到约 6.4 KB（16 个 zju 工具）。

```sh
npm run pack:dsh                                   # 生成 build/release/zju-omni-<版本>.tgz（含 dist）
dsh zju-omni --from-default-profile web            # 新建一个 profile（web 模板，浏览器界面）
dsh plugin --profile zju-omni add /绝对路径/zju-omni-<版本>.tgz   # 或 GitHub Release 上 tgz 的下载地址
```

DSH 也能在网页或桌面版侧边栏的“插件”页安装组合包；它接受 npm 包名、GitHub 地址、tgz 地址和本地路径。仓库不提交 `dist/`，所以从 GitHub 地址直接安装需要现场构建，推荐用发布的 tgz。安装后在这个 profile 里配置模型（如 LM Studio），首次使用前在终端配置账号：仓库里是 `npm run configure`，只装了组合包时是 `node ~/.dsh/profiles/zju-omni/node_modules/zju-omni/dist/cli.js configure`。账号和会话保存在本机，与安装在哪个 profile 无关。

## 环境变量

| 变量 | 取值 | 默认 |
| --- | --- | --- |
| `MCP_TOOL_PROFILE` | `full` / `lite`，其他值启动报错 | `full` |
| `ZJU_PLATFORMS` | 逗号分隔：`xzzd,zdbk,zhiyun,pta,cc98,xxt` | `xzzd,zdbk,zhiyun,pta,cc98`（`xxt` 需显式加入） |
| `ZJU_NETWORK` | `auto`（先直连，不通走 WebVPN）/ `direct` / `webvpn`。WebVPN 使用单独配置的上网账号 | `auto` |
| `ZJU_OMNI_DATA_DIR` | 会话、预览计划等本地状态目录 | `~/.local/share/zju-omni` |
| `ZJU_USERNAME` / `ZJU_PASSWORD` | 不用钥匙串时的替代（需自行保护启动环境） | — |
| `WEBVPN_USERNAME` / `WEBVPN_PASSWORD`、`CC98_USERNAME` / `CC98_PASSWORD` | 对应账号的环境变量替代 | — |
| `CHAOXING_COOKIE` | 学习通 Cookie 的替代来源 | — |
| `PINTIA_COOKIE` | 拼题A Cookie 的替代来源（优先于导入的会话） | — |
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
npm run eval:lite -- --model=ornith-1.5-9b     # 本地模型固定题实测（需 LM Studio 服务），写操作被拦截
node tests/lite-eval/dsh.ts --model=<模型> [--lean]  # 真实 DSH headless 实测（隔离 DSH_HOME，--lean 使用 ZJU-Omni 预设）
npm run pack:dsh                               # 打包 DSH 组合包 build/release/zju-omni-<版本>.tgz
```

## 设计要点

- **拼题A**：登录要短信验证，不存密码、不自动登录；导入的浏览器 Cookie 存为 `sessions/pta.json`（600），失效时提示重新导入。
- **账号**：只存 macOS 钥匙串（服务名 `zju-omni.zjuam` / `zju-omni.webvpn` / `zju-omni.cc98` / `zju-omni.xxt`），`accounts.json` 只记账号名。
- **不重复提交密码**：统一认证、WebVPN、CC98 一旦拒绝凭据或要求验证码，同一进程 15 分钟内的自动登录直接报错，不再提交；修正后用 `zju_auth_login` 显式登录。
- **会话**：每个平台一个 `sessions/<平台>.json`（权限 600）。只保存平台自身 Cookie，统一认证票据只留在进程内存，用于同一进程内其他平台免密登录。WebVPN 票据单独保存在 `sessions/webvpn.json`。
- **认证**：真实 CAS HTTP 链路，密码按学校 RSA 方案加密，**只提交一次**；遇到密码错误、验证码、二次验证、WebVPN 多端确认立即停止并说明。
- **自动重登**：读操作会话失效时重登一次并重试；写操作先做只读预检，写请求一旦发出绝不重放。
- **写操作**：一律 `prepare`（预览 + `plan_id`，15 分钟有效）→ `execute` → 读回核对；结果不确定时报告 `accepted_unverified` / `OUTCOME_UNKNOWN`，不自动重试。
- **限速**：每个平台请求串行，最小间隔 200 ms。
- **小模型友好**：lite 里需要计算或合并的值都在服务端算好：截止列表合并排序并带北京时间、星期和剩余时间，附 `today`；课程返回总学分和缺学分课程；成绩写明学期（如“2025-2026 春夏”）和当前学期；转录每 5 分钟一个时间戳、8000 字一段，并提示概括时不必读完。两分钟内重复的相同查询直接提示模型回答。
- **输出**：full 返回 `structuredContent`（`{ok, data|error, meta}`）；lite 去掉 `null`、空数组、`url`、`meta`，正文默认 ≤6000 字，用 `next_offset` 续读。lite 工具目录由测试锁定 ≤6000 字符。

## 目录

```
src/
  core/        配置、错误、Cookie、HTTP（直连/WebVPN 传输）、限速、钥匙串、会话存储、会话生命周期、工具注册
  auth/        统一认证 CAS、WebVPN、跨平台 zju_auth_* 工具
  platforms/   xzzd/（client、reads、actions、workflows、sync、tools）、zdbk/（client、parse、reads、tools）、zhiyun/（client、reads、tools）、pta/（client、cookie、reads、tools）、cc98/（client、ubb、reads、actions、tools）、xxt/（client、reads、tools）
  lite/        小模型版任务型工具
  app.ts       组装服务；server.ts stdio 入口；cli.ts 命令行
skills/        zju/（正常版）、zju-lite/（小模型版，≤1.5 KB）
packaging/     codex/、claude/、dsh/ 包装模板，mcp.json 通用示例；scripts/package.ts 生成 build/
docs/          xzzd/、zdbk/、zhiyun/、pta/、cc98/、xxt/ 接口适配记录
tests/         node:test 单元与协议测试、smoke/ 真机只读脚本、lite-eval/ 本地模型固定题
```

## 致谢与许可

MIT。学习通部分移植自 zju-chaoxing（MIT，上游 © Wu Jiale）。CC98 登录与接口参考 cc98-mcp（MIT）与本地 cc98-desktop。拼题A 接口路径与 [jinzcdev/vscode-pintia](https://github.com/jinzcdev/vscode-pintia)（MIT）核对。智云课堂接口用法参考 [8eoyw/zju-learning-cli](https://github.com/8eoyw/zju-learning-cli)（MIT）。WebVPN URL 加密与登录表单参考 [EviterLesRoses2/cc98-mcp](https://github.com/EviterLesRoses2/cc98-mcp)（MIT，其上游为 Lucent-Snow/CC98-CLI，MIT）。
