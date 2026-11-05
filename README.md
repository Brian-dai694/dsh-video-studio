# DSH 视频编辑器（人机协作）

DSH 里左侧原生视频编辑器、右侧真实会话的人工 + Agent 协作编辑：单轨剪辑、文字/图片叠加、撤销重做、WebM 音画合成导出。

本仓库是**视频侧独立仓库**，图片侧见 [dsh-image-studio](https://github.com/Brian-dai694/dsh-image-studio)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `video/` | 编辑器源码：`video.js`、`video-state.mjs`、`video-bridge.mjs`、`video-export.mjs`、`video-capabilities.mjs`、页面与测试 |
| `host/` | 视频宿主页（`/media/boot` + relay + MessageChannel，加载后自动连接）、共享 iframe transport |
| `contracts/` | 命令/状态契约、DSH 会话接口核查记录 |

## 关键约定

- 时间参数一律整数**微秒**（1 秒 = 1,000,000），工具说明里直接写清，避免模型猜 `startTime/duration`。
- 写命令带 `commandId` 与 `expectedRevision`，写入后立即回读；结果未知记 `unknown` 不重放。
- 撤销支持成对 `targetCommandId + afterDigest`，与后续修改冲突时返回 `HISTORY_CONFLICT`；`redo` 只接受 `{}`。
- 导出为 WebM（MediaRecorder 产物头部无 duration，导入时按解码时长判断，不要据此判失败）。

## 测试

```bash
cd video && node --test tests/*.test.mjs
```

## 状态

已实测：宿主页自动连接、文字叠加写入→回读→人工撤销、导出产物有画面有音轨。
待验收：叠加是否烧进成片、无音轨素材提示、裁切边界时长对齐、工程重开媒体重连。
