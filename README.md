# dsh-recall · 消息撤回

撤回会话里的一条消息——打错字、没打完就误按回车的时候，把它收回。

## 撤回前的闸门：有改动清单才允许撤回

撤回只改变模型看到什么，**不会**自动撤销这一轮已经发生的事。为了不让「对话被抹掉、文件已改过」这种状态悄悄发生，撤回前 Host 先做一次检查（`preview` 端点）：

- 这一段覆盖了哪些回合；
- 每轮结束时的 `workspace/changes` 事件，以及 `workspaceChanges.summary()` 给出的改动文件清单；
- 这一段里执行过的工具调用（bash / pwsh / web / mcp / subagent…），这些是撤回撤不掉的。

| 情况 | 结果 |
|---|---|
| 没有录到任何文件改动 | 允许撤回 |
| 有改动，且改动清单取得到 | 允许撤回，弹窗列出文件与副作用，由用户决定是否恢复文件 |
| 有改动，但清单取不到（重启后内存丢失） | **拒绝撤回**，说明原因 |
| 有文件写入，但清单还没生成 | **拒绝撤回** |

清单来自 `@deepseek-ai/dsh-workspace-changes`：摘要只放在 Host 内存、对比放在会话临时目录——进程一重启就没了。所以「刚重启完的会话不允许撤回改过文件的回合」是刻意的：宁可拒绝，也不假装那一轮没发生。

## 文件恢复

用户勾选「恢复这些文件」时，Host 逐个文件按 `workspaceChanges.diff()` 的 hunks **反向应用**：

- 改过的文件 → 写回改前内容；
- 这一轮新建的文件 → 删除（删除前校验路径必须在会话工作区内）；
- 这一轮删掉的文件 → 用 hunks 里被删掉的行重建；
- 当前内容已被后续改动、对不上 hunk 的 after 侧 → 冲突，**整个撤回放弃**，一个文件都不写、墓碑也不写。

`bash`/`pwsh` 的副作用、网络请求、外部服务、数据库写入不在记录范围内；弹窗会照实列出这一段执行过哪些工具调用，并说明它们不可撤销。

## 它做了什么

点「撤回」之后：

1. **模型真的忘记它。** 会话日志是仅追加的，删不掉记录；撤回用的是 Harness
   自己的表层替换机制：追加一条空内容的 `system/message`，带
   `surfaceOp: { op: 'replace', startSeq, endSeq }`，把从那条消息到当前对话末尾
   的整段模型可见历史遮蔽掉。空内容的 system 节点不投影成消息，所以下一轮请求
   里这段上下文彻底消失。

   墓碑是 **step 级事件**：格式校验要求 `system/message` 落在打开的 step 里。
   中止过的回合已经 `step/end` + `turn/end`，这时直接写入会让整条日志再也读
   不出来（`stored log is corrupt: system/message does not match an open turn and
   step`）。所以回合结束时撤回**先挂起**：下一次 `step/start`（也就是你发出下
   一条消息、或会话继续跑）到来时，才用那一步的坐标补写，遮蔽范围仍是原来算好
   的 `[startSeq, endSeq]`。界面立刻把那一行收起来，模型则在下一步开始前忘掉它。
2. **界面把它收起来。** 客户端按撤回范围对应的回合区间，把那些对话行
   `display:none`，并在输入框上方显示一条可展开/可复制的「已撤回」提示条。
3. **原文回到输入框。** 撤回目标的文本会被写回组合框，改完直接重发。

撤回范围一律是**从目标消息到当前对话末尾**。撤回一条中间消息却保留它之后的
对话，会让后面的内容引用一段已经不存在的上下文；网页版 DeepSeek 删除一条消息
也是这个行为。

## 用法

- **每条 user 消息**：鼠标悬停在消息上，右上角出现「撤回」。
- **刚发出的那条**：输入框工具行左侧的「撤回上一条」，原文自动放回输入框。
- 正在生成时撤回也没问题：会先停掉当前回合并清空排队输入，再写墓碑。

## 测试

```bash
node test/defer.test.mjs
```

覆盖「回合结束后挂起、下一次 step/start 补写、step 开着时立即写、冷会话拒绝」
四条路径，并用最小结构校验确认写出来的日志仍然可读。

## 安装

插件是一个 DSH bundle：`cordis.patch.yml` 插入一行 Host 组件（RPC 通道），界面逻辑全在
`client.js`（浏览器侧）。

```bash
git clone https://github.com/zhou914485/dsh-recall.git
```

装进 DSH 有两种方式：

- **推荐**：让 DSH 的 `plugin_manager` 执行 `install_bundle`，target 指向这个插件目录。
- **手动**：改 profile 的 `package.json`（Windows 下是 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`）：

  1. `dependencies` 加一行 `"@local/dsh-recall": "link:<插件目录绝对路径>"`
  2. `dsh.profile.bundles` 数组加 `"@local/dsh-recall"`
  3. 在 profile 的 `node_modules/@local/` 下建一个指向插件目录的链接（junction / symlink）

改完**重启 DSH** 生效。插件没有配置项。

## 实现要点

| 文件 | 职责 |
|---|---|
| `index.js` | Host half：`/dsh-recall` RPC 通道；`state` / `recall` 两个端点；表层折叠、墓碑构造、live 与冷会话两条写入路径 |
| `client.js` | Client half：user 行的撤回按钮、工具行按钮、已撤回行收起、提示条、原文写回 |
| `cordis.patch.yml` | 插入 Host 行 |

- 墓碑消息 id 前缀 `recall:` 是客户端识别「这条替换是撤回」的唯一依据（系统提示词
  的清空替换同样是空内容 `system/message`）。
- 不引入任何新的 session 事件类型：新类型需要 `ignorable` 标记，而 live 的
  `Session.append()` 设不了它，会话将无法重开。
- 不使用 `@deepseek-ai/dsh-client-ui-primitives`，只依赖 `react` 与 `--dsw-alias-*`
  主题变量。

## 已知边界

- 排队中（还没进入日志）的消息不在表层里，撤回按钮看不到它；这类消息属于
  `session.updateQueue` / `agent.inbox` 的管辖范围。
- 撤回是「截断到末尾」，没有单条删除后保留后续对话的模式。
- 回合已结束时的撤回是挂起的，墓碑要等下一次 `step/start` 才落盘。如果会话在
  那之前关闭或 Host 重启，挂起的撤回作废（只有内存记录），那条消息会重新出现。
- 冷会话（没有 live Agent）如果日志停在回合边界，撤回会被拒绝并提示原因：没有
  下一次 `step/start` 可以挂靠，写进去就是坏日志。
- 组合框是 Lexical 富文本编辑器，没有对外的写入口；写回原文靠模拟真实输入
  （`execCommand` → 合成 paste → 合成 beforeinput）。全部失败时提示条上的
  「复制原文」仍可用。
