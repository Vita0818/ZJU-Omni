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
