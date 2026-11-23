/**
 * tavern-audiobook core.js
 * 1. 跳过/移除 <...> 标签及常见正文状态栏（在切分句子前彻底清理）
 * 2. 音源单例复用 + 音频缓存（避免每次重加载音源、重复合成同一段文本）
 * 3. 先扫描要读哪些 -> 全部生成音频（每段间让出主线程减少卡顿） -> 再按顺序读出来
 * 4. 完整支持：暂停朗诵 / 继续朗诵 / 上一句 / 下一句 / 停止 / 倍速切换
 */

export function sanitizeAudiobookText(rawText, customOptions = {}) {
  if (!rawText || typeof rawText !== "string") return "";

  let text = rawText;

  // 1. 移除所有 <...> 标签及其内容（支持嵌套标签）
  let prev;
  do {
    prev = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== prev);

  // 2. 移除代码块状态栏
  text = text.replace(/```[\s\S]*?```/g, "");

  // 3. 移除独立成段的状态栏 / 面板 / 属性块
  text = text.replace(
    /(?:^|\n)[ \t]*(?:[-─═=*]{3,}|[【\[](?:状态|属性|面板|系统|数值|好感|背包|时间|地点|角色卡|状态栏|信息栏)[^\n\]]*[】\]])[\s\S]*?(?=\n{2,}|$)/g,
    "\n"
  );

  // 4. 移除单行状态字段与带状态关键词的竖线分隔行
  text = text.replace(
    /^.*(?:好感度|心情值|理智值|当前状态|生命值|体力值|精力值|饥饿度|MP|HP)[：:].*$/gm,
    ""
  );
  text = text.replace(
    /^[^\n。！？!?]*[|｜][^\n。！？!?]*(?:好感|状态|属性|等级|LV|Lv|HP|MP|时间|地点)[^\n]*$/gm,
    ""
  );

  // 5. 支持用户配置的额外忽略标签
  if (Array.isArray(customOptions.ignoredTags)) {
    for (const rawTag of customOptions.ignoredTags) {
      const tag = String(rawTag || "").trim().replace(/^<|>$/g, "");
      if (!tag) continue;
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const blockRegex = new RegExp(`<${escaped}(?:\s[^>]*)?>[\s\S]*?<\/${escaped}>`, "gi");
      const selfCloseRegex = new RegExp(`<${escaped}(?:\s[^>]*)?\/?>`, "gi");
      text = text.replace(blockRegex, "").replace(selfCloseRegex, "");
    }
  }

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitIntoSegments(cleanedText, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 40;
  const readNarration = options.readNarration !== false;
  const readDialogue = options.readDialogue !== false;
  const skipBrackets = Boolean(options.skipBrackets);

  let working = cleanedText;
  if (skipBrackets) {
    working = working
      .replace(/（[^（）]*）/g, "")
      .replace(/\([^()]*\)/g, "")
      .replace(/\[[^\[\]]*\]/g, "");
  }

  const rawParts = [];
  const tokenRegex = /(“[^”]*”|"[^"]*")/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(working)) !== null) {
    if (match.index > lastIndex) {
      const narration = working.slice(lastIndex, match.index).trim();
      if (narration && readNarration) {
        rawParts.push({ type: "narration", text: narration });
      }
    }
    const dialogue = match[0].replace(/^[“"]|[”"]$/g, "").trim();
    if (dialogue && readDialogue) {
      rawParts.push({ type: "dialogue", text: dialogue });
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < working.length) {
    const tail = working.slice(lastIndex).trim();
    if (tail && readNarration) {
      rawParts.push({ type: "narration", text: tail });
    }
  }

  const segments = [];
  for (const part of rawParts) {
    const chunks = chunkTextByLength(part.text, maxChars);
    for (const chunk of chunks) {
      const cleanedChunk = chunk.trim();
      if (cleanedChunk) {
        segments.push({
          type: part.type,
          text: cleanedChunk,
        });
      }
    }
  }

  return segments;
}

function chunkTextByLength(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const result = [];
  let buf = "";
  const sentences = text.split(/(?<=[。！？!?；;…\n])/);

  for (const s of sentences) {
    if (!s) continue;
    if ((buf + s).length <= maxChars) {
      buf += s;
    } else {
      if (buf.trim()) result.push(buf.trim());
      if (s.length <= maxChars) {
        buf = s;
      } else {
        for (let i = 0; i < s.length; i += maxChars) {
          result.push(s.slice(i, i + maxChars));
        }
        buf = "";
      }
    }
  }

  if (buf.trim()) result.push(buf.trim());
  return result;
}

export function samplesToWavBlobUrl(samples, sampleRate = 22050) {
  if (!samples || !samples.length) return "";
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const blob = new Blob([buffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

export class AudiobookEngine {
  constructor(initLocalTtsFn) {
    this.initLocalTtsFn = initLocalTtsFn;
    this.localTtsInstance = null;
    this.loadingPromise = null;
    this.audioCache = new Map();
    this.currentAudio = null;
    this.isStopped = false;
    this.isPaused = false;
    this.playlist = [];
    this.currentIndex = 0;
    this.currentRate = 1.0;
    this.currentVolume = 1.0;
    this.onProgressCb = null;
    this._stepResolver = null;
    this._resumeResolver = null;
  }

  async ensureLocalTtsLoaded(onStatus) {
    if (this.localTtsInstance) {
      return this.localTtsInstance;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      try {
        onStatus?.("加载本地音源（仅首次需要，后续复用）...");
        this.localTtsInstance = await this.initLocalTtsFn(onStatus);
        onStatus?.("本地音源已就绪");
        return this.localTtsInstance;
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  isLocalLoaded() {
    return Boolean(this.localTtsInstance);
  }

  clearCache() {
    for (const item of this.audioCache.values()) {
      if (typeof item === "string" && item.startsWith("blob:")) {
        URL.revokeObjectURL(item);
      }
    }
    this.audioCache.clear();
  }

  setRate(rate) {
    const r = Number(rate) > 0 ? Number(rate) : 1.0;
    this.currentRate = r;
    if (this.currentAudio) {
      this.currentAudio.playbackRate = r;
    }
  }

  pause() {
    if (this.isStopped || !this.playlist.length || this.isPaused) return false;
    this.isPaused = true;

    if (this.currentAudio && !this.currentAudio.paused) {
      this.currentAudio.pause();
    }
    if (typeof window !== "undefined" && window.speechSynthesis && window.speechSynthesis.speaking) {
      try {
        window.speechSynthesis.pause();
      } catch (_) {}
    }

    this._emitPauseState(true);
    return true;
  }

  resume() {
    if (this.isStopped || !this.playlist.length || !this.isPaused) return false;
    this.isPaused = false;

    if (this.currentAudio && this.currentAudio.paused) {
      this.currentAudio.play().catch(() => {});
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (_) {}
    }

    this._emitPauseState(false);

    if (this._resumeResolver) {
      const resolve = this._resumeResolver;
      this._resumeResolver = null;
      resolve();
    }
    return true;
  }

  togglePause() {
    if (!this.playlist.length) return false;
    if (this.isPaused) {
      this.resume();
      return false;
    } else {
      this.pause();
      return true;
    }
  }

  _emitPauseState(paused) {
    const total = this.playlist.length;
    const current = Math.min(total, this.currentIndex + 1);
    this.onProgressCb?.({
      stage: paused ? "paused" : "playing",
      current,
      total,
      segment: this.playlist[this.currentIndex] || null,
      paused,
      message: paused
        ? `已暂停朗诵 (${current}/${total})`
        : `正在朗读 (${current}/${total})`,
    });
  }

  _waitIfPaused() {
    if (!this.isPaused || this.isStopped) return Promise.resolve();
    return new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
  }

  prev() {
    if (!this.playlist.length) return;
    this.currentIndex = Math.max(0, this.currentIndex - 1);
    this._jumpToCurrent();
  }

  next() {
    if (!this.playlist.length) return;
    this.currentIndex = Math.min(this.playlist.length, this.currentIndex + 1);
    this._jumpToCurrent();
  }

  _jumpToCurrent() {
    this.isPaused = false;
    if (this._resumeResolver) {
      const r = this._resumeResolver;
      this._resumeResolver = null;
      r();
    }
    this._stopCurrentPlaybackOnly();
    if (this._stepResolver) {
      const resolve = this._stepResolver;
      this._stepResolver = null;
      resolve("jump");
    }
  }

  _stopCurrentPlaybackOnly() {
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  stop() {
    this.isStopped = true;
    this.isPaused = false;
    this.playlist = [];
    this.currentIndex = 0;
    this._stopCurrentPlaybackOnly();

    if (this._resumeResolver) {
      const r = this._resumeResolver;
      this._resumeResolver = null;
      r();
    }
    if (this._stepResolver) {
      const resolve = this._stepResolver;
      this._stepResolver = null;
      resolve("stop");
    }
    this.onProgressCb?.({ stage: "stopped", paused: false, message: "已停止朗读" });
  }

  async scanGenerateAllAndPlay(rawText, config = {}, callbacks = {}) {
    this.stop();
    this.isStopped = false;
    this.isPaused = false;
    this.currentRate = Number(config.rate) > 0 ? Number(config.rate) : 1.0;
    this.currentVolume =
      config.volume !== undefined ? Math.min(1, Math.max(0, Number(config.volume))) : 1.0;

    const {
      onProgress,
      resolveVoiceId,
      synthesizeSegment,
    } = callbacks;

    this.onProgressCb = onProgress || null;

    // 1. 扫描并清洗
    const cleaned = sanitizeAudiobookText(rawText, config);
    const segments = splitIntoSegments(cleaned, config);

    if (segments.length === 0) {
      this.onProgressCb?.({ stage: "empty", message: "扫描完成：没有可朗读的正文内容" });
      return;
    }

    this.onProgressCb?.({
      stage: "scanned",
      total: segments.length,
      message: `扫描完成（共 ${segments.length} 段），准备全部生成...`,
    });

    // 2. 确保本地音源已加载（已加载则直接复用）
    let ttsInstance = null;
    if (config.engine !== "system" && typeof synthesizeSegment === "function") {
      ttsInstance = await this.ensureLocalTtsLoaded((msg) =>
        this.onProgressCb?.({ stage: "loading_engine", message: msg })
      );
    }

    // 3. 全部生成音频（每段间让出主线程减少卡顿）
    const builtPlaylist = [];
    const yieldGap = Math.max(15, Number(config.yieldMs) || 35);

    for (let i = 0; i < segments.length; i++) {
      if (this.isStopped) return;

      const seg = segments[i];
      const voiceId = resolveVoiceId ? resolveVoiceId(seg, i) : "default";
      const cacheKey = `${config.engine || "local"}|${voiceId}|${seg.text}`;

      let audioPayload = this.audioCache.get(cacheKey);
      if (!audioPayload) {
        if (config.engine === "system") {
          audioPayload = { type: "system", text: seg.text, voiceId };
        } else {
          audioPayload = await synthesizeSegment(seg, voiceId, ttsInstance);
        }
        if (audioPayload) {
          this.audioCache.set(cacheKey, audioPayload);
        }
      }

      if (audioPayload) {
        builtPlaylist.push({
          ...seg,
          voiceId,
          audioPayload,
        });
      }

      this.onProgressCb?.({
        stage: "generating",
        current: i + 1,
        total: segments.length,
        message: `全部生成中：${i + 1} / ${segments.length}`,
      });

      await new Promise((r) => setTimeout(r, yieldGap));
    }

    if (this.isStopped) return;

    this.playlist = builtPlaylist;
    this.currentIndex = 0;

    if (!this.playlist.length) {
      this.onProgressCb?.({ stage: "empty", message: "生成结果为空，无法朗读" });
      return;
    }

    this.onProgressCb?.({
      stage: "ready",
      total: this.playlist.length,
      message: `全部 ${this.playlist.length} 段已生成，开始朗读`,
    });

    // 4. 全部生成完成后，按顺序读出来
    while (!this.isStopped && this.currentIndex < this.playlist.length) {
      await this._waitIfPaused();
      if (this.isStopped) return;

      const idx = this.currentIndex;
      const item = this.playlist[idx];

      this.onProgressCb?.({
        stage: "playing",
        current: idx + 1,
        total: this.playlist.length,
        segment: item,
        paused: this.isPaused,
        message: `正在朗读 (${idx + 1}/${this.playlist.length})`,
      });

      const reason = await this._playSingleItem(item);
      if (this.isStopped || reason === "stop") return;
      if (reason === "jump") {
        continue;
      }
      this.currentIndex = idx + 1;
    }

    if (!this.isStopped) {
      this.playlist = [];
      this.currentIndex = 0;
      this.isPaused = false;
      this.onProgressCb?.({ stage: "completed", paused: false, message: "朗读完成" });
    }
  }

  _playSingleItem(item) {
    return new Promise((resolve) => {
      if (this.isStopped) return resolve("stop");

      this._stepResolver = (r) => {
        this._stepResolver = null;
        resolve(r);
      };

      const finishNormally = () => {
        this._stepResolver = null;
        resolve("ended");
      };

      if (typeof item.audioPayload === "object" && item.audioPayload?.type === "system") {
        if (typeof window === "undefined" || !window.speechSynthesis) {
          return finishNormally();
        }
        const utter = new SpeechSynthesisUtterance(item.audioPayload.text);
        utter.rate = this.currentRate;
        utter.volume = this.currentVolume;
        utter.onend = finishNormally;
        utter.onerror = finishNormally;
        window.speechSynthesis.speak(utter);
        return;
      }

      const audio = new Audio(item.audioPayload);
      this.currentAudio = audio;
      audio.playbackRate = this.currentRate;
      audio.volume = this.currentVolume;
      audio.onended = () => {
        this.currentAudio = null;
        finishNormally();
      };
      audio.onerror = () => {
        this.currentAudio = null;
        finishNormally();
      };
      audio.play().catch(() => {
        this.currentAudio = null;
        finishNormally();
      });
    });
  }
}
