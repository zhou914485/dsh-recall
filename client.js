/**
 * dsh-recall — Client half.
 *
 * 三件事：
 *   1. 会话里每条 user 消息行上挂一个「撤回」按钮（DOM 注入，悬停显示）。
 *   2. 输入框工具行上一个「撤回上一条」按钮。
 *   3. 把已经撤回的对话行收起来（按回合区间），并在输入框上方显示一条可复制的
 *      「已撤回」提示条。
 *
 * 撤回本身走 Host 的 `/dsh-recall` RPC 通道；客户端只负责「哪条」和「看起来
 * 怎么样了」。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-recall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-recall'
    const CHANNEL = '/dsh-recall'
    const STYLE_ID = 'dsh-recall-style'
    /** 被撤回的行加这个属性，CSS 把它 display:none。 */
    const HIDDEN_ATTR = 'data-dsh-recall-hidden'
    /**
     * user 行的 `data-chat-node-key` 是 Conversation 的 context key，形如
     * `<kind 长度>:<kind><id>`；user 消息的 kind 是 `input-message`，id 就是
     * 那条 user/message 的 messageId。
     */
    const USER_NODE_KIND = 'input-message'
    /** 与宿主 16px 图标同一套画法（Material undo），按钮自己带 currentColor。 */
    const RECALL_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>'
    /** 对话流里「已排队、还没进日志」的气泡（steering 与本地回显两种）。 */
    const PENDING_SELECTOR = '[data-pending-steering], [data-submission-echo]'

    const zh = {
      'action.recall': '撤回',
      'action.recallHint': '撤回这条消息（模型也会忘记它）',
      'action.recallLast': '撤回上一条',
      'action.recallLastHint': '撤回你刚发出的那条消息，原文放回输入框',
      'bar.recalled': (n) => `本会话已撤回 ${n} 处对话`,
      'bar.show': '显示',
      'bar.hide': '隐藏',
      'bar.copy': '复制原文',
      'bar.copied': '已复制',
      'notice.recalled': '已撤回，原文已放回输入框',
      'notice.manual': '已撤回（没能自动写回输入框，请用「复制原文」）',
      'notice.failed': '撤回失败',
      'notice.working': '撤回中…',
    }
    const en = {
      'action.recall': 'Recall',
      'action.recallHint': 'Recall this message (the model forgets it too)',
      'action.recallLast': 'Recall last',
      'action.recallLastHint': 'Recall the message you just sent and put its text back',
      'bar.recalled': (n) => `${n} recalled exchange(s) in this session`,
      'bar.show': 'Show',
      'bar.hide': 'Hide',
      'bar.copy': 'Copy text',
      'bar.copied': 'Copied',
      'notice.recalled': 'Recalled — the text is back in the composer',
      'notice.manual': 'Recalled (could not write it back — use “Copy text”)',
      'notice.failed': 'Recall failed',
      'notice.working': 'Recalling…',
    }

    /* ───────────────────── 模块级共享状态 ───────────────────── */

    /** 当前会话 id，由会话作用域的插槽组件写入。 */
    let sessionId = null
    /** 撤回范围（含回合区间），Host 是权威来源。 */
    let ranges = []
    /** 是否把撤回掉的对话行显示出来（默认收起）。 */
    let revealing = false
    /** 最近一次撤回的原文，用于提示条上的复制按钮。 */
    let lastText = ''
    /** 提示条文案（null = 不显示）。 */
    let notice = null
    let noticeTimer = null
    /** 界面上是否存在还没进日志的排队气泡（DOM 是这里唯一及时的来源）。 */
    let pendingInDom = false
    /**
     * 撤回前的确认弹窗。`preview` 是 Host 给的检查结果：会撤掉哪几轮、改了
     * 哪些文件、还有哪些不可恢复的副作用。null 表示没有弹窗。
     */
    let dialog = null

    /**
     * 「已接受」的撤回提示按会话记住：点过 × 之后，这个会话不再弹计数器。
     * 优先写 localStorage（跨刷新），写不进去（隐私模式）就退化成内存集合，
     * 至少同一次页面生命周期内切会话不会再冒出来。
     */
    const DISMISS_KEY_PREFIX = 'dsh-recall:dismissed:'
    const dismissedFallback = new Set()

    function isBarDismissed(id) {
      if (id === null || id === undefined) return false
      if (dismissedFallback.has(id)) return true
      try { return localStorage.getItem(DISMISS_KEY_PREFIX + id) === '1' } catch { return false }
    }

    function dismissBar(id) {
      if (id === null || id === undefined) return
      dismissedFallback.add(id)
      try { localStorage.setItem(DISMISS_KEY_PREFIX + id, '1') } catch { /* 内存里已经记住了 */ }
    }

    const listeners = new Set()
    const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }
    let revision = 0
    const getRevision = () => revision
    const bump = () => { revision += 1; for (const fn of [...listeners]) fn() }

    function useShared() {
      return React.useSyncExternalStore(subscribe, getRevision, getRevision)
    }

    function setNotice(text, autoHideMs) {
      if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null }
      notice = text
      bump()
      if (autoHideMs !== undefined && text !== null) {
        noticeTimer = setTimeout(() => { notice = null; noticeTimer = null; bump() }, autoHideMs)
      }
    }

    /* ───────────────────── RPC ───────────────────── */

    async function rpc(ctx, endpoint, payload, signal) {
      const result = await post(endpoint, payload, signal)
      return result
    }

    /**
     * 走 Host 直挂的 HTTP 路由，不用 `ctx.connection.rpc`：那条通道在本
     * profile 里挂不上（见 Host half 的说明）。同源 POST 自带浏览器会话
     * cookie，Host 侧仍会过一遍同一套鉴权闸门。
     */
    async function post(endpoint, payload, signal) {
      try {
        const response = await fetch(`${CHANNEL}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify(payload ?? {}),
          ...(signal === undefined ? {} : { signal }),
        })
        if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
        const body = await response.json()
        if (body?.ok === true) return { ok: true, value: body.value }
        return { ok: false, message: body?.error?.message ?? 'unknown failure', details: body?.error?.details ?? {} }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    /* ───────────────────── 界面收起 ───────────────────── */

    function hiddenTurns() {
      const set = new Set()
      if (revealing) return set
      for (const range of ranges) {
        for (let turn = range.startTurn; turn <= range.endTurn; turn += 1) set.add(turn)
      }
      return set
    }

    function applyHiding(root) {
      const hidden = hiddenTurns()
      for (const row of root.querySelectorAll('[data-chat-flow-kind]')) {
        const turn = Number(row.getAttribute('data-chat-turn'))
        if (Number.isFinite(turn) && hidden.has(turn)) row.setAttribute(HIDDEN_ATTR, '')
        else row.removeAttribute(HIDDEN_ATTR)
      }
    }

    /* ───────────────────── user 行上的撤回按钮 ───────────────────── */

    function messageIdOf(row) {
      const key = row.getAttribute('data-chat-node-key')
      if (key === null) return null
      const colon = key.indexOf(':')
      if (colon <= 0) return null
      const kindLength = Number(key.slice(0, colon))
      if (!Number.isSafeInteger(kindLength) || kindLength <= 0) return null
      const kind = key.slice(colon + 1, colon + 1 + kindLength)
      if (kind !== USER_NODE_KIND) return null
      const id = key.slice(colon + 1 + kindLength)
      return id === '' ? null : id
    }

    /** 气泡里的纯文本（排队气泡没有 message id，只能拿原文跟 Host 配对）。 */
    function bubbleTextOf(row) {
      const bubble = row.querySelector('[class*="bubble"]') ?? row
      const clone = bubble.cloneNode(true)
      for (const node of clone.querySelectorAll('[data-dsh-recall-action]')) node.remove()
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    }

    /**
     * 把「撤回」放进消息自己的操作条（时间 + 复制 那一行），而不是浮在气泡
     * 右上角：那一行已经是 flex 布局、28px 行高、按 hover 显隐，按钮作为它的
     * 一个子项就自动与宿主的复制按钮同排同高、同一套 hover 反馈。
     */
    function ensureActionButton(ctx, row, selectorOf) {
      if (row.querySelector('[data-dsh-recall-action]') !== null) return
      const actions = row.querySelector('[data-clock]')
      if (actions === null) return
      const selector = selectorOf(row)
      if (selector === null) return
      const pending = selector.pendingText !== undefined
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-dsh-recall-action', '')
      button.setAttribute('aria-label', pending ? '撤回这条排队中的消息' : '撤回这条消息')
      button.title = pending ? '撤回这条还没发出去的消息' : '撤回这条消息（模型也会忘记它）'
      button.innerHTML = RECALL_ICON
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void askRecall(ctx, selector)
      })
      actions.appendChild(button)
    }

    /* ───────────────────── 撤回动作 ───────────────────── */

    /**
     * 先问 Host 要一份「撤回会影响什么」，再决定是直接撤还是弹窗确认。
     * 纯排队消息没有文件副作用，直接撤；其余一律让用户看着清单点头。
     */
    async function askRecall(ctx, selector) {
      if (sessionId === null) { setNotice('没有打开的会话', 3000); return }
      const result = await rpc(ctx, 'preview', { sessionId, ...selector })
      if (result.ok !== true) { setNotice(`撤回前检查失败：${result.message}`, 6000); return }
      const preview = result.value
      if (preview.pending === true) { await doRecall(ctx, selector, false); return }
      dialog = { selector, preview, restoreFiles: preview.files.length > 0, busy: false, error: null }
      bump()
    }

    async function doRecall(ctx, selector, restoreFiles) {
      if (sessionId === null) { setNotice('没有打开的会话', 3000); return }
      setNotice('撤回中…')
      const result = await rpc(ctx, 'recall', {
        sessionId,
        ...selector,
        ...(restoreFiles ? { restoreFiles: true } : {}),
      })
      if (result.ok !== true) {
        // 弹窗还开着就把失败留在弹窗里（能看清是哪些文件冲突），否则退化成提示条。
        if (dialog !== null) { dialog = { ...dialog, busy: false, error: result }; bump() }
        else setNotice(`撤回失败：${result.message}`, 6000)
        return
      }
      const value = result.value
      ranges = Array.isArray(value.ranges) ? value.ranges : ranges
      lastText = value.recalled?.text ?? ''
      revealing = false
      dialog = null
      const restored = restoreDraft(lastText)
      const what = value.recalled?.pending === true ? '已撤回排队中的消息' : '已撤回'
      const files = value.restored?.done?.length ?? 0
      const text = `${what}${files > 0 ? `，并恢复了 ${files} 个文件` : ''}${restored ? '，原文已放回输入框' : '（没能自动写回输入框，请用「复制原文」）'}`
      // 已经点过 × 的会话：只留一条会自动消失的回执，不再挂出计数器。
      setNotice(text, isBarDismissed(sessionId) ? 4000 : 8000)
      bump()
      scheduleDom()
    }

    /* ───────────────────── 把原文写回输入框 ───────────────────── */

    function composerEditor() {
      const scopes = [
        '[data-slot="conversation.composer.bar"]',
        '[data-slot="conversation.composer"]',
        '[data-chat-flow]',
      ]
      for (const scope of scopes) {
        const host = document.querySelector(scope)
        if (host === null) continue
        const editor = host.querySelector('[contenteditable="true"]')
        if (editor !== null) return editor
      }
      const main = document.querySelector('main') ?? document.body
      return main.querySelector('[contenteditable="true"]')
    }

    /**
     * 组合框是 Lexical 富文本编辑器，没有对外的写入口，只能模拟真实输入。
     * 依次尝试 execCommand → 合成 paste → 合成 beforeinput，任一成功即返回。
     */
    function restoreDraft(text) {
      if (typeof text !== 'string' || text === '') return false
      const editor = composerEditor()
      if (editor === null) return false
      try {
        editor.focus()
        const selection = window.getSelection()
        if (selection !== null) {
          selection.selectAllChildren(editor)
          selection.collapseToEnd()
        }
      } catch { /* 焦点失败也继续试 */ }
      try {
        if (document.execCommand('insertText', false, text)) return true
      } catch { /* 继续 */ }
      try {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
        editor.dispatchEvent(event)
        return true
      } catch { /* 继续 */ }
      try {
        const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
        editor.dispatchEvent(event)
        return true
      } catch { return false }
    }

    async function copyText(text) {
      if (text === '') return
      try {
        await navigator.clipboard.writeText(text)
        setNotice('已复制', 2000)
      } catch { setNotice('复制失败，请手动选中', 3000) }
    }

    /* ───────────────────── DOM 观察层 ───────────────────── */

    let scheduled = false
    function scheduleDom() {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => { scheduled = false; void syncDom() })
    }

    let syncCtx = null
    async function syncDom() {
      const ctx = syncCtx
      if (ctx === null) return
      const flow = document.querySelector('[data-chat-flow]')

      if (flow !== null) {
        for (const row of flow.querySelectorAll('[data-chat-flow-kind="user"]')) {
          ensureActionButton(ctx, row, (target) => {
            const messageId = messageIdOf(target)
            return messageId === null ? null : { messageId }
          })
        }
        applyHiding(flow)
      }

      // 排队中的气泡渲染在对话流之外（没有 data-chat-flow-kind），DOM 上也不带
      // message id，所以用气泡原文当选择子，交给 Host 在自己的 inbox 里精确配对。
      let pending = false
      for (const row of document.querySelectorAll(PENDING_SELECTOR)) {
        pending = true
        ensureActionButton(ctx, row, (target) => {
          const text = bubbleTextOf(target)
          return text === '' ? null : { pendingText: text }
        })
      }
      if (pending !== pendingInDom) { pendingInDom = pending; bump() }

      // 工具行按钮的目标 = 最后一条仍然可见的 user 消息。被撤回的行还在 DOM
      // 里（只是被 CSS 收起），必须排除，否则「撤回上一条」会指向已撤回的那条。
      const rows = flow === null ? [] : [...flow.querySelectorAll('[data-chat-flow-kind="user"]')]
      const visible = rows.filter((row) => !row.hasAttribute(HIDDEN_ATTR))
      const next = visible.length > 0 ? messageIdOf(visible[visible.length - 1]) : null
      if (next !== lastUserId) { lastUserId = next; bump() }
    }

    let lastUserId = null

    /* ───────────────────── 组件 ───────────────────── */

    /**
     * 撤回前的确认弹窗。Host 已经算好「会撤掉哪几轮、改了哪些文件、执行过哪些
     * 不可撤销的操作」，这里只负责让用户看着清单点头，以及决定要不要恢复文件。
     */
    function RecallDialog() {
      useShared()
      if (dialog === null) return null
      const { preview, restoreFiles, busy, error } = dialog
      const close = () => { if (busy) return; dialog = null; bump() }
      const confirm = () => {
        if (busy) return
        const selector = dialog.selector
        dialog = { ...dialog, busy: true, error: null }
        bump()
        void doRecall(syncCtx, selector, restoreFiles)
      }
      const toggleRestore = () => {
        if (busy) return
        dialog = { ...dialog, restoreFiles: !restoreFiles, error: null }
        bump()
      }

      const blocked = preview.blocked
      const files = preview.files ?? []
      const effects = Object.entries(preview.toolCalls ?? {}).sort((left, right) => right[1] - left[1])
      const body = []

      if (blocked !== null) {
        body.push(h('p', { key: 'blocked' }, blocked.message))
      } else {
        body.push(h('p', { key: 'range' }, `将撤回第 ${preview.startTurn}–${preview.endTurn} 轮对话：模型从此看不到这一段，界面也会把它收起来。`))

        if (files.length > 0) {
          body.push(h('label', { key: 'restore', 'data-dsh-recall-check': '', onClick: (event) => { event.preventDefault(); toggleRestore() } },
            h('input', { type: 'checkbox', checked: restoreFiles, readOnly: true }),
            ` 把这些文件恢复到这一轮之前（${files.length}）`))
          body.push(h('ul', { key: 'files' }, files.map((file, index) => h('li', { key: `${file.display}:${index}` },
            h('span', { 'data-dsh-recall-file': '' }, file.display),
            file.binary || file.oversized
              ? h('span', { className: 'num' }, '二进制/超大，不可恢复')
              : h('span', { className: 'num' }, `+${file.added} −${file.deleted}`)))))
        } else {
          body.push(h('p', { key: 'nofile', className: 'muted' }, '这一轮没有录到文件改动。'))
        }

        if (effects.length > 0) {
          body.push(h('div', { key: 'effects' },
            h('p', { className: 'muted' }, '这一段里执行过这些操作，撤回无法撤销它们：'),
            h('ul', null, effects.slice(0, 12).map(([name, count]) => h('li', { key: name },
              h('span', { 'data-dsh-recall-file': '' }, name),
              h('span', { className: 'num' }, `×${count}`)))),
            effects.length > 12 ? h('p', { className: 'muted' }, `…另有 ${effects.length - 12} 种`) : null))
        }

        body.push(h('div', { key: 'warn', 'data-dsh-recall-warn': '' },
          'bash / pwsh 的副作用、网络请求、外部服务和数据库写入都不在记录范围内。'
          + (restoreFiles && files.length > 0 ? ' 恢复文件会覆盖它们当前的内容，包括你之后的修改。' : '')))

        if (error !== null) {
          const failed = error.details?.failed ?? []
          body.push(h('div', { key: 'error', 'data-dsh-recall-error': '' },
            h('p', null, error.message),
            failed.length === 0 ? null : h('ul', null, failed.slice(0, 8).map((item) => h('li', { key: item.display },
              h('span', { 'data-dsh-recall-file': '' }, item.display),
              h('span', { className: 'num' }, item.reason))))))
        }
      }

      const actions = blocked !== null
        ? [h('button', { key: 'close', type: 'button', style: buttonStyle, onClick: close }, '知道了')]
        : [
            h('button', { key: 'cancel', type: 'button', style: buttonStyle, onClick: close, disabled: busy }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              'data-dsh-recall-confirm': '',
              style: { ...buttonStyle, ...primaryStyle, opacity: busy ? 0.6 : 1 },
              onClick: confirm,
              disabled: busy,
            }, busy ? '撤回中…' : '确认撤回'),
          ]

      return h('div', {
        'data-dsh-recall-overlay': '',
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
      }, h('div', { 'data-dsh-recall-dialog': '', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, blocked !== null ? '无法撤回' : '撤回这一段对话？'),
        ...body,
        h('div', { key: 'actions', 'data-dsh-recall-actions': '' }, actions)))
    }

    function RecallBar({ sessionId: id, t }) {
      useShared()
      const dismissed = isBarDismissed(id)
      const count = ranges.length
      const copyable = lastText !== '' ? lastText : (ranges.length > 0 ? ranges[ranges.length - 1].text ?? '' : '')

      if (dismissed) {
        // 「永久接受」之后这个会话不再挂计数器；只有刚撤回完的那一下留一条
        // 会自动消失的回执，否则用户点完什么都看不到。
        if (notice === null) return null
        return React.createElement('div', { 'data-dsh-recall-bar': '', style: barStyle }, notice)
      }

      if (count === 0 && notice === null) return null
      const children = []
      if (notice !== null) {
        children.push(React.createElement('span', { key: 'notice' }, notice))
      }
      if (count > 0) {
        children.push(React.createElement('span', { key: 'count', style: { color: 'var(--dsw-alias-label-tertiary)' } }, `本会话已撤回 ${count} 处对话`))
        children.push(React.createElement('button', {
          key: 'toggle',
          type: 'button',
          style: linkStyle,
          onClick: () => { revealing = !revealing; bump(); scheduleDom() },
        }, revealing ? '隐藏' : '显示'))
        if (copyable !== '') {
          children.push(React.createElement('button', {
            key: 'copy',
            type: 'button',
            style: linkStyle,
            onClick: () => { void copyText(copyable) },
          }, '复制原文'))
        }
      }
      children.push(React.createElement('span', { key: 'spacer', style: { flex: 1 } }))
      children.push(React.createElement('button', {
        key: 'dismiss',
        type: 'button',
        'data-dsh-recall-dismiss': '',
        'aria-label': '知道了，以后不再提示',
        title: '知道了，这个会话以后不再提示',
        style: { ...linkStyle, fontSize: 14, lineHeight: 1, padding: '0 4px' },
        onClick: () => {
          if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null }
          notice = null
          dismissBar(id)
          bump()
        },
      }, '×'))
      return React.createElement('div', { 'data-dsh-recall-bar': '', style: barStyle, title: copyable }, children)
    }

    function RecallLastButton({ sessionId: id, t }) {
      useShared()
      const enabled = pendingInDom || lastUserId !== null
      const [busy, setBusy] = React.useState(false)
      const label = busy ? '撤回中…' : (pendingInDom ? '撤回排队中' : '撤回上一条')
      return React.createElement('button', {
        type: 'button',
        'data-dsh-recall-last': '',
        disabled: !enabled || busy,
        title: pendingInDom ? '撤回还没开始跑的那条消息，原文放回输入框' : '撤回你刚发出的那条消息，原文放回输入框',
        style: {
          ...buttonStyle,
          opacity: enabled ? 1 : 0.4,
          cursor: enabled ? 'pointer' : 'default',
        },
        onClick: async () => {
          if (!enabled) return
          setBusy(true)
          try {
            // 界面里有排队气泡时只发 lastOne：Host 有排队消息就摘排队的那条，
            // 没有就报错。此时绝不能附带 lastMessageId——那会退回去把上一条
            // 已进日志的消息撤掉，而用户想撤的是刚发的那条。
            await askRecall(syncCtx, pendingInDom
              ? { lastOne: true }
              : { lastOne: true, ...(lastUserId === null ? {} : { lastMessageId: lastUserId }) })
          } finally { setBusy(false) }
        },
      }, label)
    }

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: 28,
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 14,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
    }

    const primaryStyle = {
      background: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4c9aff))',
      borderColor: 'transparent',
      color: 'var(--dsw-alias-label-on-business, #ffffff)',
      fontWeight: 600,
    }

    const linkStyle = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary, var(--dsw-alias-text-accent))',
      cursor: 'pointer',
      padding: '0 2px',
      fontSize: 12,
    }

    const barStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '6px 10px',
      margin: '0 0 6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
    }

    /* ───────────────────── 样式 ───────────────────── */

    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
/* 撤回按钮是消息操作条的一个子项：与复制按钮同排、同高、同一套 hover 反馈。 */
[data-dsh-recall-action] {
  width: 28px; height: 28px; padding: 6px; border: none; border-radius: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary); background: transparent; cursor: pointer;
  transition: background .18s ease, color .18s ease;
}
[data-dsh-recall-action]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-recall-action]:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, currentColor);
  outline-offset: 1px;
}
[data-dsh-recall-action] svg { width: 16px; height: 16px; display: block; }
[data-dsh-recall-overlay] {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .28);
}
[data-dsh-recall-dialog] {
  width: min(560px, calc(100vw - 48px));
  max-height: calc(100vh - 96px); overflow: auto;
  padding: 20px 20px 16px; border-radius: 14px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, .28));
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.7;
}
[data-dsh-recall-dialog] h2 { margin: 0 0 10px; font-size: 16px; font-weight: 650; }
[data-dsh-recall-dialog] p { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); }
[data-dsh-recall-dialog] p.muted { color: var(--dsw-alias-label-tertiary); }
[data-dsh-recall-dialog] ul { margin: 4px 0 10px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
[data-dsh-recall-dialog] li { display: flex; gap: 10px; align-items: baseline; color: var(--dsw-alias-label-secondary); min-width: 0; }
[data-dsh-recall-file] {
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[data-dsh-recall-dialog] .num {
  margin-left: auto; flex: none; font-size: 12px;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary);
}
[data-dsh-recall-check] { display: flex; align-items: center; gap: 6px; margin: 2px 0 6px; cursor: pointer; }
[data-dsh-recall-warn] {
  margin: 8px 0 0; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 12px;
}
[data-dsh-recall-error] { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
[data-dsh-recall-error] p { color: var(--dsw-alias-state-error-primary, #dc2626); margin: 0 0 6px; }
[data-dsh-recall-actions] { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
[${HIDDEN_ATTR}] { display: none !important; }
`
      document.head.appendChild(style)
    }

    /* ───────────────────── apply ───────────────────── */

    function apply(ctx) {
      syncCtx = ctx

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-recall: dictionaries')

      // 「撤回上一条」：输入框工具行左侧。
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-recall-last',
        order: 50,
        locale: NS,
        inject: (id) => {
          if (typeof id === 'string') sessionId = id
          return { sessionId: id }
        },
      }, RecallLastButton)), 'dsh-recall: composer button')

      // 撤回状态提示条：输入框上方整行。
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-recall-bar',
        order: 50,
        locale: NS,
        inject: (id) => {
          if (typeof id === 'string') sessionId = id
          return { sessionId: id }
        },
      }, RecallBar)), 'dsh-recall: recall bar')

      // 撤回确认弹窗：整屏遮罩，所以挂在 shell.overlay 上。
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-recall-dialog',
        order: 200,
      }, RecallDialog)), 'dsh-recall: confirm dialog')

      // DOM 层：按钮注入 + 收起已撤回的行。
      ctx.effect(() => {
        installStyle()
        const observer = new MutationObserver(() => scheduleDom())
        observer.observe(document.body, { childList: true, subtree: true })
        scheduleDom()
        return () => {
          observer.disconnect()
          document.getElementById(STYLE_ID)?.remove()
          for (const node of document.querySelectorAll('[data-dsh-recall-action]')) node.remove()
        }
      }, 'dsh-recall: dom layer')

      // 会话切换时同步一次权威状态。
      ctx.effect(() => {
        let stopped = false
        let seen = null
        const tick = async () => {
          if (stopped) return
          if (sessionId !== null && sessionId !== seen) {
            seen = sessionId
            ranges = []
            lastText = ''
            bump()
            const result = await rpc(ctx, 'state', { sessionId })
            if (result.ok === true && !stopped && sessionId === seen) {
              ranges = Array.isArray(result.value.ranges) ? result.value.ranges : []
              bump()
              scheduleDom()
            }
          }
          timer = setTimeout(tick, 1500)
        }
        let timer = setTimeout(tick, 300)
        return () => { stopped = true; clearTimeout(timer) }
      }, 'dsh-recall: session state sync')
    }

    exports.name = 'dsh-recall-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
