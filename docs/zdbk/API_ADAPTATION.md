# 本科教务（ZDBK）接口适配记录

整理日期：2026-10-12。本文只记录接口依据，不含账号数据、Cookie 或真实成绩。

## 依据与许可

接口地址和字段含义参考了 Celechron（GPL-3.0）的公开实现。按 PLAN 第 7 节，只参考接口思路，代码是独立编写的，没有复制。真机只读验证还没做（`npm run smoke`）。

## 登录

- 入口：`https://zjuam.zju.edu.cn/cas/login?service=https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html`
- CAS 回调的 Location 可能是 `http://zdbk…`，只对 zdbk 主机升级为 https，其他主机仍拒绝。
- 会话 Cookie：`JSESSIONID`（Path `/jwglxt`）和 `route`。只保存 `zdbk.zju.edu.cn` 主机的 Cookie。
- 登录验证：成绩接口 `showCount=1` 返回 `items` 数组。

## 接口（均为 POST，带 `X-Requested-With: XMLHttpRequest` 和 Referer `xtgl/index_initMenu.html`）

| 功能 | 路径（`/jwglxt` 下） | 参数 | 返回 |
| --- | --- | --- | --- |
| 全部成绩 | `/cxdy/xscjcx_cxXscjIndex.html` | `doType=query&queryModel.showCount=5000` | `items[]`：`xkkh` 选课课号、`kcmc` 课程名、`xf` 学分、`cj` 成绩、`jd` 五分制绩点 |
| 主修成绩 | `/zycjtj/xszgkc_cxXsZgkcIndex.html` | 同上 | 同上 |
| 考试安排 | `/xskscx/kscx_cxXsgrksIndex.html` | 同上 | `items[]`：`kssj`/`jsmc`/`zwxh` 期末时间/考场/座位，`qzkssj`/`qzjsmc`/`qzzwxh` 期中 |
| 个人课表 | `/kbcx/xskbcx_cxXsKb.html` | 表单 `xnm=2025-2026&xqm=1\|秋&captcha_value=` | `kbList[]` 或 `null`；`captcha_error` 表示要验证码 |

- `xkkh` 形如 `(2025-2026-1)-课程代码-…`，学年和学期（1 秋冬、2 春夏）从这里解析。
- `xqm`：`1|秋`、`1|冬`、`2|春`、`2|夏`。
- 课表 `kbList` 条目：`kcb` 为“课程名<br>学期<br>教师<br>地点zwf…”，`xqj` 星期，`djj` 起始节次，`skcd` 节数，`dsz` 0=单周、1=双周，`xxq` 所跨学期，`sfyjskc=1` 的条目跳过。
- 考试时间：`2026年01月15日(08:00-10:00)` 解析成带 +08:00 的时间；只有“考试周第 N 天”时保留原文。

## 本地计算

- GPA = Σ(绩点×学分)/Σ学分，只计入有绩点、不是弃修/待录/缓考/无效、也不是合格/不合格的课程。
- 4.3 制：5.0→4.3、4.8→4.2、4.5→4.1、4.2→4.0，其余封顶 4.0。
- 均分：等级制按常用百分制对照（A+ 95、A 90 … 合格 75）。
- 节次时间按紫金港常规作息推算。

以上都是派生数据，工具输出里注明以官方为准。

## 未覆盖

验证码识别（遇到就停止）、研究生教务、实践分、培养方案、选课。
