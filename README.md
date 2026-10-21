# `/btw` side questions for DSH

Claude Code's `/btw` lets you ask a quick question about the ongoing session
while it works, and the exchange never enters the conversation history. This
bundle brings the same behavior to DSH, with a floating answer panel.

## What it does

Typing `/btw <question>` in the composer:

1. settles the command **immediately**, so the composer clears the draft at
   once instead of holding the line until the model answers;
2. reads the session's derived history (`session.deriveMessages()`) — exactly
   the messages the model itself saw;
3. asks the session's provider/model route one extra question with that
   transcript as context and **no tools**;
4. streams the answer into a floating panel above the composer.

The question and answer are recorded only as log-only `command/run` and
`command/done` events. They never enter the model-visible surface, so the next
model request does not contain them.

## The panel

| Feature | Behavior |
|---|---|
| Streaming | Text appears as it is generated; the title reads `正在思考…` → `正在输出…` |
| Cancel | 「停止」aborts the live call; produced text stays with a `（已取消）` note |
| History | `‹ n/m ›` and `←`/`→` page through this session's earlier answers |
| Question | Shown above each answer in italic grey |
| Selection | Text in the panel is freely selectable; 「复制」 copies one answer |
| Follow-up | The bottom input sends another `/btw` without returning to the composer |
| Selection-scoped ask | A page selection captured when the panel opens is attached to the follow-up (chip shows its size, click to drop) |
| Persistence | Slots are mirrored to `$DSH_HOME/data/dsh-btw/<session>.json`; debounced writes, weekly sweep |
| Isolation | Each session has its own slot; switching sessions never shows another session's answers |

## Configuration

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

Setting `provider` + `model` lets `/btw` use a cheaper/faster route than the
main conversation.

## Limits

- The transcript is capped (default 96k chars, newest first); a single oversized
  entry keeps its **tail**, where errors usually live.
- Images become `[图片]`; tool results are plain text.
- The side call fires no `agent/request`, so it stays out of token accounting
  and request headers.
- The chat transcript keeps a one-line pointer (`已提交侧问：…`) as the durable
  archive; the answer itself lives in the panel.

## Install

```bash
dsh plugin --profile <name> add dsh-command-btw
```

Or from GitHub: `dsh plugin --profile <name> add github:wszw142857-beep/dsh-command-btw`.

The package depends on `@deepseek-ai/schemastery` so its Config schema
activates; a profile that resolves that package already has it.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: registers `/btw`, builds the transcript, streams the side call, owns slots + the `/btw/answer` route |
| `client.js` | Client half: the floating panel, polling, paging, copy, follow-up input |
| `cordis.patch.yml` | Bundle patch inserting the `btw` row |
| `locale/{en,zh}.json` | Plugin Manager title and description |
| `icon.svg` | Plugin icon |
| `test/btw.test.mjs` | Fake-context unit tests (24 cases, no DSH needed) |

## Development

```bash
node test/btw.test.mjs
```

A `link:` development copy needs a resolvable `@deepseek-ai/schemastery` next to
it (a junction to the profile's copy works); an npm install gets it as a real
dependency.
