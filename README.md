# 听书 Audiobook（完整整合包）

包含完整插件文件：`manifest.json`、`style.css`、`core.js`、`index.js`。

## 已完成的改造
1. **音源单例复用 + 音频缓存**：`AudiobookEngine.ensureLocalTtsLoaded()` 只在首次需要时初始化一次并复用实例，同时缓存已生成的音频，避免每次听书重复加载或重复算同一段。
2. **跳过 `<...>` 标签与正文状态栏**：`sanitizeAudiobookText()` 在切分前先剔除 `<...>` 标签内容、三引号状态代码块、状态/属性面板块及常见状态行。
3. **扫描完要读哪些 → 全部生成 → 再读出来**：`scanGenerateAllAndPlay()` 先扫描并拆分出分段，逐段全部生成音频（中间留出主线程让步间隔，缓解手机端卡死），全部生成完成后再按顺序播放。
