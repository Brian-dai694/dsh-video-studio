# dsh-media-video

DSH Host plugin: shared video editing tools plus the packaged video editor page.

独立包：只注册视频入口（`dsh-media-video`），路由前缀 `/media-video`，
工具表只含 `media_video_*`。与另一个编辑器包互不依赖，可单独安装。

## 测试

```bash
node --test test/*.test.mjs
```

## 开发须知

- 改样式/脚本后验证前先关缓存：CDP 里先调 `Network.setCacheDisabled({ cacheDisabled: true })` 再导航。否则浏览器会复用旧的 `video.css` / `video.js`，改了看起来“没生效”，很容易把缓存问题误判成层级或逻辑 bug（本项目已经踩过一次）。
- 导出必须在前台标签页：后台标签的 requestAnimationFrame 被节流，合成循环不推进。
- 导出链路不要碰 `element.muted` / `element.volume`：`createMediaElementSource` 会把预览状态带进成片，音量只走 GainNode。
- 同一 `sourceRef` 只允许一处发声（`DUPLICATE_AUDIO_SOURCE`）：一个媒体元素只能接一条音频链。
