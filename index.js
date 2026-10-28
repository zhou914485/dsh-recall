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
import { rm } from 'node:fs/promises'
import path from 'node:path'

export const name = 'dsh-recall'

/** `webServer` 是通道挂载点，`connection` 提供同一套 Host/Origin + 浏览器鉴权闸门。 */
export const inject = ['sessions', 'agents', 'sessionPersistence', 'connection', 'webServer', 'fs']

/**
 * workspaceChanges 是可选服务：它按回合记录改动文件清单与前后对比，只存在
 * Host 内存里（`@deepseek-ai/dsh-workspace-changes`）。缺了它就不能保证撤回
 * 安全，所以按「没有清单」处理。
 */
const CHANGES_SERVICE = 'workspaceChanges'

/** 会改文件的第一方工具（与 workspace-changes 的 capture 集合一致）。 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

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

  // 墓碑是 step 级事件：回合已经结束（没有打开的 step）时立刻写入，会让整条
  // 会话日志通不过格式校验、再也读不出来。这类撤回先挂起，等下一次
  // `step/start` 到来时用那一步的坐标补写。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') flushDeferred(ctx, session, event)
  }), 'dsh-recall: deferred tombstones')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    pendingRecalls.delete(session.id)
  }), 'dsh-recall: pending cleanup')
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
    if (endpoint === 'preview') return await preview(ctx, payload, signal)
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

/* ─────────────────────── 没有打开的 step 时挂起 ─────────────────────── */

/**
 * 日志末尾当前打开的 step，没有打开的就返回 null。
 * `system/message` 必须落在打开的 step 里（v3/v4 格式都这么要求），
 * 写在 step 之外会让整个会话读不出来。
 */
function openStep(events) {
  let turn = null
  let step = null
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data?.turn ?? null; step = null }
    else if (event.type === 'turn/end') { turn = null; step = null }
    else if (event.type === 'step/start') step = event.data?.step ?? null
    else if (event.type === 'step/end') step = null
  }
  return turn === null || step === null ? null : { turn, step }
}

/**
 * 挂起中的撤回：sessionId → { startSeq, endSeq, text }。
 * 只活在 Host 内存里——进程重启就没了，届时那条消息重新出现在表层上，
 * 这比写出一条读不出来的日志要好。
 */
const pendingRecalls = new Map()

/** 记下一条等下一个 step 才能落盘的撤回；重复撤回取并集。 */
function deferRecall(sessionId, plan) {
  const existing = pendingRecalls.get(sessionId)
  if (existing === undefined) {
    pendingRecalls.set(sessionId, { startSeq: plan.target.seq, endSeq: plan.endSeq, text: plan.text })
    return
  }
  existing.startSeq = Math.min(existing.startSeq, plan.target.seq)
  existing.endSeq = Math.max(existing.endSeq, plan.endSeq)
}

/** 挂起中的撤回也要算进「已撤回」范围，界面才能立刻把那一行收起来。 */
function pendingRanges(events, sessionId) {
  const pending = pendingRecalls.get(sessionId)
  if (pending === undefined) return []
  const starts = turnStarts(events)
  return [{
    startSeq: pending.startSeq,
    endSeq: pending.endSeq,
    startTurn: turnAt(starts, pending.startSeq),
    endTurn: turnAt(starts, pending.endSeq),
    text: pending.text,
    deferred: true,
  }]
}

/**
 * 新的一步开始了：把挂起的撤回补写成这一步骤里的墓碑。
 * 遮蔽范围沿用挂起时的 [startSeq, endSeq]，坐标用当前打开的 step。
 */
function flushDeferred(ctx, session, event) {
  const pending = pendingRecalls.get(session.id)
  if (pending === undefined) return
  let nodes
  try {
    nodes = foldSurfaceNodes(session.snapshotEvents())
  } catch {
    pendingRecalls.delete(session.id)
    return
  }
  const start = nodes.indexOf(pending.startSeq)
  const end = nodes.indexOf(pending.endSeq)
  if (start < 0 || end < start) { pendingRecalls.delete(session.id); return }
  try {
    session.append('system/message', {
      turn: event.data.turn,
      step: event.data.step,
      message: {
        id: `${RECALL_ID_PREFIX}${randomUUID()}`,
        role: 'system',
        source: { kind: 'system-prompt' },
        content: [],
      },
    }, {
      surfaceOp: { op: 'replace', startSeq: pending.startSeq, endSeq: pending.endSeq },
      sourceEventSeqs: nodes.slice(start, end + 1),
    })
  } catch {
    // 这一步没写成（例如目标已被别的东西遮蔽）：留到下一个 step 再试，
    // 绝不退化成写一条坏日志。
    return
  }
  pendingRecalls.delete(session.id)
  Promise.resolve(ctx.sessions.flush(session)).catch(() => {})
}

function isRecallTombstone(event) {
  return event.type === 'system/message'
    && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
    && event.surfaceOp.op === 'replace'
    && typeof event.data?.message?.id === 'string'
    && event.data.message.id.startsWith(RECALL_ID_PREFIX)
}

/** 日志里已经生效的所有撤回范围，附带回合区间与被撤回的原文。 */
function recallRanges(events) {
  const starts = turnStarts(events)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const ranges = []
  for (const event of events) {
    if (!isRecallTombstone(event)) continue
    const { startSeq, endSeq } = event.surfaceOp
    ranges.push({
      startSeq,
      endSeq,
      startTurn: turnAt(starts, startSeq),
      endTurn: turnAt(starts, endSeq),
      // 原文随范围一起回给客户端，刷新页面后「复制原文」仍然可用。
      text: textOf(bySeq.get(startSeq)),
    })
  }
  return ranges
}

/** 一条消息里的纯文本。 */
function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/** 一条 user/message 事件里的纯文本。 */
function textOf(event) {
  return textOfMessage(event?.data)
}

/**
 * inbox 里还没进入日志的消息，按「先被消费」的顺序排列：
 * nextStep 会在下一个 step 边界被取走，nextTurn 要等到下一轮。
 */
function pendingMessages(inbox) {
  if (inbox === undefined) return []
  return [...inbox.nextStep, ...inbox.nextTurn]
}

/** 比较用的规范化文本：折叠空白、去首尾。 */
function normalizeText(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/**
 * 从 inbox 里挑出要撤回的那条排队消息。
 *
 * DOM 上排队气泡不带 message id（PendingSteeringBubble 只有 data-pending-steering），
 * 所以按「id → 原文 → 最后一条」三级优先匹配；原文匹配是精确规范化比较，
 * 对不上就报 not-found，绝不猜一条删掉。
 */
function selectPending(pending, payload) {
  const byId = typeof payload?.messageId === 'string' && payload.messageId !== ''
    ? pending.find((message) => message.id === payload.messageId)
    : undefined
  if (byId !== undefined) return byId

  const wanted = normalizeText(payload?.pendingText)
  if (wanted !== '') {
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (normalizeText(textOfMessage(pending[i])) === wanted) return pending[i]
    }
    return null
  }

  if (payload?.lastOne === true && pending.length > 0) return pending[pending.length - 1]
  return null
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
  const pending = pendingMessages(ctx.agents.get(sessionId)?.inbox)
    .map((message) => ({ messageId: message.id, text: textOfMessage(message) }))
  return ok({ ranges: [...recallRanges(events), ...pendingRanges(events, sessionId)], lastUser: lastUser(events, nodes), pending })
}

/** 从 payload 里取出撤回目标（seq / messageId / 上一条的 messageId）。 */
function selectorOf(payload) {
  if (Number.isSafeInteger(payload?.seq)) return { seq: payload.seq }
  if (typeof payload?.messageId === 'string' && payload.messageId !== '') return { messageId: payload.messageId }
  // 「撤回上一条」：队列空了以后退回到表层上的最后一条 user 消息。
  if (typeof payload?.lastMessageId === 'string' && payload.lastMessageId !== '') return { messageId: payload.lastMessageId }
  return null
}

/* ──────────────────────── 撤回前的安全检查 ──────────────────────── */

/**
 * 一次撤回覆盖哪些回合、这些回合改过哪些文件、还有哪些不可恢复的副作用。
 *
 * 判定规则：只有拿得到「改动清单」才允许撤回。清单来自
 * `workspaceChanges.summary(sessionId, seq)`，它只活在 Host 内存里——重启后
 * 日志里仍有 `workspace/changes` 事件，但 summary 取不到，这时必须拒绝，
 * 而不是假装那一轮没改过文件。
 */
function analyze(ctx, sessionId, events, plan) {
  const starts = turnStarts(events)
  const startTurn = turnAt(starts, plan.target.seq)
  const endTurn = turnAt(starts, plan.endSeq)
  const turns = []
  for (let turn = startTurn; turn <= endTurn; turn += 1) turns.push(turn)

  const changes = ctx.get(CHANGES_SERVICE)
  const changeEventOf = new Map()
  for (const event of events) {
    if (event.type !== 'workspace/changes') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || !turns.includes(turn)) continue
    const previous = changeEventOf.get(turn)
    if (previous === undefined || event.seq > previous.seq) changeEventOf.set(turn, event)
  }

  const files = []
  const lostTurns = []
  for (const turn of turns) {
    const event = changeEventOf.get(turn)
    if (event === undefined) continue
    const summary = changes?.summary(sessionId, event.seq)
    if (summary === undefined) { lostTurns.push(turn); continue }
    summary.files.forEach((file, index) => files.push({
      turn,
      seq: event.seq,
      index,
      path: file.path,
      display: file.display,
      added: file.added,
      deleted: file.deleted,
      binary: file.binary === true,
      oversized: file.oversized === true,
    }))
  }

  // 这一段里的工具调用：文件写入归入「可恢复」，其余都是不可恢复的副作用。
  const toolCalls = {}
  let unlistedMutations = 0
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (event.seq < plan.target.seq || event.seq > plan.endSeq) continue
    const name = event.data?.name
    if (typeof name !== 'string' || name === '') continue
    if (MUTATING_TOOLS.has(name)) {
      if (!changeEventOf.has(turnAt(starts, event.seq))) unlistedMutations += 1
      continue
    }
    toolCalls[name] = (toolCalls[name] ?? 0) + 1
  }

  let blocked = null
  if (lostTurns.length > 0) {
    blocked = {
      reason: 'changes-lost',
      turns: lostTurns,
      message: `第 ${lostTurns.join('、')} 轮改过文件，但改动清单只存在 Host 内存里，重启后已经丢失，无法确认改了哪些文件，所以不允许撤回。`,
    }
  } else if (unlistedMutations > 0) {
    blocked = {
      reason: 'changes-unlisted',
      count: unlistedMutations,
      message: `这一段里有 ${unlistedMutations} 次文件写入，但对应的改动清单还没生成，无法确认改了哪些文件，所以不允许撤回。`,
    }
  }

  return { turns, startTurn, endTurn, files, toolCalls, blocked }
}

/**
 * 撤回前的闸门：能不能撤、要不要恢复文件。
 * @returns `{ error }` 表示不能继续；`{ restored }` 表示可以继续，附带恢复报告。
 */
async function guard(ctx, sessionId, events, plan, payload, cwd, signal) {
  const analysis = analyze(ctx, sessionId, events, plan)
  if (analysis.blocked !== null) return { error: fail('blocked', analysis.blocked.message, analysis.blocked) }
  if (payload?.restoreFiles !== true || analysis.files.length === 0) return { restored: null }
  const restored = await restoreFiles(ctx, sessionId, analysis.files, cwd, signal)
  if (restored.failed.length > 0) {
    return { error: fail('restore-failed', `有 ${restored.failed.length} 个文件没法安全恢复，本次没有撤回。`, restored) }
  }
  return { restored }
}

async function preview(ctx, payload, signal) {
  const sessionId = requireSessionId(payload)
  if (sessionId === null) return fail('bad-request', 'sessionId is required')

  const agent = ctx.agents.get(sessionId)
  if (agent !== undefined && selectPending(pendingMessages(agent.inbox), payload) !== null) {
    return ok({ pending: true, blocked: null, files: [], toolCalls: {}, turns: [] })
  }

  const events = await readEvents(ctx, sessionId, signal)
  if (events === null) return fail('not-found', `unknown session: ${sessionId}`)
  const selector = selectorOf(payload)
  if (selector === null) return fail('bad-request', 'seq, messageId or pendingText is required')
  const plan = planRecall(events, selector)
  if (plan.ok !== true) return plan
  return ok({ pending: false, text: plan.text, ...analyze(ctx, sessionId, events, plan) })
}

/* ──────────────────────── 文件恢复 ──────────────────────── */

/**
 * 按录制的前后对比把文件写回这一轮开始之前的样子。
 * 一次只处理一个文件；任何一个文件对不上就整体放弃，绝不留下半吊子状态。
 */
async function restoreFiles(ctx, sessionId, files, cwd, signal) {
  const changes = ctx.get(CHANGES_SERVICE)
  const done = []
  const failed = []
  if (changes === undefined) return { done, failed: files.map((file) => ({ display: file.display, reason: '改动清单服务不可用' })) }
  const abort = signal ?? new AbortController().signal
  for (const file of files) {
    if (file.binary || file.oversized) { failed.push({ display: file.display, reason: '二进制或超大文件，没有可比对的内容' }); continue }
    try {
      const diff = await changes.diff(sessionId, file.seq, file.index, abort)
      if (diff === undefined) { failed.push({ display: file.display, reason: '改动对比已失效' }); continue }
      if (diff.kind !== 'text') { failed.push({ display: file.display, reason: '二进制或超大文件，没有可比对的内容' }); continue }
      await restoreOneFile(ctx, cwd, diff)
      done.push(file.display)
    } catch (error) {
      failed.push({ display: file.display, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { done, failed }
}

async function restoreOneFile(ctx, cwd, diff) {
  const target = await ctx.fs.resolve(diff.path, cwd === undefined ? {} : { cwd })

  if (diff.before === false) {
    // 这一轮新建的文件：恢复 = 删掉它。
    if (await ctx.fs.stat(target) === undefined) return
    await removeFile(ctx, target, cwd)
    return
  }

  const existing = await ctx.fs.stat(target)
  const current = existing === undefined ? '' : await ctx.fs.readText(target)
  await ctx.fs.writeText(target, reverseApply(diff.hunks, current))
}

/** 按行反向应用 unified diff 的 hunks；当前内容对不上就抛冲突。 */
function reverseApply(hunks, currentText) {
  // 行号是 1 基、行内不含换行符；先把尾部换行摘出来，处理完再按原样接回去。
  const trailing = currentText.endsWith('\n')
  const body = trailing ? currentText.slice(0, -1) : currentText
  const lines = currentText === '' ? [] : body.split('\n')
  const result = [...lines]
  for (const hunk of [...hunks].sort((left, right) => right.newStart - left.newStart)) {
    const start = Math.max(0, hunk.newStart - 1)
    const expected = hunk.lines.filter((line) => line[0] !== '-').map((line) => line.slice(1))
    const actual = result.slice(start, start + hunk.newLines)
    if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
      throw new Error('文件已被后续改动，无法安全恢复')
    }
    const replacement = hunk.lines.filter((line) => line[0] !== '+').map((line) => line.slice(1))
    result.splice(start, hunk.newLines, ...replacement)
  }
  const joined = result.join('\n')
  // 整文件被删过时当前内容为空，拿不到尾部换行信息，按「文本文件以换行结尾」补回。
  return trailing || (currentText === '' && joined !== '') ? `${joined}\n` : joined
}

/** 删除一个由本回合创建的文件，先确认它确实在会话工作区内。 */
async function removeFile(ctx, target, cwd) {
  const hostPath = ctx.fs.processPath(target)
  if (hostPath === undefined) throw new Error('无法解析宿主路径')
  const absolute = path.resolve(hostPath)
  const root = cwd === undefined ? null : path.resolve(cwd)
  if (root === null || (absolute !== root && !absolute.startsWith(root + path.sep))) {
    throw new Error('目标不在会话工作区内，拒绝删除')
  }
  await rm(absolute, { force: true })
}

async function recall(ctx, payload, signal) {
  const sessionId = requireSessionId(payload)
  if (sessionId === null) return fail('bad-request', 'sessionId is required')

  // 排队中的消息不在日志里，也就不在表层上：直接从 inbox 摘掉，不写墓碑。
  const agent = ctx.agents.get(sessionId)
  if (agent !== undefined) {
    const pending = pendingMessages(agent.inbox)
    const target = selectPending(pending, payload)
    if (target !== null) {
      if (!agent.inbox.remove(target.id)) return fail('conflict', '这条排队消息刚好被模型取走了，请用消息旁的撤回')
      const events = ctx.sessions.get(sessionId)?.snapshotEvents() ?? []
      return ok({
        recalled: { pending: true, messageId: target.id, text: textOfMessage(target) },
        ranges: recallRanges(events),
      })
    }
    // 明确按原文找过却没找到：不要退回去撤上一条已进日志的消息。
    if (normalizeText(payload?.pendingText) !== '') return fail('not-found', '这条排队消息已经不在队列里了（可能刚被模型取走）')
  }

  const selector = selectorOf(payload)
  if (selector === null) return fail('bad-request', 'seq, messageId or pendingText is required')

  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return await recallLive(ctx, live, selector, payload, signal)

  const handle = await ctx.sessionPersistence.open(sessionId, 'write', signal === undefined ? undefined : { signal })
  try {
    const { events } = await handle.read()
    const plan = planRecall(events, selector)
    if (plan.ok !== true) return plan
    const guarded = await guard(ctx, sessionId, events, plan, payload, handle.header.cwd, signal)
    if (guarded.error !== undefined) return guarded.error
    const open = openStep(events)
    if (open === null) {
      // 冷会话没有下一次 step/start 可以挂靠，写入即损坏：宁可拒绝。
      return fail('session-idle', '这个会话当前没有在运行（日志停在回合边界），此时写墓碑会让整条历史读不出来。等它恢复、进入下一轮之后再撤回。')
    }
    await handle.append([{
      ...plan.entry,
      seq: events.length,
      time: Date.now(),
      data: { ...plan.entry.data, turn: open.turn, step: open.step },
    }])
    await handle.flush()
    return ok({ ...resultOf([...events, plan.entry], plan), restored: guarded.restored })
  } finally {
    await handle.close()
  }
}

async function recallLive(ctx, session, selector, payload, signal) {
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
  // 必须在回合停下之后再取事件：中止的回合会补写 assistant/message 与
  // turn/end，workspace/changes 也在这时落盘，改动清单才有得看。
  const events = session.snapshotEvents()
  const plan = planRecall(events, selector)
  if (plan.ok !== true) return plan
  const guarded = await guard(ctx, session.id, events, plan, payload, session.header.cwd, signal)
  if (guarded.error !== undefined) return guarded.error
  // 中止过的回合已经 step/end + turn/end：此时写 system/message 会让日志再也
  // 读不出来。没有打开的 step 就挂起，等下一次 step/start 再补。
  const open = openStep(events)
  if (open === null) {
    deferRecall(session.id, plan)
    return ok({
      ...resultOf(events, plan),
      restored: guarded.restored,
      deferred: true,
      ranges: [...recallRanges(events), ...pendingRanges(events, session.id)],
    })
  }

  try {
    session.append(plan.entry.type, { ...plan.entry.data, turn: open.turn, step: open.step }, {
      surfaceOp: plan.entry.surfaceOp,
      sourceEventSeqs: plan.entry.sourceEventSeqs,
    })
  } catch (error) {
    return fail('conflict', `写墓碑失败，本次没有撤回：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!await ctx.sessions.flush(session)) throw new Error(`no durability listener participated for live session '${session.id}'`)
  return ok({ ...resultOf(session.snapshotEvents(), plan), restored: guarded.restored })
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

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}
