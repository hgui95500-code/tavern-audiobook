/**
 * tavern-audiobook core.js (v2)
 * 核心能力：
 * 1. 清洗 <...> 标签与常见正文状态栏
 * 2. 音源单例复用 + 音频缓存（避免每次重加载音源与重复合成）
 * 3. 先扫描要读的分段 -> 全部生成音频 -> 再统一按序播放（缓解手机端主线程阻塞）
 */

export function sanitizeAudiobookText(rawText, customOptions = {}) {
  if (!rawText || typeof rawText !== "string") return "";

  let text = rawText;

  // 1. 跳过/移除所有 <...> 标签及其内部内容（支持嵌套）
  let prev;
  do {
    prev = text;
    text = text.replace(/<[^<>]*>/g, "");
  } while (text !== prev);

  // 2. 移除代码块包裹的状态栏
  text = text.replace(/```[\s\S]*?```/g, "");

  // 3. 移除独立成段的状态栏/属性栏/数值面板
  text = text.replace(
    /(?:^|\n)[ \t]*(?:[-─═=*]{3,}|[【\[](?:状态|属性|面板|系统|数值|好感|背包|时间|地点|角色卡)[^\n\]]*[】\]])[\s\S]*?(?=\n{2,}|$)/g,
    "\n"
  );

  // 4. 移除单行状态字段（如“好感度：60 / 生命值：100/100”）
  text = text.replace(
    /^.*(?:好感度|心情值|理智值|当前状态|生命值|体力值|MP|HP)[：:].*$/gm,
    ""
  );

  // 5. 可选：支持自定义忽略的标签名或正则规则
  if (Array.isArray(customOptions.ignoredTags)) {
    for (const tag of customOptions.ignoredTags) {
      if (!tag) continue;
      const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const blockRegex = new RegExp(`<${escaped}(?:\s[^>]*)?>[\s\S]*?<\/${escaped}>`, "gi");
      const selfCloseRegex = new RegExp(`<${escaped}(?:\s[^>]*)?\/?>`, "gi");
      text = text.replace(blockRegex, "").replace(selfCloseRegex, "");
    }
  }

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 将清洗后的正文切分为旁白/对白分段
 * 支持中英文引号“...” / "..." 以及最大字数拆分
 */
export function splitIntoSegments(cleanedText, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 80;
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

  // 按引号提取对白与旁白
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

  // 按 maxChars 进一步切分，避免单次 WASM 推理过长导致页面卡顿
  const segments = [];
  for (const part of rawParts) {
    const chunks = chunkTextByLength(part.text, maxChars);
    for (const chunk of chunks) {
      if (chunk.trim()) {
        segments.push({
          type: part.type,
          text: chunk.trim(),
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

export class AudiobookEngine {
  constructor(initLocalTtsFn) {
    this.initLocalTtsFn = initLocalTtsFn;
    this.localTtsInstance = null;
    this.loadingPromise = null;
    this.audioCache = new Map();
    this.currentAudio = null;
    this.isStopped = false;
    this.isPaused = false;
  }

  /**
   * 音源单例初始化：首次调用时加载，后续直接复用，不再重复加载模型
   */
  async ensureLocalTtsLoaded(onStatus) {
    if (this.localTtsInstance) {
      return this.localTtsInstance;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      try {
        onStatus?.("正在加载本地音源（仅首次需要）...");
        this.localTtsInstance = await this.initLocalTtsFn(onStatus);
        onStatus?.("本地音源已就绪");
        return this.localTtsInstance;
      } finally {
        this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  clearCache() {
    for (const url of this.audioCache.values()) {
      if (typeof url === "string" && url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    }
    this.audioCache.clear();
  }

  stop() {
    this.isStopped = true;
    this.isPaused = false;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  /**
   * 扫描过滤 -> 全部生成 -> 再读出来
   */
  async scanGenerateAllAndPlay(rawText, config = {}, callbacks = {}) {
    this.stop();
    this.isStopped = false;

    const {
      onProgress,
      resolveVoiceId,
      synthesizeSegment, // (segment, voiceId, ttsInstance) => Promise<string (audioUrl)>
    } = callbacks;

    // 1. 扫描并清洗
    const cleaned = sanitizeAudiobookText(rawText, config);
    const segments = splitIntoSegments(cleaned, config);

    if (segments.length === 0) {
      onProgress?.({ stage: "empty", message: "未扫描到可朗读的正文内容" });
      return;
    }

    onProgress?.({
      stage: "scanned",
      total: segments.length,
      message: `扫描完成（共 ${segments.length} 段），开始全部生成语音...`,
    });

    // 确保本地音源已加载（已加载则直接复用）
    let ttsInstance = null;
    if (config.engine !== "system" && typeof synthesizeSegment === "function") {
      ttsInstance = await this.ensureLocalTtsLoaded((msg) =>
        onProgress?.({ stage: "loading_engine", message: msg })
      );
    }

    // 2. 全部生成音频
    const playlist = [];
    for (let i = 0; i < segments.length; i++) {
      if (this.isStopped) return;

      const seg = segments[i];
      const voiceId = resolveVoiceId ? resolveVoiceId(seg, i) : "default";
      const cacheKey = `${config.engine || "local"}|${voiceId}|${config.speed || 1}|${seg.text}`;

      let audioUrl = this.audioCache.get(cacheKey);
      if (!audioUrl) {
        if (config.engine === "system") {
          audioUrl = { type: "system", text: seg.text, voiceId };
        } else {
          audioUrl = await synthesizeSegment(seg, voiceId, ttsInstance);
        }
        this.audioCache.set(cacheKey, audioUrl);
      }

      playlist.push({
        ...seg,
        voiceId,
        audioUrl,
      });

      onProgress?.({
        stage: "generating",
        current: i + 1,
        total: segments.length,
        message: `全部生成中：${i + 1} / ${segments.length}`,
      });

      // 让出主线程，减少手机端连续合成导致的界面卡顿
      await new Promise((r) => setTimeout(r, 12));
    }

    if (this.isStopped) return;

    onProgress?.({
      stage: "ready",
      total: playlist.length,
      message: `全部 ${playlist.length} 段生成完毕，开始朗读`,
    });

    // 3. 全部生成完成后，再统一按顺序播放
    const rate = Number(config.rate) > 0 ? Number(config.rate) : 1.0;
    const volume =
      config.volume !== undefined ? Math.min(1, Math.max(0, Number(config.volume))) : 1.0;

    for (let i = 0; i < playlist.length; i++) {
      if (this.isStopped) return;
      const item = playlist[i];

      onProgress?.({
        stage: "playing",
        current: i + 1,
        total: playlist.length,
        segment: item,
        message: `正在朗读 (${i + 1}/${playlist.length})`,
      });

      if (typeof item.audioUrl === "object" && item.audioUrl?.type === "system") {
        await this._playSystemUtterance(item.audioUrl.text, rate, volume);
      } else {
        await this._playAudioUrl(item.audioUrl, rate, volume);
      }
    }

    onProgress?.({
      stage: "completed",
      message: "朗读完成",
    });
  }

  _playAudioUrl(url, playbackRate, volume) {
    return new Promise((resolve, reject) => {
      if (this.isStopped) return resolve();
      const audio = new Audio(url);
      this.currentAudio = audio;
      audio.playbackRate = playbackRate;
      audio.volume = volume;
      audio.onended = () => {
        this.currentAudio = null;
        resolve();
      };
      audio.onerror = (e) => {
        this.currentAudio = null;
        reject(e);
      };
      audio.play().catch((err) => {
        this.currentAudio = null;
        reject(err);
      });
    });
  }

  _playSystemUtterance(text, rate, volume) {
    return new Promise((resolve) => {
      if (this.isStopped || typeof window === "undefined" || !window.speechSynthesis) {
        return resolve();
      }
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = rate;
      utter.volume = volume;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }
}
