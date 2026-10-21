# `/btw` side questions for DSH

[中文](#中文) | [English](#english)

---

## 中文

Claude Code 的 `/btw` 让你在会话运行期间随时提一个快速问题，且这段问答不会进入会话历史。这个 bundle 把同样的行为带到了 DSH，并附带一个浮动答案面板。

### 它做什么

在输入框输入 `/btw <问题>`：

1. 命令**立即返回**——输入框马上清空，不会一直挂着这行命令等模型回答；
2. 读取会话的派生历史（`session.deriveMessages()`），即模型自己看到的那些消息；
3. 用会话当前的 provider/model 路由额外问一个问题，以上述转录为上下文，**不带任何工具**；
4. 答案流式写入输入框上方的浮动面板。

问题和答案只记录为仅日志的 `command/run` 和 `command/done` 事件，不会追加到模型可见的界面上，因此下一次模型请求不包含它们。

### 浮动面板

| 能力 | 行为 |
|---|---|
| 流式 | 文字逐步出现；标题从 `正在思考…` 变为 `正在输出…` |
| 停止 | 「停止」中止当前调用；已产出的文字保留并附 `（已取消）` |
| 历史 | `‹ n/m ›` 与 `←`/`→` 翻看**本会话**之前的问答 |
| 问题 | 每条答案上方以灰斜体显示当时的问题 |
| 选中 | 面板内文字可自由拖选；「复制」可一键复制整条答案 |
| 追问 | 面板底部输入框可直接发下一个 `/btw`，不必回到输入框（追问会自己轮询，不会卡在“正在思考”） |
| 选区提问 | 面板打开时若页面上有选中文本，会自动附带到追问中（chip 显示字数，点击可移除） |
| 拖动 | 按住标题栏可把面板拖到任意位置；窗口缩放时自动夹回视口内 |
| 定位 | 固定在视口上方居中，不随聊天滚动或输入框伸缩而移动 |
| 关闭 | 点 ✕ 关闭；Esc 仅在焦点位于面板内时关闭，**不会抢走** DSH 打断 agent 的 Esc |
| 持久化 | 槽位镜像到 `$DSH_HOME/data/dsh-btw/<session>.json`；写入防抖、每周清理 |
| 隔离 | 每个会话独立的槽位，切换会话不会串台 |

### 配置

在 **插件 → BTW 临时提问 → 配置** 中可调：

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | 空 | 路由覆盖，需与 `model` 同时填写；留空则跟随当前会话 |
| `model` | 空 | 路由覆盖，需与 `provider` 同时填写 |
| `maxAnswerTokens` | 1200 | 答案输出上限 |
| `transcriptChars` | 96000 | 转录预算（最新的优先保留） |
| `includeReasoning` | false | 是否把模型的推理过程放进转录 |
| `reasoningChars` | 500 | 开启推理时每条保留的字符数 |
| `toolArgumentChars` | 120 | 工具调用参数片段；`0` 表示不显示 |

同时填写 `provider` + `model` 可以让 `/btw` 使用比主对话更便宜/更快的模型。

### 限制

- 转录有上限（默认 96,000 字符，最新的优先）；单条超预算的内容保留**尾部**（报错通常在末尾）。
- 图片替换为 `[图片]`；工具结果以文本形式呈现。
- 旁路调用不触发 `agent/request`，因此不计入 token 统计，也不出现在请求头里。
- 聊天记录里保留一行中性指针（`已提交侧问：…`）作为归档；答案本体在面板中。
- 面板固定定位在视口上方；若被拖到别处，重启后会回到默认位置。

### 安装

```bash
dsh plugin --profile web add dsh-command-btw
```

或从 GitHub 安装：`dsh plugin --profile web add github:wszw142857-beep/dsh-command-btw`

本包依赖 `@deepseek-ai/schemastery` 以激活 Config schema；能解析该包的 profile 通常已自带。

### 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册 `/btw`、构建转录、流式侧调、维护槽位与 `/btw/answer` 路由 |
| `client.js` | Client 半边：浮动面板、轮询、翻页、复制、追问输入 |
| `cordis.patch.yml` | bundle patch，插入 `btw` 行 |
| `locale/{en,zh}.json` | 插件管理器中的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/btw.test.mjs` | fake-ctx 单测（24 项，无需 DSH） |

### 开发

```bash
node test/btw.test.mjs
```

以 `link:` 方式开发时，插件旁边需要有可解析的 `@deepseek-ai/schemastery`（指向 profile 内副本的 junction 即可）；npm 安装会作为真实依赖自动装上。

---

## English

Claude Code's `/btw` lets you ask a quick question about the ongoing session while it works, and the exchange never enters the conversation history. This bundle brings the same behavior to DSH, with a floating answer panel.

### What it does

Typing `/btw <question>` in the composer:

1. settles the command **immediately**, so the composer clears the draft at once instead of holding the line until the model answers;
2. reads the session's derived history (`session.deriveMessages()`) — exactly the messages the model itself saw;
3. asks the session's provider/model route one extra question with that transcript as context and **no tools**;
4. streams the answer into a floating panel above the composer.

The question and answer are recorded only as log-only `command/run` and `command/done` events. They never enter the model-visible surface, so the next model request does not contain them.

### The panel

| Feature | Behavior |
|---|---|
| Streaming | Text appears as it is generated; the title reads `正在思考…` → `正在输出…` |
| Cancel | 「停止」 aborts the live call; produced text stays with a `（已取消）` note |
| History | `‹ n/m ›` and `←`/`→` page through this session's earlier answers |
| Question | Shown above each answer in italic grey |
| Selection | Text in the panel is freely selectable; 「复制」 copies one answer |
| Follow-up | The bottom input sends another `/btw` without returning to the composer; it starts its own poll, so it never sticks on `正在思考…` |
| Selection-scoped ask | A page selection captured when the panel opens is attached to the follow-up (chip shows its size, click to drop) |
| Dragging | Drag the title bar to move the panel anywhere; it clamps back into the viewport on resize |
| Placement | Fixed above the viewport centre, so chat scrolling or a shrinking composer never moves it |
| Close | ✕ closes it; Escape closes only while focus is inside the panel and never steals DSH's agent-interrupt key |
| Persistence | Slots are mirrored to `$DSH_HOME/data/dsh-btw/<session>.json`; debounced writes, weekly sweep |
| Isolation | Each session has its own slot; switching sessions never shows another session's answers |

### Configuration

The plugin exposes these fields in **Plugins → BTW 临时提问 → 配置**:

| Field | Default | Meaning |
|---|---|---|
| `provider` | empty | Route override; requires `model`. Empty follows the session |
| `model` | empty | Route override; requires `provider` |
| `maxAnswerTokens` | 1200 | Answer output cap |
| `transcriptChars` | 96000 | Transcript budget (newest entries win) |
| `includeReasoning` | false | Include the model's reasoning blocks in the transcript |
| `reasoningChars` | 500 | Reasoning excerpt length when enabled |
| `toolArgumentChars` | 120 | Tool-call argument snippet; `0` disables |

Setting `provider` + `model` lets `/btw` use a cheaper/faster route than the main conversation.

### Limits

- The transcript is capped (default 96k chars, newest first); a single oversized entry keeps its **tail**, where errors usually live.
- Images become `[图片]`; tool results are plain text.
- The side call fires no `agent/request`, so it stays out of token accounting and request headers.
- The chat transcript keeps a one-line pointer (`已提交侧问：…`) as the durable archive; the answer itself lives in the panel.

### Install

```bash
dsh plugin --profile web add dsh-command-btw
```

Or from GitHub: `dsh plugin --profile web add github:wszw142857-beep/dsh-command-btw`.

The package depends on `@deepseek-ai/schemastery` so its Config schema activates; a profile that resolves that package already has it.

### Changelog (recent)

| Version | Change |
|---|---|
| 0.9.0 | Follow-up no longer stalls (own poll); pager clamps when history grows; panel is fixed + draggable; Escape no longer steals the agent-interrupt key |
| 0.8.0 | Debounced persistence + weekly disk sweep; schemastery Config (route/limits/reasoning); neutral transcript pointer |
| 0.7.0 | Config (provider/model override), selection-scoped questions, reasoning-aware transcript |
| 0.6.0 | Streaming, cancel, inline follow-up input |

### Files

| File | Role |
|---|---|
| `index.js` | Host half: registers `/btw`, builds the transcript, streams the side call, owns slots + the `/btw/answer` route |
| `client.js` | Client half: the floating panel, polling, paging, copy, follow-up input |
| `cordis.patch.yml` | Bundle patch inserting the `btw` row |
| `locale/{en,zh}.json` | Plugin Manager title and description |
| `icon.svg` | Plugin icon |
| `test/btw.test.mjs` | Fake-context unit tests (24 cases, no DSH needed) |

### Development

```bash
node test/btw.test.mjs
```

A `link:` development copy needs a resolvable `@deepseek-ai/schemastery` next to it (a junction to the profile's copy works); an npm install gets it as a real dependency.
