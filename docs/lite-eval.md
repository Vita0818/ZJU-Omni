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
