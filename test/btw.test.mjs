import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

const SIGNAL = new AbortController().signal

function makeCtx({ session, selection, chunks, throws } = {}) {
  const registrations = []
  const calls = []
  const ctx = {
    commands: {
      register(definition) {
        registrations.push(definition)
        return () => {}
      },
    },
    sessions: {
      get(id) {
        return session && session.id === id ? session : undefined
      },
    },
    llm: {
      stream(options) {
        calls.push(options)
        return (async function* () {
          if (throws) throw throws
          for (const chunk of chunks) yield chunk
        })()
      },
    },
    get(service) {
      if (service === 'agentDefaultModel' && selection) return { currentSelection: () => selection }
      return undefined
    },
  }
  apply(ctx)
  assert.equal(registrations.length, 1, 'registers exactly one command')
  return { def: registrations[0], calls }
}

function successChunks(parts) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...parts.map((text) => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: parts.join('') } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function makeSession({ id = 'session-1', header = { config: { provider: 'deepseek', model: 'deepseek-chat' } }, messages = [] } = {}) {
  return {
    id,
    requestHeader: () => header,
    deriveMessages: () => messages,
  }
}

const invocation = (rawInput, extra = {}) => ({
  commandId: 'cmd-1',
  agent: { id: 'session-1' },
  rawInput,
  attachments: [],
  signal: SIGNAL,
  ...extra,
})

const HISTORY = [
  { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT — must be skipped' }] },
  { role: 'user', content: [{ type: 'text', text: '帮我看看抓取流程' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我先看抓取脚本。' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    ],
  },
  { role: 'tool', content: [{ type: 'text', text: 'src/fetch.ts\nsrc/parse.ts' }], toolCallId: 'c1' },
]

let passed = 0
function test(label, fn) {
  return (async () => {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${label}`)
  })()
}

await test('plugin identity', () => {
  assert.equal(name, 'btw')
  assert.deepEqual(inject, ['commands', 'llm', 'sessions'])
})

await test('empty question returns usage', async () => {
  const { def } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['nope']),
  })
  const result = await def.handler(invocation('   '))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

await test('happy path streams the answer and keeps history out of the request', async () => {
  const { def, calls } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['抓取流程是 ', '先 fetch 再 parse。']),
  })
  const result = await def.handler(invocation('抓取流程是什么？'))
  assert.deepEqual(result, { kind: 'success', text: '抓取流程是 先 fetch 再 parse。' })
  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-chat')
  assert.equal(options.maxTokens, 1200)
  assert.deepEqual(options.messages, [
    { role: 'user', content: [{ type: 'text', text: '抓取流程是什么？' }] },
  ])
  assert.match(options.system, /会话记录/)
  assert.match(options.system, /\[user\]\n帮我看看抓取流程/)
  assert.match(options.system, /\[assistant\]\n我先看抓取脚本。\n\[调用工具 bash\]/)
  assert.match(options.system, /\[tool\]\nsrc\/fetch.ts/)
  assert.doesNotMatch(options.system, /SYSTEM PROMPT/)
})

await test('falls back to the default model when the session has no request header', async () => {
  const { def, calls } = makeCtx({
    session: makeSession({ header: null, messages: HISTORY }),
    selection: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    chunks: successChunks(['ok']),
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'success')
  assert.equal(calls[0].model, 'deepseek-reasoner')
  assert.equal(calls[0].reasoningEffort, 'high')
})

await test('rejects when no route and no default model exist', async () => {
  const { def } = makeCtx({
    session: makeSession({ header: null, messages: HISTORY }),
    chunks: successChunks(['ok']),
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无法确定当前会话的模型路由/)
})

await test('rejects an unknown session', async () => {
  const { def } = makeCtx({ session: undefined, chunks: successChunks(['ok']) })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /找不到当前会话/)
})

await test('rejects an empty session', async () => {
  const { def } = makeCtx({ session: makeSession({ messages: [] }), chunks: successChunks(['ok']) })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /还没有可参考的对话内容/)
})

await test('surfaces a model error finish', async () => {
  const { def } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } }],
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /rate limited/)
})

await test('surfaces a thrown stream error', async () => {
  const { def } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    throws: new Error('socket closed'),
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /socket closed/)
})

await test('reports an empty answer', async () => {
  const { def } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: [{ type: 'finish', reason: { kind: 'stop' } }],
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有返回内容/)
})

await test('keeps only the newest transcript within budget', async () => {
  const messages = []
  for (let index = 0; index < 200; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `message-${index} ${'x'.repeat(300)}` }] })
  }
  const { def, calls } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
  })
  const result = await def.handler(invocation('hi'))
  assert.equal(result.kind, 'success')
  const system = calls[0].system
  assert.ok(system.length < 24000 + 2000, `transcript too long: ${system.length}`)
  assert.match(system, /message-199/)
  assert.doesNotMatch(system, /message-0 /)
})

const rejected = new AbortController()
rejected.abort()
await test('reports cancellation before dispatch', async () => {
  const { def } = makeCtx({ session: makeSession({ messages: HISTORY }), chunks: successChunks(['ok']) })
  const result = await def.handler(invocation('hi', { signal: rejected.signal }))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /已取消/)
})

console.log(`\n${passed} tests passed`)
