# dsh-daily-plan · 每日任务

Daily plan panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a bilingual project.

[中文](#chinese) | [English](#english)

---

<a id="chinese"></a>

## 中文

DeepSeek Harness 的「每日任务」插件：左侧边栏的一级面板，按截止时间自动分组今天要做的事，可就地编辑备注、优先级和重复规则；每个任务都能一键进入全屏专注倒计时；可选云同步，让多台电脑共用一份清单。

```
待办   已完成
 ─────── 进度 ───────
 ‹  › 11月24日 周二            回到今天
 ┌ 要做什么？回车即可添加       [添加任务] ┐
 │ 2026/11/24  --:--  今天 明天 后天  普通  备注 │
 └──────────────────────────────┘
 已逾期   1
 上午 · 12:00 前   1
 下午 · 12:00–18:00   1   [开干吧] [编辑] [×]
 晚上 · 18:00 后   …
 之后 2   ·   暂未安排时间   ·   已完成 (折叠)
```

### 功能特性

- **打开即见今天。** 左侧边栏新增 `每日任务` 行，显示待办/已完成计数和完成进度条；`‹` `›` 切换日期，`回到今天` 跳回当天。
- **按截止时间分组。** `已逾期`（在任何日期视图里都按"现在"判断）→ `之前` → `上午 · 12:00 前` / `下午 · 12:00–18:00` / `晚上 · 18:00 后` → `全天` → `之后` → `暂未安排时间`；完成的任务收在当前查看日期下的折叠 `已完成` 区。
- **计数与列表一致。** 顶部数字就是未完成任务数和你正在查看那天的完成数，永远不会和下面的分组对不上。
- **自由设定完成时间。** 日期 + 时间选择器，`今天` / `明天` / `后天` 快捷按钮；时间留空即为全天任务；还可以写多行备注、标优先级。
- **待办语义。** 左侧圆圈勾选完成；`编辑` 就地修改标题、时间、备注、优先级和重复规则（已完成任务也能改）；`×` 删除后有 **8 秒撤销** 横幅；`清理已完成` 会先确认，且只清理当前查看的那一天。
- **重复任务。** 支持每天、工作日、每周、每月重复；完成一次会把这次记入已完成历史，并自动生成下一次（标题、备注、时间保持一致）。
- **到期提醒。** 底部 🔔 开关打开后，任务到期会响铃、弹提示，并在浏览器允许时发系统通知；面板打开期间生效。
- **键盘操作。** 面板内按 `/` 聚焦输入框；`Esc` 退出专注全屏；所有控件都有可见的焦点环。
- **鼓励提示。** 面板底部有一条醒目的「每日一句」，每天在 **诗词 / 句子 / 电影台词 / 英文** 四类来源间轮换（一言 / ZenQuotes，网络获取），缓存在 `$DSH_HOME/daily-plan/quote.json`，离线时先回退到上次缓存、再用内置句子；完成任务会弹随机鼓励，当天第 1、3、5、10 件以及全部清空时还有专属文案。
- **铺满面板。** 卡片占用整个主区域：任务列表在内部滚动，底部状态栏和每日一句固定可见，大屏不再留大片空白。
- **按紧急程度排序。** 日期行有 `按时间 / 按紧急程度` 切换；紧急视图是单列队列，顺序为逾期时间 → 距截止（≤1 小时、≤6 小时、≤24 小时、≤3 天、≤7 天）→ 优先级，每行带紧急标签；选择会被记住。
- **已完成记录与导出。** `已完成记录` 页按完成时间倒序列出 完成时间 / 任务 / 备注 / 截止时间，支持 全部 / 最近 7 天 / 最近 30 天 / 自定义时间段筛选；一键把当前视图导出为 Markdown 表格或真正的 `.xlsx` 工作簿（宿主生成，零依赖）。
- **专注计时。** 每行都有 `开干吧`：请求浏览器全屏，显示大号倒计时和进度环，可暂停、可加 5 分钟，预设 15/25/45/60 分钟（中途改预设会先确认重置），结束时响铃提示 `时间到`；专注时长累计在任务上（`已专注 N 次 · M 分钟`）。专注层覆盖所有面板（包括宠物挂件）。
- **模型可用。** `daily_tasks` 工具让模型读写同一份任务：列表、添加、修改、完成、删除。
- **可选云同步。** 把一份 JSON 文档放在 S3 兼容对象存储（雨云、MinIO、R2 等）或 WebDAV（Nextcloud、坚果云等），多台电脑同步合并。底部显示 `☁ 上次同步 · 3 分钟前`，点击立即同步（同步中显示 `⟳ 同步中…`，失败变红并给出原因）。用 `daily_sync` 工具配置。
- **状态健壮。** 首次加载先显示 loading 而不是空列表闪烁；备注支持多行；错误会通过 aria-live 播报给辅助技术。
- **数据本地且耐久。** 所有任务存在本机一个 JSON 文件里；写入原子化，文件损坏会先备份而不是覆盖；云同步可选，不配置就完全留在本机。

### 安装

在 DSH Web 界面打开 **插件 → 添加插件**，输入框支持包名、GitHub 仓库地址或安装包直链，任选其一：

```
dsh-daily-plan
https://github.com/msz2023/dsh-daily-plan
https://cn-nb2.rains3.com/daily-plan/plugins/dsh-daily-plan-1.6.6.tgz
```

也可以用 `dsh` 命令行：

```sh
dsh plugin --profile desktop add dsh-daily-plan
```

安装后刷新页面（或重启 DSH），左侧边栏会出现 `每日任务` 行，插件页也会列出它。

环境要求：DSH `>= 0.2.2-rc.5`，Web 平台（桌面版和 `dsh web` 都可以）。无需构建步骤，也没有运行时依赖——包内是纯 ES 模块。

### 数据

`$DSH_HOME/daily-plan/tasks.json`（Windows 上通常是 `C:\Users\<你>\.dsh\daily-plan\tasks.json`）。启动 DSH 前设置环境变量 `DSH_DAILY_PLAN_FILE` 为完整路径即可换位置。文件是普通 JSON，方便备份、diff 或预置：

```json
{
  "version": 2,
  "updatedAt": 1764067800000,
  "tasks": [ { "id": "…", "title": "写周报", "due": "2026-11-24T06:30:00.000Z", "allDay": false, "done": false, "priority": "high", "note": "", "focusSeconds": 0, "focusCount": 0, "updatedAt": 1764067800000 } ],
  "tombstones": { "被删任务 id": 1764067800000 }
}
```

`tombstones` 是删除标记：它让一台机器上的删除能同步到其他机器，而不是被旧数据合并回来。1.0 版本写出的文件（裸数组或 `{ "tasks": […] }`）仍然可以读取。

### 云同步

同步引擎在云端保存一份 JSON 文档，每 20 秒（本地改动后约 1 秒）与本地列表合并一次：

- **合并规则：** 按任务比较 `updatedAt`，最新修改生效；删除用 tombstone 记录；比删除更新的编辑会让任务"复活"。所有机器最终得到同样的字节，不存在"以哪个文件为准"。
- **云端位置：** 一个对象或文件即可。雨云对象存储走 S3（示例 `endpoint: https://cn-sy1.rains3.com`，`region: rainyun`）；WebDAV 可用于 Nextcloud、坚果云等。
- **密钥处理：** S3 SecretKey / WebDAV 密码存进 DSH 凭据库（`DAILY_PLAN_SYNC_SECRET`）；`$DSH_HOME/daily-plan/sync.json`（权限 0600）只写非敏感配置。没有凭据库时才会回退到该文件。

在对话里配置（或读回状态）：

```
用 daily_sync 配置雨云对象存储同步：endpoint https://cn-sy1.rains3.com，
bucket 我的桶，region rainyun，accessKey …，secret …

用 daily_sync 配置 WebDAV 同步：url https://dav.example.com/daily-plan/tasks.json，
用户名 …，密码 …
```

S3 两种寻址方式都支持（`<endpoint>/<bucket>/<key>` 与 `<bucket>.<endpoint>/<key>`）；连接测试在第一种被拒时会自动换另一种，所以只支持单一寻址风格的服务商也能用。

首次同步预期：本地列表会和云端已有内容合并——两台都在用的机器接上同步不会丢数据。想停止同步并保持纯本地，调用 `daily_sync` 的 `action: "off"`。

### `daily_tasks` 工具

| 参数 | 含义 |
|---|---|
| `action` | `list`、`add`、`update`、`complete`、`delete`、`clearDone` |
| `id` | 从 `list` 拿到的任务 id（update / complete / delete 用） |
| `title`、`note`、`priority` | 标题、自由备注、`normal` / `high` / `low` |
| `due`、`allDay` | ISO 8601 截止时间（带用户时区偏移）；`allDay` 表示全天 |
| `done` | `complete` 的目标状态 |

每次调用都返回完整任务列表，模型与面板始终保持一致。

### `daily_sync` 工具

| 参数 | 含义 |
|---|---|
| `action` | `status`、`setup`、`now`、`off` |
| `provider` | `s3` 或 `webdav`（`setup` 必填） |
| `endpoint`、`bucket`、`key`、`region`、`accessKey` | S3：端点、桶名、对象 key（默认 `daily-plan/tasks.json`）、签名 region（雨云为 `rainyun`）、AccessKey 编号 |
| `style` | 可选 S3 寻址方式：`path`（默认）或 `virtual`；连接测试会自动回退 |
| `url`、`username` | WebDAV：文件地址和用户名 |
| `secret` | S3 SecretKey 或 WebDAV 密码；存入凭据库，永远不会回显 |

`status` 返回连接状态、最近成功同步时间、最近错误和（脱敏后的）配置，方便模型判断各机器是否已收敛。

### 实现结构

没有打包器、没有依赖，包体小且不受 peer 依赖解析漂移影响：

- [`index.js`](index.js) —— 宿主侧：JSON 存储、面板调用的 `/daily-plan-api` HTTP 接口、`daily_tasks` 工具、`daily_sync` 配置工具（只用 `node:` 内置模块）。
- [`sync.js`](sync.js) —— 同步核心：合并算法（任务 + tombstone）、WebDAV 传输、AWS Signature V4 签名的 S3 传输，以及串行的 pull-merge-push 引擎；同样零依赖。
- [`export.js`](export.js) —— 导出核心：已完成历史过滤、Markdown 表格、极简 OOXML `.xlsx` 写入器（用 `node:zlib` 打包 ZIP）。宿主以 `GET /daily-plan-api/export?format=markdown|xlsx` 提供。
- [`quote.js`](quote.js) —— 每日一句：每天从网络取一条并按分类缓存，离线时回退。
- [`client.js`](client.js) —— 浏览器侧：在 `sidebar.panellist` 注册侧边栏图标、在 `main` 的 keyed slot 注册页面，显示同步状态，读取 DSH 主题变量。
- [`cordis.patch.yml`](cordis.patch.yml) —— 插入 `daily-plan` 行的 bundle patch。
- [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) —— 插件页显示的标题和描述。

本地开发：把目录作为本地 bundle 安装（插件 → 添加插件 → 本地目录），改代码后刷新页面即可。

### 限制

- 面板只在 DSH Web 界面打开时运行；关闭页面会结束正在进行的倒计时。
- 全屏依赖浏览器 Fullscreen API；平台拒绝时专注视图仍会覆盖整个页面，计时照常工作。
- 切到其他主面板会卸载本页面，正在进行的专注会话随之结束。
- 删除任务只有 8 秒撤销窗口；横幅消失后任务即删除（删除也已同步到云端）。
- `清理已完成` 只清理当前查看那一天的已完成任务。
- 云同步不是实时的：另一台机器的改动要等下一次拉取（20 秒）或手动同步才可见，且每个 DSH 实例都要在运行才能参与；冲突按任务以最后编辑为准，没有交互式冲突提示。
- 到期提醒只在 `每日任务` 面板打开时触发；重复任务需要有截止时间才能生成下一次。
- 每日一句每天需要联网一次：诗词/句子/电影台词走 `v1.hitokoto.cn`，英文走 `zenquotes.io`；失败时显示昨天缓存，再退回内置本地句子。缓存是任务文件旁的普通 JSON。
- 已完成记录只包含仍保存在本机的任务：清空已完成列表（或同步合并了清空）后，这些记录会从历史和后续导出中消失。导出的时间戳使用本机时区。
- 云同步需要一份可写的 JSON 对象/文件；除存储账号本身之外没有多用户共享或权限控制。

### 许可

[MIT](LICENSE)

---

<a id="english"></a>

## English

A daily plan panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): today's tasks are grouped by the time they are due, the list is editable in place (title, time, note, priority, repeat), every task can start a full-screen focus countdown, and optional cloud sync shares one list across computers.

```
To do   Completed
 ─────── progress ───────
 ‹  › Nov 24, Tue              Today
 ┌ What do you need to do?  Enter to add   [Add task] ┐
 │ 2026/11/24  --:--  Today Tomorrow Day after  Normal  Note │
 └──────────────────────────────────────────┘
 Overdue   1
 Morning · before 12:00   1
 Afternoon · 12:00–18:00  1   [Start focus] [Edit] [×]
 Evening · after 18:00    …
 Later 2   ·   No time set   ·   Completed (collapsed)
```

### Features

- **Opens on today.** The left sidebar gains a `每日任务` row showing today's plan with open/done counters and a completion bar. `‹` `›` move to another day, `回到今天` returns to today.
- **Grouped by due time.** `已逾期` (past its due time right now, in every day view) → `之前` (due before the viewed day, not late yet) → `上午 · 12:00 前` / `下午 · 12:00–18:00` / `晚上 · 18:00 后` → `全天` → `之后` → `暂未安排时间`; finished tasks collect in a collapsed `已完成` section for the viewed day.
- **Counts match the list.** The hero numbers count exactly the open tasks and the viewed day's finished tasks, so they can never disagree with the groups below.
- **Pick a completion time.** Date + time pickers, `今天` / `明天` / `后天` quick chips, all-day tasks when the time is left empty, plus an optional note and a priority marker.
- **To-do semantics.** The circle on the left ticks a task off; `编辑` edits title, time, note, priority and repeat in place (finished tasks included); `×` deletes with an eight-second **Undo** banner; `清理已完成` asks for confirmation and clears only the day being viewed.
- **Repeating tasks.** A task can repeat daily, on weekdays, weekly or monthly; completing it keeps the occurrence in the finished history and spawns the next one with the same title, note and time.
- **Due reminders.** The footer's 🔔 toggle turns on in-panel reminders: a task that becomes due triggers a chime, a toast and a system notification when the browser allows it. It works while the 每日任务 panel is open.
- **Keyboard.** `/` focuses the composer from anywhere in the panel; `Esc` leaves the focus overlay; every control has a visible focus ring.
- **Encouragement.** A prominent quote banner at the bottom of the panel shows one item per day, rotating through four sources: 诗词 (Hitokoto poetry), 句子 (Hitokoto literature/philosophy), 电影台词 (Hitokoto movie lines) and English (ZenQuotes) — cached under `$DSH_HOME/daily-plan/quote.json`, with built-in local lines as the offline fallback. Finishing a task brings a short random encouragement (milestones at the first, third, fifth and tenth task of the day, plus a special line when the list is cleared).
- **Fills the panel.** The card uses the whole main area: the task list scrolls inside it, the status foot stays visible, and the quote banner sits at the bottom; the layout widens on large screens instead of leaving big empty margins.
- **Sort by urgency.** A `按时间 / 按紧急程度` switch in the date row changes the list: the urgency view is one flat queue ordered by overdue time, then time-to-due (≤1h, ≤6h, ≤24h, ≤3d, ≤7d), then priority, with an urgency chip on each row. The choice is remembered.
- **Completed history and export.** A `已完成记录` tab lists every finished task with completion time, task text, note and due time (all / last 7 days / last 30 days / a custom date range), newest first. One click downloads the same view as a Markdown table or a real `.xlsx` workbook (`完成时间 / 任务 / 备注 / 截止时间 / 优先级 / 重复`), generated by the host without any dependency.
- **Start focus.** Every task row carries `开干吧`: it requests real full screen and shows a large countdown with a progress ring, pausable, extendable by five minutes, 15/25/45/60-minute presets (changing the preset mid-session asks before resetting), a chime and `时间到` when it ends. Focused time accumulates on the task (`已专注 N 次 · M 分钟`). The overlay sits above every other panel, including the pet widget.
- **Agent-visible.** A `daily_tasks` tool lets the model list, add, update, complete and delete tasks — the same records the panel edits.
- **Optional cloud sync.** One JSON document in S3-compatible object storage (RainYun, MinIO, R2, …) or WebDAV (Nextcloud, 坚果云, …) is pulled, merged and pushed, so two or more machines share the same list. The panel footer shows `☁ 上次同步 · 3 分钟前` and syncs immediately when clicked (it shows `⟳ 同步中…` while the round runs, and turns red with the reason when it fails). Configure it with the `daily_sync` tool.
- **Robust states.** An initial loading state instead of a flash of the empty state; notes are multi-line; errors are announced to assistive tech.
- **Durable and local.** Tasks are stored in one JSON file on your machine; writes are atomic, and an unreadable file is backed up instead of being overwritten. Cloud sync is optional — without it everything stays local.

### Install

In the DSH Web GUI open **Plugins → Add plugin**. The dialog accepts a package name, a GitHub repository URL, or a tarball URL — enter one of:

```
dsh-daily-plan
https://github.com/msz2023/dsh-daily-plan
https://cn-nb2.rains3.com/daily-plan/plugins/dsh-daily-plan-1.6.6.tgz
```

Or from a terminal with the `dsh` CLI:

```sh
dsh plugin --profile desktop add dsh-daily-plan
```

Reload the page (or restart DSH). The `每日任务` row appears in the left sidebar; the plugin also lists on the Plugins page.

Requirements: DSH `>= 0.2.2-rc.5`, Web platform (the Desktop app and `dsh web` both work). No build step and no runtime dependencies — the package ships plain ES modules.

### Data

`$DSH_HOME/daily-plan/tasks.json` (on Windows usually `C:\Users\<you>\.dsh\daily-plan\tasks.json`). Set `DSH_DAILY_PLAN_FILE` to a full path before starting DSH to use another location. The file is plain JSON, so it is easy to back up, diff, or seed:

```json
{
  "version": 2,
  "updatedAt": 1764067800000,
  "tasks": [ { "id": "…", "title": "Write the weekly report", "due": "2026-11-24T06:30:00.000Z", "allDay": false, "done": false, "priority": "high", "note": "", "focusSeconds": 0, "focusCount": 0, "updatedAt": 1764067800000 } ],
  "tombstones": { "deleted-task-id": 1764067800000 }
}
```

`tombstones` are deletion markers: they are what makes a delete on one machine reach the others instead of being merged back in. A file written by 1.0 (a bare array or `{ "tasks": […] }`) still loads.

### Cloud sync

The sync engine keeps one JSON document in a cloud store and merges it with the local list every 20 seconds (and ~1 second after a local edit):

- **Merge rule:** per task, the newest `updatedAt` wins; deletes are tombstones; an edit newer than a delete resurrects the task. Every machine reaches the same bytes, so there is no "which file is right" question.
- **Where the cloud copy lives:** one object / file. RainYun object storage uses S3 (`endpoint: https://cn-sy1.rains3.com`, `region: rainyun`); WebDAV works with Nextcloud, 坚果云, and similar.
- **Secrets:** the S3 SecretKey / WebDAV password goes into the DSH credential store (`DAILY_PLAN_SYNC_SECRET`); only the non-secret settings are written to `$DSH_HOME/daily-plan/sync.json` (0600). If no credential store exists it falls back to that file.

Configure it in chat (or read it back):

```
Configure RainYun object storage sync with daily_sync: endpoint https://cn-sy1.rains3.com,
bucket my-bucket, region rainyun, accessKey …, secret …

Configure WebDAV sync with daily_sync: url https://dav.example.com/daily-plan/tasks.json,
username …, password …
```

Both addressing styles of S3 are supported (`<endpoint>/<bucket>/<key>` and `<bucket>.<endpoint>/<key>`); the connection test switches styles automatically when the first one is refused, so a provider that speaks only one still works.

Expected first sync: the local list is merged with whatever the cloud already holds — nothing is dropped by connecting two machines that were both in use. To stop syncing and keep everything local, call `daily_sync` with `action: "off"`.

### The `daily_tasks` tool

| Parameter | Meaning |
|---|---|
| `action` | `list`, `add`, `update`, `complete`, `delete`, `clearDone` |
| `id` | Task id from `list` (update / complete / delete) |
| `title`, `note`, `priority` | Title, free-form note, `normal` / `high` / `low` |
| `due`, `allDay` | ISO 8601 due time with the user's offset; `allDay` for a whole-day task |
| `done` | Target state for `complete` |

Every call returns the complete task list, so the model stays in sync with the panel.

### The `daily_sync` tool

| Parameter | Meaning |
|---|---|
| `action` | `status`, `setup`, `now`, `off` |
| `provider` | `s3` or `webdav` (required by `setup`) |
| `endpoint`, `bucket`, `key`, `region`, `accessKey` | S3 storage: endpoint, bucket, object key (default `daily-plan/tasks.json`), signing region (RainYun: `rainyun`), access key id |
| `style` | Optional S3 addressing: `path` (default) or `virtual`; the connection test falls back automatically |
| `url`, `username` | WebDAV: the file URL and user name |
| `secret` | S3 SecretKey or WebDAV password; stored in the credential store and never echoed back |

`status` returns the connection state, last successful sync time, the last error, and the (masked) settings, so an agent can report whether the other machines are converging.

### How it is built

No bundler and no dependencies, which keeps the published package small and immune to peer-resolution drift:

- [`index.js`](index.js) — host half: the JSON store, the `/daily-plan-api` HTTP API the panel talks to, the `daily_tasks` tool, and the `daily_sync` configuration tool (the plain shape the tool registry accepts; it imports only `node:` builtins).
- [`sync.js`](sync.js) — the sync core: the merge algorithm (tasks + tombstones), the WebDAV transport, the S3 transport signed with AWS Signature V4, and the serialized pull-merge-push engine. Also dependency-free.
- [`export.js`](export.js) — the export core: the completed-history filter, the Markdown table, and a minimal OOXML `.xlsx` writer (ZIP built with `node:zlib`). Exposed by the host as `GET /daily-plan-api/export?format=markdown|xlsx`.
- [`quote.js`](quote.js) — the daily quote: fetches one item per day, caches it by kind, and falls back offline.
- [`client.js`](client.js) — browser half: registers the sidebar icon in `sidebar.panellist` and the page in the `main` keyed slot, shows the sync chip, and reads DSH theme tokens.
- [`cordis.patch.yml`](cordis.patch.yml) — the bundle patch that inserts the `daily-plan` row.
- [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) — the title and description the Plugins page shows.

Local development: install the folder as a local bundle (`Plugins → Add plugin → local directory`), edit the modules, and reload the page.

### Limitations

- The panel runs only while the DSH Web GUI is open; closing the page ends a running countdown.
- Full screen depends on the browser's Fullscreen API. When the platform refuses it, the focus view still covers the whole page and the timer keeps working.
- Switching to another main panel unmounts the page and ends a running focus session.
- A deleted task can be restored for eight seconds; after the banner disappears it is gone (and the deletion has already reached the cloud).
- `清理已完成` only clears the finished tasks of the day you are viewing.
- Cloud sync is not realtime: another machine's edits appear on the next pull (20 s) or manual sync, and each DSH instance must be running to take part. Conflicts resolve per task by last edit; there is no interactive conflict prompt.
- Due reminders only fire while the 每日任务 panel is open; a repeated task needs a due time to spawn its next occurrence.
- The daily quote needs network access once per day: `v1.hitokoto.cn` for 诗词/句子/电影台词 and `zenquotes.io` for English. Without it the plugin shows yesterday's cached quote, and then its built-in local lines. The quote cache file is a plain JSON document next to the task file.
- The completed history only contains tasks that are still stored locally: clearing the finished list (or sync merging a clear) removes them from the history and from later exports. Exported timestamps use this machine's local time.
- Cloud sync needs one writable JSON object/file; there is no multi-user sharing or access control beyond the storage account itself.

### License

[MIT](LICENSE)
