# `remote.session.list` 契约（0.2.1 面板绑定已有会话用）

> 结论来自**已安装运行时的源码**，不是猜测。证据路径基于本机全局安装：
> `C:\Users\UEFR\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
> 相关包：`dsh-api-session-controller`、`dsh-session-query`、`dsh-api-remotes`。

## 1. 调用形状

```js
const { ok, value } = await remote.session.list({});   // 无参数也行：list({})
// ok === true 时：value = { items: SessionSummary[] }
```

- **请求**：`SessionListRequest = { cursor?: string }`（`types/types.d.ts:262`）。
- **响应**：`SessionListValue = { items: SessionSummary[] }`（`types/types.d.ts:266`）。
- **没有 `sessions`、没有 `hasMore`、没有 `nextCursor`**：列表是**单页**返回；`cursor` 当前实现不消费（与 `session.search` 不同，search 才有 `hasMore`）。

## 2. `SessionSummary` 字段（`types/types.d.ts:159`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 会话 id，`session.follow` 用它 |
| `updatedAt` | `number` | 毫秒时间戳，排序依据 |
| `running` | `boolean` | 当前是否有回合在跑 |
| `agentAvailable` | `boolean` | 是否挂着 live Agent |
| `blank` | `boolean` | 空会话（从未产生事件） |
| `parentSessionId?` | `string` | 子会话的父 id（嵌套/分支） |
| `origin?` | `'subagent'` | 仅子代理会话出现 |
| `cwd?` | `string` | 该会话工作目录 |
| `projections?` | `{ kind: 'cached'\|'sequenced', asOfSeq: number, values }` | 投影块 |

**标题不在顶层**：标题是投影值 `summary.projections.values.title`，类型 `string | null` 且**可选**（`types/types.d.ts` 中 `title: z.union([z.literal(null), z.string()]).optional()`）。取不到就是没有标题，不要编。

`projections.kind` 语义（`types/types.d.ts`）：
- `sequenced`：Host 侧 live 注册表产出的块，`asOfSeq` 与同连接的 baseline/frame 可比；
- `cached`：从持久化投影缓存读到的冷会话块，`asOfSeq` 只是该记录自己的水位，不可与在线连接比较。

## 3. 过滤与排序（实现证据）

`dsh-api-session-controller/lib/types/list.js:104`：

```js
async list(signal) {
  const records = await this.ctx.sessionQuery.listSessions(signal);
  for (const record of records) {
    const live = this.ctx.sessions.get(record.header.id);
    if (live !== undefined) { items.push(this.summaryFor(live)); continue; }
    if (record.header.cwd === undefined) continue;   // ← 冷会话没有 cwd 的直接不返回
    cold.push(record.header);
  }
  items.sort((left, right) => right.updatedAt - left.updatedAt);   // ← 按活动时间倒序
  return items;
}
```

- **在线会话**全部返回；
- **冷会话**（没有 live Agent 的持久化会话）**只有在 header 带 `cwd` 时**才返回；
- 顺序固定：`updatedAt` 倒序，不做二次排序。

## 4. 作用域与权限

- 数据来源是 `ctx.sessionQuery.listSessions()`（`dsh-session-query/lib/index.js:95`）：它把**本实例持久化存储里的会话**（`listPersisted(persistence)`）与本实例 `ctx.sessions.list()` 的在线会话合并。**没有按 cwd / workspace 过滤**；`cwd` 只是返回字段。
  - 所以第三方客户端插件看到的是**这个 DSH 实例（这个 profile）的全部可见会话**，不是“只看到自己创建的会话”。
- `dsh-api-remotes` 里**没有按 namespace 的方法级 ACL**；只有“转发 Host 事件”的白名单（`index.js` 注释）。官方 UI 和第三方插件拿到的是同一个 `remote.session` 命名空间对象（图片插件现在就在用 `remote.session.create/follow`）。
  - 访问边界是**客户端连接本身**（同源页面 + `/media-image/boot` 的 per-process token），不是方法级授权。
- 结论：面板可以列到本实例的会话；**跨 workspace 隔离由“不同实例/profile”保证，不是由这个接口保证**。若以后同一 Host 承载多 workspace，需要重新评估。

## 5. 前端应采用的严格解析

```js
// 只接受契约形状；不匹配就明确报错，不要静默退回“只能新建”。
if (!result?.ok) throw new Error(result?.error?.message || 'session.list 失败');
const items = result.value?.items;
if (!Array.isArray(items)) throw new Error('session.list 返回结构不符合契约：缺少 items 数组');
const rows = items.map(item => ({
  sessionId: item.sessionId,
  title: item.projections?.values?.title ?? null,
  updatedAt: item.updatedAt,
  running: item.running,
  agentAvailable: item.agentAvailable,
  blank: item.blank,
  cwd: item.cwd ?? null,
})).filter(row => typeof row.sessionId === 'string' && row.sessionId);
```

- 没有标题就显示「未命名会话 · R{updatedAt}」，不要伪造标题；
- `blank: true` 的会话可以列，但建议标「空会话」；
- `running: true` 的会话可以挂接，但先提示“该会话有回合在跑”；
- **不要**用 `sessions` / `items.data` / `hasMore` 这些猜测字段名——契约里没有。

## 6. 尚未验证的部分（不要当作已确认）

- `cursor` 的真实行为（当前 `list()` 完全忽略它；若 Host 以后实现分页，响应形状需要新增字段）；
- `projections` 对**刚创建、从未持久化**的会话是否一定存在（拿不到时按“无标题”处理即可）；
- 多 workspace 单实例部署下的隔离语义（当前实现无过滤，见 §4）；
- 这些结论来自本机安装的 `dsh` 包版本；升级宿主后应重跑一次核对。

## 7. 复核命令

```powershell
$base = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
Select-String -Path "$base\dsh-api-session-controller\lib\types\types.d.ts" -Pattern "interface SessionSummary" -Context 0,20
Select-String -Path "$base\dsh-api-session-controller\lib\types\list.js" -Pattern "async list" -Context 0,20
Select-String -Path "$base\dsh-session-query\lib\index.js" -Pattern "async listSessions" -Context 0,20
```
