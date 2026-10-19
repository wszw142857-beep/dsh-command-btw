/**
 * @local/dsh-btw — the `/btw` side-question command.
 *
 * Claude Code's `/btw` lets you ask a quick "by the way" question about the
 * ongoing session while it works, and the answer never enters the conversation
 * history. DSH's command plane already gives us the "never enters model
 * history" half: a command runs directly against the agent, its lifecycle is
 * recorded as log-only `command/run` + `command/done` events, and its result
 * text is rendered outside model history.
 *
 * This plugin adds the other half: it reads the session's derived history
 * (the exact messages the model saw), asks the same provider/model route one
 * extra question with no tools, and returns the answer as the command result.
 */
export const name = 'btw'
export const inject = ['commands', 'llm', 'sessions']

/** Longest accepted side question, in characters. */
const MAX_QUESTION_CHARS = 4000
/** Transcript budget sent to the side call, in characters. Newest entries win. */
const MAX_TRANSCRIPT_CHARS = 96000
/** Output cap for the side answer. */
const MAX_ANSWER_TOKENS = 1200

const USAGE = '用法：/btw <问题>　例：/btw 现在这个项目的抓取流程是什么？'

const SYSTEM_PROMPT = [
  '你在回答一个“顺带一问”（/btw）：关于下面这场仍在进行中的会话，用户临时插入的问题。',
  '',
  '规则：',
  '1. 只依据给出的会话记录回答；记录里没有的信息就直说不知道，不要猜测。',
  '2. 你没有工具，不能调用工具、读取文件或执行命令。',
  '3. 回答简短、直接、可操作，通常 1-6 句；使用提问者的语言。',
  '4. 这段问答不会写入会话历史，也不会改变会话状态；不要提议“我会继续修改”之类的后续动作。',
  '',
  '# 会话记录（按时间顺序，可能已截断，越靠后越新）',
].join('\n')

/** Join the text blocks of a message's content array. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Render the session's derived history as a plain transcript.
 * Newest entries are kept first; the whole transcript respects `budget`.
 * Only text survives: images become a marker, tool calls become a name.
 */
function buildTranscript(messages, budget) {
  const entries = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text.trim()) entries.push({ role: 'user', text })
      continue
    }
    if (message.role === 'assistant') {
      const parts = []
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block && block.type === 'image') parts.push('[图片]')
        else if (block && block.type === 'tool-call' && typeof block.name === 'string') parts.push(`[调用工具 ${block.name}]`)
      }
      const text = parts.join('\n').trim()
      if (text) entries.push({ role: 'assistant', text })
      continue
    }
    if (message.role === 'tool') {
      const text = textOf(message.content).trim()
      if (!text) continue
      entries.push({ role: 'tool', text })
    }
  }

  const kept = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    let text = entry.text
    // A single oversized entry (e.g. a huge file dump) keeps its tail —
    // errors usually live at the end — so it cannot starve the whole budget.
    if (text.length > budget) text = `…[前段已截断，保留尾部 ${budget} 字符]\n${text.slice(-budget)}`
    const cost = text.length + 16
    if (kept.length > 0 && used + cost > budget) break
    kept.unshift({ role: entry.role, text })
    used += cost
  }
  return kept.map((entry) => `[${entry.role}]\n${entry.text}`).join('\n\n')
}

/** Resolve the provider/model route the session last used. */
function resolveRoute(ctx, session) {
  try {
    const header = session.requestHeader?.()
    const config = header && header.config
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') return config
  } catch {
    // A projection failure must not fail the command; fall through to defaults.
  }
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') return selection
  } catch {
    // No default-model service mounted.
  }
  return undefined
}

function failure(text) {
  return { kind: 'error', text }
}

async function executeBtw(ctx, invocation) {
  const question = String(invocation.rawInput ?? '').trim()
  if (!question) return failure(USAGE)
  if (question.length > MAX_QUESTION_CHARS) return failure(`问题过长（上限 ${MAX_QUESTION_CHARS} 字符）。`)
  if (invocation.signal && invocation.signal.aborted) return failure('已取消。')

  const session = ctx.sessions.get(invocation.agent.id)
  if (!session) return failure('/btw 找不到当前会话。')

  const route = resolveRoute(ctx, session)
  if (!route) return failure('/btw 无法确定当前会话的模型路由（会话尚未发起过模型请求，也没有默认模型）。')

  let messages
  try {
    messages = session.deriveMessages()
  } catch (error) {
    return failure(`/btw 读取会话历史失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const transcript = buildTranscript(messages, MAX_TRANSCRIPT_CHARS)
  if (!transcript) return failure('/btw 当前会话还没有可参考的对话内容。')

  const options = {
    provider: route.provider,
    model: route.model,
    system: `${SYSTEM_PROMPT}\n\n${transcript}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
    maxTokens: MAX_ANSWER_TOKENS,
  }
  if (typeof route.reasoningEffort === 'string' && route.reasoningEffort) {
    options.reasoningEffort = route.reasoningEffort
  }
  if (invocation.signal) options.signal = invocation.signal

  let answer = ''
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        answer += chunk.text
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason || {}
        if (reason.kind === 'error') {
          const message = reason.failure && reason.failure.message ? reason.failure.message : '未知错误'
          return failure(`模型调用失败：${message}`)
        }
        if (reason.kind === 'aborted') return failure('已取消。')
      }
    }
  } catch (error) {
    if (invocation.signal && invocation.signal.aborted) return failure('已取消。')
    return failure(`模型调用失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const text = answer.trim()
  if (!text) return failure('模型没有返回内容。')
  return { kind: 'success', text }
}

/**
 * Register `/btw` for every composed human-command adapter.
 * @param ctx - context carrying the command registry, the llm seam, and the session store.
 */
export function apply(ctx) {
  ctx.commands.register({
    name: 'btw',
    description: '顺带问一句：针对当前会话临时提问，问答不进入对话历史',
    input: { hint: '<问题>' },
    handler: (invocation) => executeBtw(ctx, invocation),
  })
}
