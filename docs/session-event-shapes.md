# 会话事件形状（`tool/call` / `tool/result` / `approval/*`）

> 依据本机已安装运行时的类型定义（源码位置逐条给出）。**找不到明确出处的字段一律标 UNKNOWN，不编。**
> 基路径：`C:\Users\UEFR\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

## 0. 一条重要区分：事件 ≠ 工具输出

面板要把“工具调用/结果”渲染成卡片，需要同时读两层：

1. **会话事件**（`SessionEvent`）：`type` + 载荷。下面 §1/§2 给的是**载荷**的形状。
2. **工具自己的输出对象**：`status` / `commandId` / `revision` / `afterDigest` / `exportId` / `artifactRef`
   这些字段**不在会话事件载荷里**，它们在工具结果消息的 `content` 里（模型可见文本，通常是 JSON 字符串），
   形状由工具自己的 output schema 定义。本项目图片/视频工具的输出 schema 见
   `dsh-image-studio/plugin/dsh-media-image/lib/tools.js:19-31`
   （`status` 四态 `applied|rejected|pending|unknown`、`commandId`、`revision`、`afterDigest`、`exportId`、`artifactRef`）。

> 这解释了真机上“回执外面还包一层”的现象：`tool/result` 载荷 → `message.content[]` → 文本 JSON → 工具输出字段。

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

- **失败判定**：`message.isError === true`；错误码在 **`error.code`**（可选），人类可读原因 `error.reason`（可选）。
- **没有 `status` 字段**：四态 `applied/rejected/unknown` 只能从**工具输出**（§0 第 2 层）里取；
  `pending` 表示“有 `tool/call` 但还没有配对的 `tool/result`”。
- `revision` / `commandId` / `afterDigest` / `exportId` / `artifactRef`：**同样在工具输出里**，事件载荷中没有。

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
- 第三方客户端订阅 `remote.session.follow` 时，帧对象外面是否再包 `{ok, value}`：**UNKNOWN**（FDE 观察到包了一层，但没在类型定义里找到对应声明）。
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
