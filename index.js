/**
 * dsh-recall — Host half.
 *
 * 会话日志是唯一的真相来源，而且它是仅追加的：真正「删除」一条记录不可能，
 * 也没有必要。撤回用的是 Harness 自己的机制——表层替换（surface replace）：
 * 追加一条空内容的 `system/message`，带上
 * `surfaceOp: { op: 'replace', startSeq, endSeq }`，它会把 [startSeq, endSeq]
 * 这段模型可见历史整体遮蔽掉。空内容的 system 节点不投影成消息，所以模型
 * 从此看不到被撤回的那一轮；原始日志记录仍然保留（可审计、可 fork）。
 *
 * 撤回范围一律从目标消息一直到当前表层的最后一条节点：撤回一条中间消息却
 * 保留它之后的对话，会让后面的内容引用一段已经不存在的上下文。这跟网页版
 * DeepSeek 删除一条消息的行为一致。
 *
 * 两条写入路径：
 *   - 会话在内存里（有 live Agent）：先停掉正在跑的回合并清空排队输入，
 *     再用 `session.append` 写墓碑 + `ctx.sessions.flush` 落盘。
 *   - 会话是冷的（没有 live Agent）：`ctx.sessionPersistence.open(id,'write')`
 *     拿写句柄，读到全部事件后追加同一条墓碑。
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-recall'

/** `webServer` 是通道挂载点，`connection` 提供同一套 Host/Origin + 浏览器鉴权闸门。 */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'connection', 'webServer']

/**
 * 浏览器端通道前缀。
 *
 * 这里没有用 `ctx.connection.rpc.handle()`：那个 API 里的 `owner` 会被
 * Service 的 tracker 解析成 dsh-client-connection 插件自己的 fiber，于是
 * `owner.webServer` 在 webServer 不在那条 fiber 链的 isolate 里时直接抛
 * "cannot get property webServer without inject"。本 profile 里正是如此。
 * 能在这个 profile 工作的第三方插件都是直接 `ctx.webServer.register(...)`；
 * 本插件照做，并用 `ctx.connection.requestRejection()` 自己补上同样的
 * Host/Origin 与浏览器鉴权闸门。
 */
const ROUTE = '/dsh-recall'

/**
 * 墓碑消息 id 的前缀。它是客户端识别「这条 system/message 替换是本插件写的
 * 撤回」的唯一依据——系统提示词的清空替换同样是空内容 system/message。
 */
const RECALL_ID_PREFIX = 'recall:'

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => serve(ctx, req, res),
  }), 'dsh-recall: http route')
}

/* ──────────────────────────── HTTP 传输 ──────────────────────────── */

/** 一个最小的 JSON 端点：POST `<ROUTE>/<endpoint>`，body 是 payload。 */
async function serve(ctx, req, res) {
  const rejection = ctx.connection.requestRejection({ headers: req.headers })
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (req.method !== 'POST') return send(res, 405, fail('bad-request', 'POST only'))
  const endpoint = endpointOf(req.url)
  if (endpoint === null) return send(res, 404, fail('bad-request', 'unknown endpoint'))
  let payload
  try {
    payload = await readJson(req)
  } catch (error) {
    return send(res, 400, fail('bad-request', `body is not JSON: ${error instanceof Error ? error.message : String(error)}`))
  }
  const result = await handle(ctx, endpoint, payload, undefined)
  send(res, 200, result)
}

/** `/dsh-recall/recall` → `recall`；路径不符或含空段/`.`/`..` 时返回 null。 */
function endpointOf(url) {
  const path = (url ?? '').split('?', 1)[0]
  if (!path.startsWith(`${ROUTE}/`)) return null
  const endpoint = path.slice(ROUTE.length + 1)
  if (endpoint === '') return null
  for (const segment of endpoint.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return endpoint
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function handle(ctx, endpoint, payload, signal) {
  try {
    if (endpoint === 'state') return await state(ctx, payload, signal)
    if (endpoint === 'recall') return await recall(ctx, payload, signal)
    return fail('bad-request', `unknown endpoint: ${endpoint}`)
  } catch (error) {
    return fail('internal', error instanceof Error ? error.message : String(error))
  }
}

/* ──────────────────────────── 表层折叠 ──────────────────────────── */

/**
 * 重放日志里的表层操作，得到当前的模型可见节点序号。
 * 只依赖事件自带的两个字段，不 import dsh-session（避免和宿主加载的那份
 * 版本对不上）。
 */
function foldSurfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') { nodes.push(event.seq); continue }
    const start = nodes.indexOf(op.startSeq)
    const end = nodes.indexOf(op.endSeq)
    if (start < 0 || end < 0 || start > end) throw new Error(`surface replace at seq ${event.seq} does not resolve against this log`)
    nodes.splice(start, end - start + 1, event.seq)
  }
  return nodes
}

/** 每个 `turn/start` 的序号与回合号，升序。 */
function turnStarts(events) {
  return events.filter((event) => event.type === 'turn/start').map((event) => ({ seq: event.seq, turn: event.data.turn }))
}

/** 序号 seq 所属的回合号（取它之前最近的 turn/start）。 */
function turnAt(starts, seq) {
  let turn = starts.length > 0 ? starts[0].turn : 0
  for (const start of starts) {
    if (start.seq <= seq) turn = start.turn
    else break
  }
  return turn
}

/** 序号 seq 所属的 step（取它之前最近的 step/start）。 */
function stepAt(events, seq) {
  let step = null
  for (const event of events) {
    if (event.seq > seq) break
    if (event.type === 'step/start') step = { turn: event.data.turn, step: event.data.step }
  }
  return step
}

function isRecallTombstone(event) {
  return event.type === 'system/message'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
    && event.surfaceOp.op === 'replace'
    && typeof event.data?.message?.id === 'string'
    && event.data.message.id.startsWith(RECALL_ID_PREFIX)
}

/** 日志里已经生效的所有撤回范围，附带回合区间（客户端据此收起界面行）。 */
function recallRanges(events) {
  const starts = turnStarts(events)
  const ranges = []
  for (const event of events) {
    if (!isRecallTombstone(event)) continue
    const { startSeq, endSeq } = event.surfaceOp
    ranges.push({
      startSeq,
      endSeq,
      startTurn: turnAt(starts, startSeq),
      endTurn: turnAt(starts, endSeq),
    })
  }
  return ranges
}

/** 一条 user/message 事件里的纯文本。 */
function textOf(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/** 当前表层的最后一条 user/message（撤回「上一条」时的目标）。 */
function lastUser(events, nodes) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const event = events.find((candidate) => candidate.seq === nodes[i])
    if (event?.type === 'user/message') return { messageId: event.data.id, seq: event.seq, turn: turnAt(turnStarts(events), event.seq) }
  }
  return null
}

/* ──────────────────────────── 两个端点 ──────────────────────────── */

async function state(ctx, payload, signal) {
  const sessionId = requireSessionId(payload)
  if (sessionId === null) return fail('bad-request', 'sessionId is required')
  const events = await readEvents(ctx, sessionId, signal)
  if (events === null) return fail('not-found', `unknown session: ${sessionId}`)
  const nodes = foldSurfaceNodes(events)
  return ok({ ranges: recallRanges(events), lastUser: lastUser(events, nodes) })
}

async function recall(ctx, payload, signal) {
  const sessionId = requireSessionId(payload)
  if (sessionId === null) return fail('bad-request', 'sessionId is required')
  const selector = {
    ...(Number.isSafeInteger(payload?.seq) ? { seq: payload.seq } : {}),
    ...(typeof payload?.messageId === 'string' && payload.messageId !== '' ? { messageId: payload.messageId } : {}),
  }
  if (selector.seq === undefined && selector.messageId === undefined) return fail('bad-request', 'seq or messageId is required')

  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return await recallLive(ctx, live, selector)

  const handle = await ctx.sessionPersistence.open(sessionId, 'write', signal === undefined ? undefined : { signal })
  try {
    const { events } = await handle.read()
    const plan = planRecall(events, selector)
    if (plan.ok !== true) return plan
    await handle.append([{ ...plan.entry, seq: events.length, time: Date.now() }])
    await handle.flush()
    return ok(resultOf([...events, plan.entry], plan))
  } finally {
    await handle.close()
  }
}

async function recallLive(ctx, session, selector) {
  const agent = ctx.agents.get(session.id)
  if (agent !== undefined) {
    const pending = agent.inbox.nextTurn.length + agent.inbox.nextStep.length
    if (agent.status === 'running' || pending > 0) {
      // keepInbox: false —— 误发的那条消息可能还在排队，不能让它跑完再撤回。
      agent.cancel({ kind: 'user' }, { keepInbox: false })
      await agent.whenIdle()
      if (agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0) agent.inbox.clear()
    }
  }
  const events = session.snapshotEvents()
  const plan = planRecall(events, selector)
  if (plan.ok !== true) return plan
  session.append(plan.entry.type, plan.entry.data, {
    surfaceOp: plan.entry.surfaceOp,
    sourceEventSeqs: plan.entry.sourceEventSeqs,
  })
  if (!await ctx.sessions.flush(session)) throw new Error(`no durability listener participated for live session '${session.id}'`)
  return ok(resultOf(session.snapshotEvents(), plan))
}

/** 读一个会话的全部事件：live 用内存快照，冷会话开读句柄。 */
async function readEvents(ctx, sessionId, signal) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.snapshotEvents()
  if (await ctx.sessionPersistence.stat(sessionId, signal === undefined ? undefined : { signal }) === undefined) return null
  const handle = await ctx.sessionPersistence.open(sessionId, 'read', signal === undefined ? undefined : { signal })
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/* ──────────────────────────── 撤回计划 ──────────────────────────── */

/**
 * 校验撤回目标并构造墓碑事件（不含 seq/time，由各自的写入路径补齐）。
 * @returns 成功时 `{ ok: true, entry, target, shadowed, text, turn }`，失败时 RPC 失败信封。
 */
function planRecall(events, selector) {
  const nodes = foldSurfaceNodes(events)
  let targetSeq = selector.seq
  if (targetSeq === undefined) {
    const found = events.find((event) => event.type === 'user/message' && event.data?.id === selector.messageId)
    if (found === undefined) return fail('not-found', `message not found: ${selector.messageId}`)
    targetSeq = found.seq
  }
  const target = events.find((event) => event.seq === targetSeq)
  if (target === undefined) return fail('not-found', `event not found at seq ${targetSeq}`)
  if (target.type !== 'user/message') return fail('bad-request', '只有你自己发出的 user/message 可以撤回')
  const index = nodes.indexOf(targetSeq)
  if (index < 0) return fail('already-recalled', '这条消息已经不在当前对话里了')
  if (index === 0) return fail('bad-request', '不能撤回系统提示词节点')

  const shadowed = nodes.slice(index)
  const endSeq = shadowed[shadowed.length - 1]
  const step = stepAt(events, targetSeq) ?? { turn: turnAt(turnStarts(events), targetSeq), step: 1 }

  return {
    ok: true,
    target,
    shadowed,
    endSeq,
    text: textOf(target),
    turn: step.turn,
    entry: {
      type: 'system/message',
      data: {
        turn: step.turn,
        step: step.step,
        message: {
          id: `${RECALL_ID_PREFIX}${randomUUID()}`,
          role: 'system',
          source: { kind: 'system-prompt' },
          // 空内容 → deriveEventMessage 返回 null → 被遮蔽的这段彻底不进模型输入。
          content: [],
        },
      },
      surfaceOp: { op: 'replace', startSeq: targetSeq, endSeq },
      sourceEventSeqs: [...shadowed],
    },
  }
}

function resultOf(events, plan) {
  return {
    recalled: { seq: plan.target.seq, messageId: plan.target.data.id, turn: plan.turn, text: plan.text },
    shadowed: [...plan.shadowed],
    ranges: recallRanges(events),
  }
}

/* ──────────────────────────── 小工具 ──────────────────────────── */

function requireSessionId(payload) {
  return typeof payload?.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : null
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}
