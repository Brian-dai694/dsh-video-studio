# 会话事件形状（`tool/call` / `tool/result` / `approval/*`）

> 依据本机已安装运行时的类型定义（源码位置逐条给出）。**找不到明确出处的字段一律标 UNKNOWN，不编。**
> 基路径：`C:\Users\UEFR\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

## 0. 一条重要区分：事件 ≠ 工具输出（已按抓包修正）

> **修正（2026-11-05，依据 FDE 抓包原文）**：本节此前写成“状态在 `message.content` 的文本 JSON 里”，**这是错的**。
> 真实回执里 `message.content[0].text` 只有一行人类可读文本（例：`applied · fde-acceptance-addtext-001 · R1`），
> **状态在 `data.meta.status`**（四态），凭据也在 `meta` 里（后端 0.2.1 起补：`commandId/appliedRevision/afterDigest/exportId/artifactRef/format/errorCode`）。

顶层的真实形状（抓包原文）：

```json
{ "type": "...", "seq": 28, "time": "...", "data": { "turn": ..., "step": ..., "message": {...}, "meta": {...} }, "sourceEventSeqs": [...], "surfaceOp": ... }
```

- **没有 `{ok, value}` 外层**（此前标 UNKNOWN 的第 2 条，现据抓包确认：不存在）。
- `message.isError` **不能当失败判据**：抓包里那条 `REVISION_CONFLICT` 的 `isError` 是 `false`，而 `meta.status` 是 `rejected`。
  判定顺序：`meta.status` → `meta.errorCode` → `isError` 兜底。

面板要读两层：会话事件载荷（§1/§2）与 `data.meta`。`message.content` 只用于人类可读展示。

## 1. `tool/call`（`dsh-session/lib/types/types.d.ts:354`）

```ts
'tool/call': {
  turn: number;
  step: number;
  callId: ToolCallId;   // 与 tool/result 配对
  name: string;         // ← 工具名在这一层，不在 call.toolName
  arguments: string;    // ← 参数是 JSON 字符串
};
```

- 工具名：**`name`**。
- 参数：**`arguments`**（字符串，需要自行 `JSON.parse`）。
- 没有 `toolName`、没有 `call` 子对象。

## 2. `tool/result`（`dsh-session/lib/types/types.d.ts:374`）

```ts
'tool/result': {
  turn: number;
  step: number;
  message: ToolResultMessage;
  error?: { name: string; code: string; reason?: string };
  meta?: JsonValue;     // 工具私有展示数据，形状由工具自己决定
};
```

`ToolResultMessage`（`dsh-llm/lib/types/message.d.ts:153`）：

```ts
interface ToolResultMessage extends MessageBase {
  readonly role: 'tool';
  readonly source: ToolMessageSource;
  readonly toolCallId: ToolCallId;   // 对应 tool/call 的 callId
  readonly isError?: boolean;        // ← 失败与否在这一层
  // 以及来自 MessageBase 的 content: ContentBlock[]
}
```

- **失败判定**：**先看 `data.meta.status`**（`rejected` 即“未执行”），再看 `data.meta.errorCode`（如 `REVISION_CONFLICT`）；
  `message.isError` 只作兜底——抓包证实 rejected 那条的 `isError` 是 `false`。
- **没有顶层 `status` 字段**：四态在 `data.meta.status`；`pending` 表示“有 `tool/call` 但还没有配对的 `tool/result`”。
- `revision` / `commandId` / `afterDigest` / `exportId` / `artifactRef` / `format`：在 **`data.meta`**（后端 0.2.1 起补），不在 `message.content` 文本里。

## 3. `approval/asked`（`dsh-user-approval/lib/types/types.d.ts:37`）

```ts
'approval/asked': {
  id: ApprovalRequestId;
  toolName: string;
  callId?: ToolCallId;
  reason?: string;
};
```

## 4. `approval/decided`（同文件 `:48`）

```ts
'approval/decided': {
  id: ApprovalRequestId;
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
};
```

- `id` 与 `asked` 配对；`outcome` 是**封闭四值**（`:24`）。
- 没有 `scope` 字段；没有“允许/拒绝”的提交入口（本包只有审计事件，见 `dialog-and-symbiosis-v1.md`）。

## 5. UNKNOWN（源码里没有找到明确出处，不要当已知）

- **会话事件的外层信封**（`seq` / `time` / `type` 等包装字段）的确切定义：本机类型里只有 `SessionEventMap` 的载荷（`types.d.ts:255` 起），
  信封类型没在这几份 `.d.ts` 里定位到 —— **标 UNKNOWN**，以 FDE 抓的原文为准。
- 第三方客户端订阅 `remote.session.follow` 时，帧对象外面是否再包 `{ok, value}`：**已确认不存在**（抓包顶层为 `{type, seq, time, data, sourceEventSeqs, surfaceOp}`）。
- `approval/asked` 的“作用域/对象”（例如它针对哪个文档或工程）：**UNKNOWN**，事件里只有 `toolName` / `callId` / `reason`。

## 6. 对面板解析的直接建议

1. 先按事件的显式路径取：`tool/call.name`、`tool/result.message.isError`、`tool/result.error.code`；
2. 工具输出：`tool/result.message.content` 里的文本块 → `JSON.parse` → 取 `status/commandId/revision/afterDigest/exportId/artifactRef`；
   解析失败**不要**猜状态，按“无法解析摘要”兜底；
3. `pending` 只由“缺配对 `tool/result`”推出，**不要**把“解析不到”当 `unknown`；
4. 审批：`approval/asked.id` 配 `approval/decided.id`，`outcome` 四值直接映射徽标，`unavailable` ≠ “你拒绝了”。

## 7. 复核命令

```powershell
$base = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
Select-String -Path "$base\dsh-session\lib\types\types.d.ts" -Pattern "'tool/call'|'tool/result'" -Context 0,12
Select-String -Path "$base\dsh-llm\lib\types\message.d.ts" -Pattern "interface ToolResultMessage" -Context 0,12
Select-String -Path "$base\dsh-user-approval\lib\types\types.d.ts" -Pattern "'approval/asked'|'approval/decided'" -Context 0,8
```
