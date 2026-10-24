# dsh-recall · 消息撤回

撤回会话里的一条消息——打错字、没打完就误按回车的时候，把它收回。

## 它做了什么

点「撤回」之后：

1. **模型真的忘记它。** 会话日志是仅追加的，删不掉记录；撤回用的是 Harness
   自己的表层替换机制：追加一条空内容的 `system/message`，带
   `surfaceOp: { op: 'replace', startSeq, endSeq }`，把从那条消息到当前对话末尾
   的整段模型可见历史遮蔽掉。空内容的 system 节点不投影成消息，所以下一轮请求
   里这段上下文彻底消失。
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
- 组合框是 Lexical 富文本编辑器，没有对外的写入口；写回原文靠模拟真实输入
  （`execCommand` → 合成 paste → 合成 beforeinput）。全部失败时提示条上的
  「复制原文」仍可用。
