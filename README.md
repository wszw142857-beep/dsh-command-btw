# `/btw` side questions for DSH

[中文](#中文) | [English](#english)

## 中文

Claude Code 的 `/btw` 让你在会话运行期间随时提一个快速问题，且这段问答不会进入会话历史。这个 bundle 把同样的行为带到了 DSH。

### 它做什么

在输入框输入 `/btw <问题>`：

1. 读取接收会话的派生历史（`session.deriveMessages()`），即模型自己看到的那些消息；
2. 用会话当前的 provider/model 路由额外问一个问题，以上述转录为上下文，**不带任何工具**；
3. 答案作为命令结果返回，渲染在聊天记录中。

问题和答案只记录为仅日志的 `command/run` 和 `command/done` 事件，不会追加到模型可见的界面上，因此下一次模型请求不包含它们。

### 用法

```text
/btw 现在这个项目的抓取流程是什么？
/btw What did we change in the parser so far?
```

智能体运行中也可以提问。空输入会打印用法说明。

### 限制

- 旁路调用使用会话最近一次 `request/header` 的路由；尚未发过模型请求的会话回落到 `agentDefaultModel`。
- 转录上限 24,000 字符（优先保留最新消息），每条工具结果截断到 400 字符，答案上限 1,200 tokens。
- 图片被替换为 `[图片]`；工具结果以文本形式呈现。
- 旁路调用不触发 `agent/request`，因此不计入 token 统计，也不出现在请求头里。

### 文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件：注册 `/btw`，构建转录，流式返回旁路答案 |
| `cordis.patch.yml` | bundle patch，插入 `btw` 行 |
| `locale/{en,zh}.json` | 插件管理器中的标题与描述 |
| `icon.svg` | 插件图标 |
| `test/btw.test.mjs` | Fake-context 单元测试（无需 DSH） |

### 开发

```bash
node test/btw.test.mjs
```

用 `plugin_manager install_bundle` 指向本目录安装；bundle 是纯 ESM 包，无构建步骤，不 import 任何 `@deepseek-ai/*`（这些包在 `app.asar` 内，profile 插件无法解析）。

## English

Claude Code's `/btw` lets you ask a quick question about the ongoing session
while it works, and the exchange never enters the conversation history. This
bundle brings the same behavior to DSH.

### What it does

Typing `/btw <question>` in the composer:

1. reads the receiving session's derived history (`session.deriveMessages()`),
   i.e. exactly the messages the model itself saw;
2. asks the session's current provider/model route one extra question with a
   transcript as context and **no tools**;
3. returns the answer as the command result, rendered in the chat transcript.

The question and answer are recorded only as log-only `command/run` and
`command/done` events. They are not appended to the model-visible surface, so
the next model request does not contain them.

### Usage

```text
/btw 现在这个项目的抓取流程是什么？
/btw What did we change in the parser so far?
```

A question may be asked while the agent is running. Empty input prints usage.

### Limits

- The side call uses the route of the session's latest `request/header`; a
  session with no model request yet falls back to `agentDefaultModel`.
- The transcript is capped at 24,000 characters (newest messages win), each
  tool result is capped at 400 characters, and the answer at 1,200 tokens.
- Images are replaced by `[图片]`; tool results are represented as text.
- The side call does not fire `agent/request`, so it does not appear in token
  accounting or request headers.

### Files

| File | Role |
|---|---|
| `index.js` | Host plugin: registers `/btw`, builds the transcript, streams the side answer |
| `cordis.patch.yml` | Bundle patch inserting the `btw` row |
| `locale/{en,zh}.json` | Plugin Manager title and description |
| `icon.svg` | Plugin icon |
| `test/btw.test.mjs` | Fake-context unit tests (no DSH needed) |

### Development

```bash
node test/btw.test.mjs
```

Install with `plugin_manager install_bundle` pointing at this directory; the
bundle is a plain ESM package with no build step and no imports from
`@deepseek-ai/*` (those packages live inside `app.asar` and do not resolve for
profile plugins).
