# dsh-media-video

DSH Host plugin: shared video editing tools plus the packaged video editor page.

独立包：只注册视频入口（`dsh-media-video`），路由前缀 `/media-video`，
工具表只含 `media_video_*`。与另一个编辑器包互不依赖，可单独安装。

## 测试

```bash
node --test test/*.test.mjs
```
