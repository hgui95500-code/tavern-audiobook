import { AudiobookEngine } from "./core.js";

/**
 * 酒馆插件入口示例（index.js）
 * 请按你原有的 Sherpa-ONNX 初始化与声线映射函数替换 initSherpaTts 与 synthesizeWithSherpa
 */

const defaultSettings = {
  autoLoadLocalModel: false, // 默认关闭自动加载，按需加载并复用单例
  engine: "local",           // "local" | "system"
  maxChars: 80,
  readNarration: true,
  readDialogue: true,
  skipBrackets: false,
  rate: 1.0,
  volume: 1.0,
  ignoredTags: [],
};

// TODO: 替换为你的 sherpa-onnx 初始化逻辑（返回已初始化的 tts 实例）
async function initSherpaTts(onStatus) {
  onStatus?.("初始化本地模型中...");
  // 示例：return await createSherpaOnnxTts(...);
  throw new Error("请在 index.js 的 initSherpaTts 中接入你的 sherpa-onnx 初始化代码");
}

// TODO: 替换为你的单段合成逻辑（返回音频 Blob URL 或 base64 data URL）
async function synthesizeWithSherpa(segment, voiceId, ttsInstance) {
  const audioData = ttsInstance.generate({
    text: segment.text,
    sid: Number(voiceId) || 0,
  });
  const blob = new Blob([audioData.samples], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

const engine = new AudiobookEngine(initSherpaTts);

export async function readMessageText(rawText, userSettings = {}, onProgress) {
  const cfg = { ...defaultSettings, ...userSettings };

  await engine.scanGenerateAllAndPlay(rawText, cfg, {
    onProgress,
    resolveVoiceId: (segment) => {
      // 按旁白/对白切换声线编号（按需对接你的设置项）
      return segment.type === "dialogue" ? cfg.dialogueVoiceId ?? 1 : cfg.narrationVoiceId ?? 0;
    },
    synthesizeSegment: synthesizeWithSherpa,
  });
}

export function stopAudiobook() {
  engine.stop();
}

export function clearAudiobookCache() {
  engine.clearCache();
}
