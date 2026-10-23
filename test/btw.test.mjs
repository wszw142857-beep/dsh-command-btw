import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

const SIGNAL = new AbortController().signal

/** Capture the `/btw/answer` route handler so tests can read the slot. */
function makeCtx({ session, selection, chunks, chunkSets, throws, hanging, gateAfter, gate, config } = {}) {
  const registrations = []
  const calls = []
  const routes = []
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
        const index = calls.length
        calls.push(options)
        // `chunkSets` gives each successive stream its own chunks, so a test can
        // ask twice and get two different answers.
        const chunks2 = chunkSets ? chunkSets[Math.min(index, chunkSets.length - 1)] : chunks
        return (async function* () {
          if (throws) throw throws
          if (hanging) {
            await new Promise((_, reject) => {
              const signal = options.signal
              if (signal) {
                if (signal.aborted) reject(new Error('aborted'))
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              }
            })
            return
          }
          let index = 0
          for (const chunk of chunks2) {
            if (gateAfter !== undefined && gate !== undefined && index === gateAfter) {
              await gate
            }
            yield chunk
            index += 1
          }
        })()
      },
    },
    get(service) {
      if (service === 'agentDefaultModel' && selection) return { currentSelection: () => selection }
      if (service === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('webServer')) {
        callback({ webServer: ctx.get('webServer'), effect: (fn) => fn() })
      }
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx, config)
  assert.equal(registrations.length, 1, 'registers exactly one command')
  assert.equal(routes.length, 1, 'registers exactly one answer route')
  return { def: registrations[0], calls, route: routes[0] }
}

/** Read the current slot through the real route handler. */
async function readSlot(route, sessionId = 'session-1') {
  let body = ''
  const res = {
    writeHead() {},
    end(chunk) {
      body = chunk
    },
  }
  await route.handler({ url: `/btw/answer?session=${sessionId}` }, res)
  return JSON.parse(body)
}

async function waitFor(route, predicate, timeoutMs = 2000, sessionId = 'session-1') {
  const started = Date.now()
  for (;;) {
    const slot = await readSlot(route, sessionId)
    if (predicate(slot)) return slot
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for slot: ${JSON.stringify(slot)}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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

await test('empty question returns usage synchronously', async () => {
  const { def } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['nope']),
  })
  const result = await def.handler(invocation('   '))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

await test('handler returns immediately and the answer arrives through the route', async () => {
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['抓取流程是 ', '先 fetch 再 parse。']),
  })
  const result = await def.handler(invocation('抓取流程是什么？'))
  // Immediate settle: this is what lets the composer clear the draft. The
  // transcript card carries a neutral pointer; the answer renders in the panel.
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已提交侧问/)
  assert.match(result.text, /抓取流程是什么？/)

  const slot = await waitFor(route, (value) => value.status === 'done')
  assert.equal(slot.text, '抓取流程是 先 fetch 再 parse。')

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

await test('exposes a pending slot before the model answers', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: [],
    hanging: true,
  })
  await def.handler(invocation('慢问题'))
  const pending = await readSlot(route)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.question, '慢问题')
})

await test('falls back to the default model when the session has no request header', async () => {
  const { def, calls, route } = makeCtx({
    session: makeSession({ header: null, messages: HISTORY }),
    selection: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'done')
  assert.equal(slot.status, 'done')
  assert.equal(calls[0].model, 'deepseek-reasoner')
  assert.equal(calls[0].reasoningEffort, 'high')
})

await test('reports a missing route as an error slot', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ header: null, messages: HISTORY }),
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /无法确定当前会话的模型路由/)
})

await test('reports an unknown session as an error slot', async () => {
  const { def, route } = makeCtx({ session: undefined, chunks: successChunks(['ok']) })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /找不到当前会话/)
})

await test('reports an empty session as an error slot', async () => {
  const { def, route } = makeCtx({ session: makeSession({ messages: [] }), chunks: successChunks(['ok']) })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /还没有可参考的对话内容/)
})

await test('surfaces a model error finish', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } }],
  })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /rate limited/)
})

await test('surfaces a thrown stream error', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    throws: new Error('socket closed'),
  })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /socket closed/)
})

await test('reports an empty answer', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: [{ type: 'finish', reason: { kind: 'stop' } }],
  })
  await def.handler(invocation('hi'))
  const slot = await waitFor(route, (value) => value.status === 'error')
  assert.match(slot.text, /没有返回内容/)
})

await test('keeps only the newest transcript within budget', async () => {
  const messages = []
  for (let index = 0; index < 400; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `message-${index} ${'x'.repeat(300)}` }] })
  }
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  await waitFor(route, (value) => value.status === 'done')
  const system = calls[0].system
  assert.ok(system.length < 96000 + 2000, `transcript too long: ${system.length}`)
  assert.match(system, /message-399/)
  assert.doesNotMatch(system, /message-0 /)
})

await test('tool results are kept in full and an oversized single entry keeps its tail', async () => {
  const big = 'head-' + 'y'.repeat(200000) + '-TAIL-MARKER'
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'tool', content: [{ type: 'text', text: big }] },
  ]
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  await waitFor(route, (value) => value.status === 'done')
  const system = calls[0].system
  assert.match(system, /TAIL-MARKER/)
  assert.ok(system.length < 96000 + 2000, `oversized entry not clipped: ${system.length}`)
})

await test('a normal-size tool result passes through untruncated', async () => {
  const medium = 'R'.repeat(5000)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'tool', content: [{ type: 'text', text: medium }] },
  ]
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  await waitFor(route, (value) => value.status === 'done')
  assert.match(calls[0].system, new RegExp(medium))
})

const rejected = new AbortController()
rejected.abort()
await test('reports cancellation before dispatch', async () => {
  const { def } = makeCtx({ session: makeSession({ messages: HISTORY }), chunks: successChunks(['ok']) })
  const result = await def.handler(invocation('hi', { signal: rejected.signal }))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /已取消/)
})

await test('carries the question in the slot so the panel can show it', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['答案一']),
  })
  await def.handler(invocation('第一个问题'))
  const slot = await waitFor(route, (value) => value.status === 'done')
  assert.equal(slot.question, '第一个问题')
  assert.equal(slot.text, '答案一')
})

await test('accumulates per-session history across questions', async () => {
  const sessionId = `history-${Math.random().toString(36).slice(2, 8)}`
  const { def, route } = makeCtx({
    session: makeSession({ id: sessionId, messages: HISTORY }),
    // Each stream gets its own answer so the two turns are distinguishable.
    chunkSets: [successChunks(['答案一']), successChunks(['答案二'])],
  })
  const ask = (text) => def.handler({ ...invocation(text), agent: { id: sessionId } })
  await ask('问题一')
  await waitFor(route, (value) => value.status === 'done' && value.text === '答案一', 2000, sessionId)

  // Second question on the same session must mint a NEW id and append history.
  await ask('问题二')
  const slot = await waitFor(route, (value) => value.status === 'done' && value.text === '答案二', 2000, sessionId)
  assert.equal(slot.question, '问题二')
  assert.ok(Array.isArray(slot.history))
  assert.equal(slot.history.length, 2, `history: ${JSON.stringify(slot.history)}`)
  assert.equal(slot.history[0].question, '问题一')
  assert.equal(slot.history[0].text, '答案一')
  assert.equal(slot.history[1].question, '问题二')
  assert.equal(slot.history[1].text, '答案二')
  assert.notEqual(slot.history[0].id, slot.history[1].id, 'each settled turn needs its own id')
})

await test('keeps sessions isolated from each other', async () => {
  const first = makeCtx({
    session: makeSession({ id: 'session-1', messages: HISTORY }),
    chunks: successChunks(['答案一']),
  })
  await first.def.handler({ ...invocation('问题一'), agent: { id: 'session-1' } })
  await waitFor(first.route, (value) => value.status === 'done')

  // A different session on the same plugin instance has its own slot.
  const other = await readSlot(first.route, 'session-2')
  assert.equal(other.status, 'idle')
})

await test('streams partial text into the slot while the model is producing it', async () => {
  let releaseSecond
  const gate = new Promise((resolve) => {
    releaseSecond = resolve
  })
  const chunks = [
    { type: 'text-delta', index: 0, text: '第一段' },
    { type: 'text-delta', index: 0, text: '第二段' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks,
    gateAfter: 1,
    gate,
  })
  await def.handler(invocation('流式问题'))
  const streaming = await waitFor(route, (value) => value.status === 'streaming' || value.status === 'done')
  assert.ok(streaming.text.length > 0, `expected partial text, got ${JSON.stringify(streaming)}`)
  releaseSecond()
  const done = await waitFor(route, (value) => value.status === 'done')
  assert.equal(done.text, '第一段第二段')
})

await test('cancels a live call through the cancel route', async () => {
  const { def, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['never']),
    hanging: true,
  })
  await def.handler(invocation('要取消的问题'))
  // Wait for the pending slot, then ask the route to cancel.
  await waitFor(route, (value) => value.status === 'pending')
  let body = ''
  await route.handler({ url: '/btw/answer?session=session-1&cancel=1' }, {
    writeHead() {},
    end(chunk) { body = chunk },
  })
  assert.equal(JSON.parse(body).cancelled, true)
})

await test('honors a provider/model override from Config', async () => {
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages: HISTORY }),
    chunks: successChunks(['ok']),
    config: { provider: 'cheap-provider', model: 'cheap-model', maxAnswerTokens: 256 },
  })
  await def.handler(invocation('hi'))
  await waitFor(route, (value) => value.status === 'done')
  assert.equal(calls[0].provider, 'cheap-provider')
  assert.equal(calls[0].model, 'cheap-model')
  assert.equal(calls[0].maxTokens, 256)
})

await test('includes reasoning and tool arguments when configured', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '看看哪里卡住' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '我怀疑是路径不对。' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls src"}' },
      ],
    },
  ]
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
    config: { includeReasoning: true, reasoningChars: 100, toolArgumentChars: 50 },
  })
  await def.handler(invocation('卡在哪'))
  await waitFor(route, (value) => value.status === 'done')
  const system = calls[0].system
  assert.match(system, /\[思考\] 我怀疑是路径不对。/)
  assert.match(system, /\[调用工具 bash\] \{"command":"ls src"\}/)
})

await test('omits reasoning by default', async () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'reasoning', text: '秘密推理' }, { type: 'text', text: '结论' }] },
  ]
  const { def, calls, route } = makeCtx({
    session: makeSession({ messages }),
    chunks: successChunks(['ok']),
  })
  await def.handler(invocation('hi'))
  await waitFor(route, (value) => value.status === 'done')
  assert.doesNotMatch(calls[0].system, /秘密推理/)
  assert.match(calls[0].system, /结论/)
})

await test('streaming writes land in memory but debounce on disk', async () => {
  const sessionId = `debounce-${Math.random().toString(36).slice(2, 8)}`
  const { def, route } = makeCtx({
    session: makeSession({ id: sessionId, messages: HISTORY }),
    chunks: successChunks(['答案一']),
  })
  await def.handler({ ...invocation('hi'), agent: { id: sessionId } })
  const done = await waitFor(route, (value) => value.status === 'done', 2000, sessionId)
  assert.equal(done.text, '答案一')
  // The debounced writer must still persist the settled state eventually.
  // The plugin resolves its store through DSH_HOME, falling back to the user home.
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs/promises')
  const home = process.env.DSH_HOME || os.homedir()
  const root = path.join(home, 'data', 'dsh-btw')
  const file = path.join(root, `${sessionId}.json`)
  let persisted = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      persisted = JSON.parse(await fs.readFile(file, 'utf8'))
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  assert.ok(persisted, 'slot file should be written')
  assert.equal(persisted.text, '答案一')
})

console.log(`\n${passed} tests passed`)
