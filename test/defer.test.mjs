/**
 * dsh-recall · 挂起与补写的回归测试。
 *
 * 跑法：node test/defer.test.mjs
 *
 * 覆盖三件事：
 *   1. 回合已经结束（没有打开的 step）时撤回 → 只挂起，日志一个字都不写；
 *   2. 下一次 step/start 到来 → 墓碑补写在这一步里，遮蔽范围沿用原计划；
 *   3. 冷会话（日志停在回合边界）撤回 → 明确拒绝，不写坏日志。
 */
import assert from 'node:assert/strict'

const plugin = await import('../index.js')

/* ──────────────────────────── 假宿主 ──────────────────────────── */

function makeSession(id, events) {
  const session = {
    id,
    header: { id, cwd: 'C:\\work' },
    events,
    snapshotEvents() { return [...events] },
    append(type, data, options) {
      events.push({
        type,
        seq: events.length,
        time: Date.now(),
        data,
        ...(options?.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
        ...(options?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      })
    },
  }
  return session
}

function makeCtx(session, listeners) {
  return {
    webServer: { register: (route) => { listeners.route = route; return () => {} } },
    connection: { requestRejection: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    on: (name, fn) => { listeners[name] = fn; return () => {} },
    get: () => undefined,
    sessions: {
      get: (id) => (id === session.id ? session : undefined),
      flush: async () => true,
    },
    agents: { get: () => undefined },
    sessionPersistence: {
      stat: async () => ({}),
      open: async () => ({
        header: { cwd: 'C:\\work' },
        read: async () => ({ events: [...session.events] }),
        append: async (rows) => { session.events.push(...rows) },
        flush: async () => {},
        close: async () => {},
      }),
    },
  }
}

async function rpc(listeners, endpoint, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    url: '/dsh-recall/' + endpoint,
    headers: {},
    async *[Symbol.asyncIterator]() { yield body },
  }
  const res = {
    status: 0,
    text: '',
    writeHead(status) { this.status = status },
    end(text) { this.text = text },
  }
  await listeners.route.handler(req, res)
  return JSON.parse(res.text)
}

/* ──────────────────────────── 基线日志 ──────────────────────────── */

function baseEvents(sessionId) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 2, time: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system' }] } } },
    { type: 'user/message', seq: 3, time: 4, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '在' }] } } },
  ]
}

/** 最小结构校验：seq 稠密、表层可重放、system/message 落在打开的 step 里。 */
function assertLogIsReadable(events) {
  const nodes = []
  let turn = null
  let step = null
  events.forEach((event, index) => {
    assert.equal(event.seq, index, 'seq 必须稠密')
    if (event.type === 'turn/start') { turn = event.data.turn; step = null }
    else if (event.type === 'turn/end') { turn = null; step = null }
    else if (event.type === 'step/start') step = event.data.step
    else if (event.type === 'step/end') step = null
    else if (event.type === 'system/message') {
      assert.notEqual(turn, null, 'system/message 不能落在回合之外')
      assert.notEqual(step, null, 'system/message 不能落在 step 之外')
      assert.equal(event.data.turn, turn, 'system/message turn 必须是打开的那一轮')
      assert.equal(event.data.step, step, 'system/message step 必须是打开的那一步')
    }
    const op = event.surfaceOp
    if (op === undefined) return
    if (op === 'append') { nodes.push(event.seq); return }
    const start = nodes.indexOf(op.startSeq)
    const end = nodes.indexOf(op.endSeq)
    assert.ok(start >= 0 && end >= start, 'surface replace 必须落在当前表层上')
    nodes.splice(start, end - start + 1, event.seq)
  })
  return nodes
}

/* ──────────────────────────── 用例 ──────────────────────────── */

// 1 + 2：回合结束后的撤回先挂起，下一次 step/start 再补写
{
  const sessionId = 's-defer'
  const events = [...baseEvents(sessionId), { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } }, { type: 'turn/end', seq: 6, time: 7, data: { turn: 1 } }]
  const session = makeSession(sessionId, events)
  const listeners = {}
  plugin.apply(makeCtx(session, listeners))

  const before = session.snapshotEvents()
  const result = await rpc(listeners, 'recall', { sessionId, messageId: 'u1' })
  assert.equal(result.ok, true, '撤回应当受理')
  assert.equal(result.value.deferred, true, '回合结束后的撤回必须挂起')
  assert.equal(session.events.length, before.length, '挂起阶段不能写日志')
  assertLogIsReadable(session.events)
  assert.equal(result.value.ranges.at(-1).deferred, true, '挂起范围要回给客户端，界面才能先收起来')

  // 用户发出下一条消息：新回合 + 新 step
  session.append('turn/start', { turn: 2 })
  const stepStart = { type: 'step/start', seq: session.events.length, time: Date.now(), data: { turn: 2, step: 1 } }
  session.events.push(stepStart)
  listeners['session/event'](session, stepStart)

  const tombstone = session.events.at(-1)
  assert.equal(tombstone.type, 'system/message', 'step/start 之后要把墓碑补上')
  assert.equal(tombstone.data.turn, 2)
  assert.equal(tombstone.data.step, 1)
  assert.deepEqual(tombstone.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 4 }, '遮蔽范围要沿用原计划')
  assert.deepEqual(tombstone.sourceEventSeqs, [3, 4], 'sourceEventSeqs 必须覆盖被遮蔽的表层节点')
  assertLogIsReadable(session.events)

  // 补写之后再触发一次 step/start：不能重复写
  const count = session.events.length
  listeners['session/event'](session, { type: 'step/start', data: { turn: 3, step: 1 } })
  assert.equal(session.events.length, count, '同一条撤回只能补写一次')
}

// 3：step 还开着时立刻写，坐标用当前这一步
{
  const sessionId = 's-live'
  const events = baseEvents(sessionId) // 停在第 1 步中间
  const session = makeSession(sessionId, events)
  const listeners = {}
  plugin.apply(makeCtx(session, listeners))

  const result = await rpc(listeners, 'recall', { sessionId, messageId: 'u1' })
  assert.equal(result.ok, true)
  assert.equal(result.value.deferred, undefined, 'step 开着时不需要挂起')
  const tombstone = session.events.at(-1)
  assert.equal(tombstone.type, 'system/message')
  assert.equal(tombstone.data.turn, 1)
  assert.equal(tombstone.data.step, 1)
  assertLogIsReadable(session.events)
}

// 4：冷会话停在回合边界时明确拒绝
{
  const sessionId = 's-cold'
  const events = [...baseEvents(sessionId), { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } }, { type: 'turn/end', seq: 6, time: 7, data: { turn: 1 } }]
  const session = makeSession(sessionId, events)
  const listeners = {}
  plugin.apply(makeCtx(session, listeners))
  listeners.route = listeners.route // 冷路径：sessions.get 返回 undefined，需要单独构造
  const ctx = makeCtx(session, listeners)
  ctx.sessions.get = () => undefined
  plugin.apply(ctx)

  const result = await rpc(listeners, 'recall', { sessionId, messageId: 'u1' })
  assert.equal(result.ok, false, '冷会话停在回合边界时必须拒绝')
  assert.equal(result.error.code, 'session-idle')
  assert.equal(session.events.length, events.length, '拒绝时不能写日志')
  assertLogIsReadable(session.events)
}

console.log('dsh-recall: 4 个用例全部通过')
