# 听书 Audiobook（v2 优化版说明）

本次提供的文件包含更新后的核心逻辑骨架，用于解决以下问题：

1. **不再每次重复加载音源**：通过 `AudiobookEngine.ensureLocalTtsLoaded()` 实现音源单例复用，并在内存中缓存已生成的音频链接（声线/语速/文本变更时可调用 `clearAudiobookCache()` 清理）。
2. **跳过 `<...>` 标签与正文状态栏**：在 `sanitizeAudiobookText()` 中先剔除 `<...>` 标签内容、代码块状态栏及常见属性/状态面板段落，再进行旁白/对白拆分。
3. **扫描完全部生成后再读出来**：`scanGenerateAllAndPlay()` 会先扫描有效分段 → 全部合成音频（并在分段间短暂停顿让出主线程，减轻手机端卡顿） → 全部生成完毕后再统一按顺序播放。

## 使用说明

1. 将压缩包中的 `core.js` 和 `index.js` 放入你的 `tavern-audiobook` 插件目录（建议先备份原文件）。
2. 在 `index.js` 的 `initSherpaTts` 和 `synthesizeWithSherpa` 中填入你原有的 Sherpa-ONNX 初始化与合成代码。
3. 刷新 SillyTavern 即可生效。
