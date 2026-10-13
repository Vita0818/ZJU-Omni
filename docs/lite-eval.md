# 小模型版实测（固定题目）

`npm run eval:lite -- --model=<LM Studio 模型名>`：用 [tests/lite-eval/questions.json](../tests/lite-eval/questions.json) 里的 10 道固定题，通过 LM Studio 的 OpenAI 兼容接口驱动本地模型调用 lite 工具。使用真实账号，只读：`zju_submit`、`zju_prepare_submission`、`zju_sync` 被拦截，不会到达平台。

每题检查：第一个调用的工具是否正确、必要的后续工具是否调用、禁止的工具（未确认的 `zju_submit`）没有调用、参数合法、工具没有报错、最终给出回答。

系统提示为 MCP 服务 instructions + `skills/zju-lite/SKILL.md` 正文 + 当天日期，模拟 DSH 加载技能后的上下文。

## 2026-10-12

模型 `ornith-1.5-9b`（LM Studio，上下文 32K，temperature 0，关闭思考）：**10/10**。

| 题目 | 调用链 | 耗时 |
| --- | --- | --- |
| deadlines 未交作业 | zju_deadlines | 48 s |
| schedule 周三课表 | zju_schedule | 22 s |
| exams 考试安排 | zju_exams | 20 s |
| gpa 绩点 | zju_grades | 20 s |
| courses 本学期课程与学分 | zju_courses | 18 s |
| search 搜“实验报告” | zju_search → zju_search | 83 s |
| assignment 最早截止作业的要求 | zju_deadlines → zju_assignment | 46 s |
| lecture 最近一节课的转录总结 | zju_lectures → zju_transcript | 26 s |
| materials 第一门课的课件 | zju_courses → zju_materials | 22 s |
| no-unconfirmed-submit 交作业 | zju_deadlines → zju_prepare_submission（未调用 zju_submit） | 46 s |

耗时主要是本地模型处理工具结果的时间（`zju_search` 工具本身约 7 s）。

实测中发现并已修复：

- 教务会话过期时返回非标准 HTTP 901，原来被当成平台错误，没有触发自动重登。现在 901/902 视为 `LOGIN_REQUIRED`。
- `zju_courses` 原来列全部学期（33 门、要翻页），模型会反复翻页直到轮数用完。现在默认只列本学期，按名称搜索时才查全部学期。
- `zju_search` 默认不读正文（47 s → 7 s），需要时传 `include_body=true`。

## 2026-10-12：真实 DSH（headless）

`node tests/lite-eval/dsh.ts --model=<模型>`：用真实 `dsh headless` + lite MCP + zju-lite 技能跑同样 10 题。使用 `build/dsh-eval/home` 作为隔离的 `DSH_HOME`，不改 `~/.dsh`；工作目录在仓库外。DSH 里没有拦截写操作，所以“交作业”题的目标文件故意不存在。

`ornith-1.5-9b`：首轮 6/10，调整后 9/10（剩下 1 次是教务偶发 HTTP 922，已加重试）。DSH 标准预设本身约 1 万 token 的系统提示和工具说明，单题 25–140 秒。

调整：

- 技能文档写明这些是 MCP 工具（DSH 中为 `mcp__zju__…`），不要用 bash 找；之前模型会翻源码找“zju-lite 命令行”。
- 两分钟内相同参数的重复读取、或参数变了结果却完全相同时，返回提示让模型直接回答；曾出现同一调用连续 24 次、77 次。
- 拼题A 列题一次返回所有题型；考场座位未排定时写“未公布”；顶层空列表保留，不再返回 `{}`。
- `zju_deadlines` 把学在浙大、拼题A、学习通合并成一个已排序列表（先未到期、再已过期、最后未知），附 `today`；之前 9B 自己合并两个列表时把日期和顺序弄错。
- 课程代码只显示正规代码，不显示内部编号。

人工读答案：课表、考试、绩点、课程学分、搜索、作业要求、课件、转录总结基本正确；转录总结偏长、偶有英文开头；交不存在的文件时没有越权提交。

## 2026-10-13：DSH 复测（合并截止列表之后）

| 模型 | 工具调用通过 | 人工核对答案 | 单题耗时 |
| --- | --- | --- | --- |
| `ornith-1.5-9b` | 9/10（交作业题里 `zju_deadlines` 调了 5 次） | 7 题准确，3 题有错：课程总学分算成 34.5（实为 23.5）并编造“不计学分”；把上学期成绩说成“本学期”；说学术诚信题集是编程题（实为判断题） | 16–87 s |
| `swift-1.5-qwen3.8-27b-gsq-rco` | 9/10（转录题逐段读完 5 万字转录，900 s 超时） | 8 题准确，2 题有错：总学分算成 31.5；把 22:00 截止说成 20:00 | 42–196 s，转录题超时 |

两个模型都答对：截止排序（合并列表后不再乱序）、周三课表与单周、9 场考试和“未公布”考场、GPA 数值、实验报告搜索、课件列表、学术诚信作业的内容；交不存在的文件时都没有提交，27B 还主动请求确认。

## 2026-10-13：服务端预计算与 DSH 精简预设（未跑模型）

针对复测里两个模型共同的错误，改在服务端算好：

- `zju_courses` 返回 `credit_total`（有学分课程的合计）、`credit_missing`（平台没给学分的课程）和说明，不再让模型自己加。
- `zju_grades` 的 term 写成“2025-2026 春夏”，并给 `current_semester`，说明累计值和学期的关系。
- `zju_transcript` 每 5 分钟一个时间戳、同段合并，8000 字一页，并给出 `page`（如 1/4）和“概括读 1–2 段即可”的提示；一节 5 万字的课从 9 页降到约 4 页。
- `zju_deadlines` 每项加 `left`（“还剩 4 小时”“已过期 3 天”）。

`packaging/dsh/lite.patch.yml`（ZJU-Omni Lite 的 DSH 组合包补丁）：用假的 OpenAI 接口抓 DSH 实际发出的请求测得：标准 headless 一次请求约 40 KB、43 个工具，加上本叠加层后约 6.4 KB、16 个工具（只剩 zju 工具），系统提示换成中文校园助手。工具调用全链路已用假模型验证。`node tests/lite-eval/dsh.ts --model=<模型> --lean` 使用该预设，结果写到 `result-<模型>-lean.json`。

已用打包的 tgz 在隔离的 DSH_HOME 里实装验证：`dsh plugin --profile zju-omni add <tgz>` 自动把 `zju-omni` 加进 profile 的 bundles，服务用 DSH 自带的 Node 从 profile 的 node_modules 启动，假模型调用 `zju_exams` 拿到了真实数据。

之后按版本拆成两个组合包：`zju-omni`（full，只加工具和 `zju` 技能）与 `zju-omni-lite`（lite + 精简预设，服务名 `zju_lite`）。在隔离的 DSH_HOME 里分别装进两个 profile 验证：装标准版的 profile 保留 bash 等全部 81 个工具，其中 54 个是 `mcp__zju__…`，并加载了 `zju` 技能，假模型调用 `zdbk_list_exams` 成功；装 Lite 版的 profile 只有 16 个 `mcp__zju_lite__…` 工具和中文提示，调用 `zju_exams` 成功。Codex、Claude Code 的插件包也同样生成两个版本，Claude 插件市场通过 `claude plugin validate`。

## 2026-10-13：Gemma 4 12B（QAT）

模型 `gemma-4-12b-it-qat`（LM Studio，上下文 32K，并行 1），真实 DSH headless，题目同上。

| 配置 | 通过 | 单题耗时 | 末步输入 |
| --- | --- | --- | --- |
| 精简预设（`--lean`，不加载技能） | 9/10 | 9–67 s | 2.3K–7.9K tok |
| 标准预设（加载 zju-lite 技能，bash 等内置工具全开） | 9/10 | 23–182 s | 10.4K–19.2K tok |

- 精简预设：作业要求题在两份同时截止的拼题A题集前停下来反问，没有调用 `pta_problem`；交作业题让用户提供拼题A题号，像是能往拼题A交。
- 标准预设：交作业题 `zju_deadlines` 调了 4 次（判循环），中间对一份未开放的学在浙大作业调用了预览（平台拒绝）；作业要求题跳过最早的拼题A题集读了学在浙大作业；转录题选了列表第一项（13:25），不是最近的一节（18:50）。全程没有调用 bash 等内置工具。
- 两种预设都答对：总学分 23.5、截止排序、9 场考试与“未公布”考场、GPA、课件、搜索。

据此修改（服务端算好、写进结果）：

- `zju_lectures` 严格按开始时间从新到旧，每项带 `no`，未开始的标 `upcoming`，并给出 `latest_started`；full 的 `zhiyun_my_lectures` 同样改为从新到旧。原来是“日期从新到旧、同一天内从早到晚”，第一项不一定是最近的一节。
- `zju_deadlines` 每项加 `urgent`（24 小时内截止）；`note` 写明 no=1 即最早截止、问最早的不用翻页、同时截止取第一个、学在浙大项用 `zju_assignment`、拼题A项用 `pta_problem`、只有学在浙大作业能交。
- 发布的工具 schema 去掉上下限、正则、长度和 `$schema`（服务端照旧严格校验）：lite 4,580 → 3,781 字符，full 26,716 → 16,528 字符。

修改后精简预设复测：**10/10**，单题 10–64 s。作业要求题改为 `zju_deadlines → pta_problem`，列出了 HW5 的 5 道题；转录题选对 18:50 的一节；交作业题明确说明拼题A需在网页提交。转录总结里的“普列亚诺夫”（应为普列汉诺夫）无法核对：DSH 事件日志只保留约 3,000 字的工具结果。
