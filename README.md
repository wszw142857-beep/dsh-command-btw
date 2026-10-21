# `/btw` side questions for DSH

Claude Code's `/btw` lets you ask a quick question about the ongoing session
while it works, and the exchange never enters the conversation history. This
bundle brings the same behavior to DSH.

## What it does

Typing `/btw <question>` in the composer:

1. reads the receiving session's derived history (`session.deriveMessages()`),
   i.e. exactly the messages the model itself saw;
2. asks the session's current provider/model route one extra question with a
   transcript as context and **no tools**;
3. returns the answer as the command result, rendered in the chat transcript.

The question and answer are recorded only as log-only `command/run` and
`command/done` events. They are not appended to the model-visible surface, so
the next model request does not contain them.

## Usage

```text
/btw 现在这个项目的抓取流程是什么？
/btw What did we change in the parser so far?
```

A question may be asked while the agent is running. Empty input prints usage.

## Limits

- The side call uses the route of the session's latest `request/header`; a
  session with no model request yet falls back to `agentDefaultModel`.
- The transcript is capped at 24,000 characters (newest messages win), each
  tool result is capped at 400 characters, and the answer at 1,200 tokens.
- Images are replaced by `[图片]`; tool results are represented as text.
- The side call does not fire `agent/request`, so it does not appear in token
  accounting or request headers.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin: registers `/btw`, builds the transcript, streams the side answer |
| `cordis.patch.yml` | Bundle patch inserting the `btw` row |
| `locale/{en,zh}.json` | Plugin Manager title and description |
| `icon.svg` | Plugin icon |
| `test/btw.test.mjs` | Fake-context unit tests (no DSH needed) |

## Development

```bash
node test/btw.test.mjs
```

Install with `plugin_manager install_bundle` pointing at this directory; the
bundle is a plain ESM package with no build step and no imports from
`@deepseek-ai/*` (those packages live inside `app.asar` and do not resolve for
profile plugins).
