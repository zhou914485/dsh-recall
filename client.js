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
        return { ok: false, message: body?.error?.message ?? 'unknown failure' }
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

    function ensureRowButton(ctx, row) {
      if (row.querySelector('[data-dsh-recall-actions]') !== null) return
      const messageId = messageIdOf(row)
      if (messageId === null) return
      const holder = document.createElement('div')
      holder.setAttribute('data-dsh-recall-actions', '')
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-dsh-recall-button', '')
      button.textContent = '撤回'
      button.title = '撤回这条消息（模型也会忘记它）'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void doRecall(ctx, { messageId })
      })
      holder.appendChild(button)
      row.appendChild(holder)
    }

    /* ───────────────────── 撤回动作 ───────────────────── */

    async function doRecall(ctx, selector) {
      if (sessionId === null) { setNotice('没有打开的会话', 3000); return }
      setNotice('撤回中…')
      const result = await rpc(ctx, 'recall', { sessionId, ...selector })
      if (result.ok !== true) {
        setNotice(`撤回失败：${result.message}`, 6000)
        return
      }
      const value = result.value
      ranges = Array.isArray(value.ranges) ? value.ranges : ranges
      lastText = value.recalled?.text ?? ''
      revealing = false
      const restored = restoreDraft(lastText)
      setNotice(restored ? '已撤回，原文已放回输入框' : '已撤回（没能自动写回输入框，请用「复制原文」）', 8000)
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
      if (flow === null) return
      const rows = [...flow.querySelectorAll('[data-chat-flow-kind="user"]')]
      for (const row of rows) ensureRowButton(ctx, row)
      applyHiding(flow)
      // 工具行按钮的目标 = 最后一条仍然可见的 user 消息。被撤回的行还在 DOM
      // 里（只是被 CSS 收起），必须排除，否则「撤回上一条」会指向已撤回的那条。
      const visible = rows.filter((row) => !row.hasAttribute(HIDDEN_ATTR))
      const next = visible.length > 0 ? messageIdOf(visible[visible.length - 1]) : null
      if (next !== lastUserId) { lastUserId = next; bump() }
    }

    let lastUserId = null

    /* ───────────────────── 组件 ───────────────────── */

    function RecallBar({ sessionId: id, t }) {
      useShared()
      const count = ranges.length
      if (count === 0 && notice === null) return null
      const children = []
      if (notice !== null) {
        children.push(React.createElement('span', { key: 'notice', style: { color: 'var(--dsw-alias-label-secondary)' } }, notice))
      }
      if (count > 0) {
        children.push(React.createElement('span', { key: 'count', style: { color: 'var(--dsw-alias-label-tertiary)' } }, `本会话已撤回 ${count} 处对话`))
        children.push(React.createElement('button', {
          key: 'toggle',
          type: 'button',
          style: linkStyle,
          onClick: () => { revealing = !revealing; bump(); scheduleDom() },
        }, revealing ? '隐藏' : '显示'))
        if (lastText !== '') {
          children.push(React.createElement('button', {
            key: 'copy',
            type: 'button',
            style: linkStyle,
            onClick: () => { void copyText(lastText) },
          }, '复制原文'))
        }
      }
      return React.createElement('div', { 'data-dsh-recall-bar': '', style: barStyle, title: lastText }, children)
    }

    function RecallLastButton({ sessionId: id, t }) {
      useShared()
      const enabled = lastUserId !== null
      const [busy, setBusy] = React.useState(false)
      return React.createElement('button', {
        type: 'button',
        'data-dsh-recall-last': '',
        disabled: !enabled || busy,
        title: '撤回你刚发出的那条消息，原文放回输入框',
        style: {
          ...buttonStyle,
          opacity: enabled ? 1 : 0.4,
          cursor: enabled ? 'pointer' : 'default',
        },
        onClick: async () => {
          if (lastUserId === null) return
          setBusy(true)
          try { await doRecall(syncCtx, { messageId: lastUserId }) }
          finally { setBusy(false) }
        },
      }, busy ? '撤回中…' : '撤回上一条')
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
[data-chat-flow-kind="user"] { position: relative; }
[data-dsh-recall-actions] {
  position: absolute; top: 2px; right: 4px; z-index: 6;
  opacity: 0; pointer-events: none; transition: opacity .12s ease;
}
[data-chat-flow-kind="user"]:hover [data-dsh-recall-actions] { opacity: 1; pointer-events: auto; }
@media (hover: none) { [data-dsh-recall-actions] { opacity: 1; pointer-events: auto; } }
[data-dsh-recall-button] {
  font: inherit; font-size: 12px; line-height: 1;
  padding: 4px 8px; border-radius: 999px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
[data-dsh-recall-button]:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
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

      // DOM 层：按钮注入 + 收起已撤回的行。
      ctx.effect(() => {
        installStyle()
        const observer = new MutationObserver(() => scheduleDom())
        observer.observe(document.body, { childList: true, subtree: true })
        scheduleDom()
        return () => {
          observer.disconnect()
          document.getElementById(STYLE_ID)?.remove()
          for (const node of document.querySelectorAll('[data-dsh-recall-actions]')) node.remove()
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
