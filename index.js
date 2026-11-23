import { AudiobookEngine, samplesToWavBlobUrl } from "./core.js";

const MODULE_NAME = "tavern_audiobook";
const RATES = [0.8, 1.0, 1.25, 1.5, 2.0];

const DEFAULT_SETTINGS = {
  enabled: true,
  engine: "local",
  autoLoadLocalModel: false,
  autoPlayNewAiMsg: false,
  narrationVoiceId: 0,
  dialogueVoiceId: 1,
  maxChars: 40,
  yieldMs: 40,
  readNarration: true,
  readDialogue: true,
  skipBrackets: true,
  rateIndex: 1,
  volume: 1.0,
  ignoredTagsText: "think,status,state,panel",
  sherpaModelDir: "./sherpa",
};

function getContextSafe() {
  return window.SillyTavern?.getContext?.() || null;
}

function getSettings() {
  const ctx = getContextSafe();
  const extSettings = ctx?.extensionSettings;
  if (extSettings) {
    extSettings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, extSettings[MODULE_NAME] || {});
    return extSettings[MODULE_NAME];
  }
  return Object.assign({}, DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  const ctx = getContextSafe();
  if (ctx?.saveSettingsDebounced) {
    ctx.saveSettingsDebounced();
  }
  return settings;
}

async function initSherpaTts(onStatus) {
  const settings = getSettings();
  const baseDir = (settings.sherpaModelDir || "./sherpa").replace(/\/+$/, "");

  onStatus?.("正在加载 Sherpa-ONNX 脚本...");
  if (typeof window.createSherpaOnnxTts !== "function") {
    await import(`${baseDir}/sherpa-onnx-tts.js`);
  }

  if (typeof window.createSherpaOnnxTts !== "function") {
    throw new Error("未找到 createSherpaOnnxTts，请检查 sherpa/ 目录下文件是否完整");
  }

  onStatus?.("正在初始化 Kokoro 本地模型（仅首次需要）...");
  const tts = await new Promise((resolve, reject) => {
    try {
      const config = {
        offlineTtsModelConfig: {
          kokoro: {
            model: `${baseDir}/model.onnx`,
            voices: `${baseDir}/voices.bin`,
            tokens: `${baseDir}/tokens.txt`,
            dataDir: `${baseDir}/espeak-ng-data`,
            lengthScale: 1.0,
          },
          numThreads: 1,
          debug: false,
          provider: "cpu",
        },
        ruleFsts: "",
        maxNumSenetences: 1,
      };
      const instance = window.createSherpaOnnxTts(config);
      resolve(instance);
    } catch (err) {
      reject(err);
    }
  });

  return tts;
}

async function synthesizeWithSherpa(segment, voiceId, ttsInstance) {
  const sid = Number.isFinite(Number(voiceId)) ? Number(voiceId) : 0;
  const generated = await ttsInstance.generate({
    text: segment.text,
    sid,
    speed: 1.0,
  });
  const samples = generated?.samples;
  const sampleRate = generated?.sampleRate || 22050;
  return samplesToWavBlobUrl(samples, sampleRate);
}

const engine = new AudiobookEngine(initSherpaTts);

function setStatusText(text) {
  const el = document.getElementById("stab_status_text");
  if (el) el.textContent = text;
}

function setActiveMessageHighlight(mesEl) {
  document.querySelectorAll("#chat .mes.stab-playing").forEach((el) => {
    el.classList.remove("stab-playing");
  });
  if (mesEl) {
    mesEl.classList.add("stab-playing");
  }
}

function updateFloatingBarState(state) {
  const bar = document.getElementById("stab_bar");
  const pauseBtn = document.getElementById("stab_pause");
  const rateBtn = document.getElementById("stab_rate");
  const settings = getSettings();
  const rate = RATES[settings.rateIndex] ?? 1.0;

  if (rateBtn) rateBtn.textContent = `${rate}x`;
  if (!bar) return;

  if (state === "active") {
    bar.classList.remove("stab-idle");
    bar.classList.add("stab-active");
    if (pauseBtn) {
      pauseBtn.textContent = engine.isPaused ? "▶" : "⏸";
      pauseBtn.title = engine.isPaused ? "继续朗诵" : "暂停朗诵";
    }
  } else {
    bar.classList.remove("stab-active");
    bar.classList.add("stab-idle");
    if (pauseBtn) {
      pauseBtn.textContent = "⏸";
      pauseBtn.title = "暂停朗诵";
    }
  }
}

function getLatestAiMessageText() {
  const messages = Array.from(document.querySelectorAll("#chat .mes"));
  for (let i = messages.length - 1; i >= 0; i--) {
    const mes = messages[i];
    const isUser = mes.getAttribute("is_user") === "true" || mes.classList.contains("is_user");
    if (!isUser) {
      const textEl = mes.querySelector(".mes_text");
      return {
        mesEl: mes,
        text: textEl ? (textEl.innerText || textEl.textContent || "") : "",
      };
    }
  }
  return { mesEl: null, text: "" };
}

export async function speakFromMessageElement(mesEl, rawText) {
  const settings = getSettings();
  if (!settings.enabled) return;

  const content = (rawText ?? "").trim();
  if (!content) {
    setStatusText("没有可朗读的消息内容");
    return;
  }

  const rate = RATES[settings.rateIndex] ?? 1.0;
  engine.setRate(rate);
  setActiveMessageHighlight(mesEl);
  updateFloatingBarState("active");

  const ignoredTags = (settings.ignoredTagsText || "")
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    await engine.scanGenerateAllAndPlay(
      content,
      {
        engine: settings.engine,
        maxChars: settings.maxChars,
        yieldMs: settings.yieldMs,
        readNarration: settings.readNarration,
        readDialogue: settings.readDialogue,
        skipBrackets: settings.skipBrackets,
        rate,
        volume: settings.volume,
        ignoredTags,
      },
      {
        onProgress: (info) => {
          if (info?.message) {
            setStatusText(info.message);
          }
          if (info?.stage === "playing" || info?.stage === "paused") {
            updateFloatingBarState("active");
          } else if (
            info?.stage === "completed" ||
            info?.stage === "stopped" ||
            info?.stage === "empty"
          ) {
            setActiveMessageHighlight(null);
            updateFloatingBarState("idle");
          }
        },
        resolveVoiceId: (segment) => {
          return segment.type === "dialogue"
            ? settings.dialogueVoiceId
            : settings.narrationVoiceId;
        },
        synthesizeSegment: synthesizeWithSherpa,
      }
    );
  } catch (err) {
    console.error("[tavern-audiobook] 朗读出错:", err);
    setStatusText(`出错：${err?.message || err}`);
    setActiveMessageHighlight(null);
    updateFloatingBarState("idle");
  }
}

export function pauseAudiobook() {
  engine.pause();
  updateFloatingBarState(engine.playlist?.length ? "active" : "idle");
}

export function resumeAudiobook() {
  engine.resume();
  updateFloatingBarState(engine.playlist?.length ? "active" : "idle");
}

export function togglePauseAudiobook() {
  engine.togglePause();
  updateFloatingBarState(engine.playlist?.length ? "active" : "idle");
}

export function stopAudiobook() {
  engine.stop();
  setActiveMessageHighlight(null);
  updateFloatingBarState("idle");
}

function injectMessageButtons(mesEl) {
  if (!mesEl || mesEl.querySelector(".stab-msg-btn")) return;
  const extraButtons = mesEl.querySelector(".extraMesButtons") || mesEl.querySelector(".mes_buttons");
  if (!extraButtons) return;

  const btn = document.createElement("div");
  btn.className = "mes_button stab-msg-btn";
  btn.title = "听书朗读（跳过标签与状态栏，全部生成后播放）";
  btn.textContent = "🎧";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const textEl = mesEl.querySelector(".mes_text");
    const raw = textEl ? (textEl.innerText || textEl.textContent || "") : "";
    speakFromMessageElement(mesEl, raw);
  });

  extraButtons.appendChild(btn);
}

function injectAllMessageButtons() {
  document.querySelectorAll("#chat .mes").forEach((mes) => injectMessageButtons(mes));
}

function createFloatingBar() {
  if (document.getElementById("stab_bar")) return;

  const bar = document.createElement("div");
  bar.id = "stab_bar";
  bar.className = "stab-idle";
  bar.innerHTML = `
    <div class="stab-fab" id="stab_fab" title="朗读最新一条回复">🎧</div>
    <div class="stab-controls">
      <div class="stab-btn" id="stab_prev" title="上一句">⏮</div>
      <div class="stab-btn" id="stab_pause" title="暂停朗诵">⏸</div>
      <div class="stab-btn" id="stab_next" title="下一句">⏭</div>
      <div class="stab-btn" id="stab_stop" title="停止">⏹</div>
      <div class="stab-btn" id="stab_rate" title="切换语速">1x</div>
    </div>
  `;

  document.body.appendChild(bar);

  document.getElementById("stab_fab")?.addEventListener("click", () => {
    const latest = getLatestAiMessageText();
    speakFromMessageElement(latest.mesEl, latest.text);
  });

  document.getElementById("stab_prev")?.addEventListener("click", () => {
    engine.prev();
  });

  document.getElementById("stab_pause")?.addEventListener("click", () => {
    togglePauseAudiobook();
  });

  document.getElementById("stab_next")?.addEventListener("click", () => {
    engine.next();
  });

  document.getElementById("stab_stop")?.addEventListener("click", () => {
    stopAudiobook();
  });

  document.getElementById("stab_rate")?.addEventListener("click", () => {
    const settings = getSettings();
    settings.rateIndex = (settings.rateIndex + 1) % RATES.length;
    saveSettings(settings);
    const newRate = RATES[settings.rateIndex];
    engine.setRate(newRate);
    updateFloatingBarState(engine.playlist?.length ? "active" : "idle");
  });
}

function getWandMenuContainer() {
  return (
    document.getElementById("extensionsMenu") ||
    document.querySelector("#extensions-menu") ||
    document.querySelector(".extensions_menu") ||
    null
  );
}

function createWandMenuItem() {
  if (document.getElementById("stab_wand_item")) return;
  const menu = getWandMenuContainer();
  if (!menu) return;

  const item = document.createElement("div");
  item.id = "stab_wand_item";
  item.className = "extension_container";
  item.innerHTML = `
    <div id="stab_wand_read_latest" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="朗读最新一条 AI 回复">
      <div class="fa-solid fa-headphones extensionsMenuExtensionButton"></div>
      <span>听书：朗读最新回复</span>
    </div>
    <div id="stab_wand_pause" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="暂停或继续当前朗诵">
      <div class="fa-solid fa-pause extensionsMenuExtensionButton"></div>
      <span>听书：暂停/继续</span>
    </div>
    <div id="stab_wand_stop" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="停止当前朗诵">
      <div class="fa-solid fa-stop extensionsMenuExtensionButton"></div>
      <span>听书：停止朗诵</span>
    </div>
  `;

  menu.appendChild(item);

  document.getElementById("stab_wand_read_latest")?.addEventListener("click", () => {
    const latest = getLatestAiMessageText();
    speakFromMessageElement(latest.mesEl, latest.text);
  });

  document.getElementById("stab_wand_pause")?.addEventListener("click", () => {
    togglePauseAudiobook();
  });

  document.getElementById("stab_wand_stop")?.addEventListener("click", () => {
    stopAudiobook();
  });
}

function bindWandButtonFallback() {
  const wandBtn =
    document.getElementById("extensionsMenuButton") ||
    document.querySelector("#extensions_menu_button") ||
    document.querySelector(".extensionsMenuButton");

  if (wandBtn && !wandBtn.dataset.stabBound) {
    wandBtn.dataset.stabBound = "1";
    wandBtn.addEventListener("click", () => {
      setTimeout(() => createWandMenuItem(), 50);
    });
  }
}

function createSettingsPanel() {
  if (document.getElementById("stab_drawer")) return;
  const settings = getSettings();
  const container =
    document.getElementById("extensions_settings2") ||
    document.getElementById("extensions_settings") ||
    document.body;

  const drawer = document.createElement("div");
  drawer.id = "stab_drawer";
  drawer.className = "inline-drawer";
  drawer.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🎧 听书 Audiobook（扫描 → 全部生成 → 播放）</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down inline-drawer-toggle-icon"></div>
    </div>
    <div class="inline-drawer-content">
      <div id="stab_status_text" class="stab-status">
        状态：${engine.isLocalLoaded() ? "本地音源已加载" : "本地音源未加载（首次听书时加载并复用）"}
      </div>

      <div class="stab-row">
        <label>声音引擎</label>
        <select id="stab_engine">
          <option value="local" ${settings.engine === "local" ? "selected" : ""}>本地音源（复用单例，扫描后全部生成）</option>
          <option value="system" ${settings.engine === "system" ? "selected" : ""}>系统语音（低占用，不卡顿）</option>
        </select>
      </div>

      <div class="stab-row">
        <label>每段最多字数（越小越不容易卡死，建议 25~50）</label>
        <input id="stab_max_chars" type="number" min="10" max="200" step="5" value="${settings.maxChars}" />
      </div>

      <div class="stab-row">
        <label>分段合成间隔毫秒（让出主线程减少卡顿，建议 30~80）</label>
        <input id="stab_yield_ms" type="number" min="0" max="300" step="10" value="${settings.yieldMs}" />
      </div>

      <div class="stab-row">
        <label>旁白声线 ID / 对白声线 ID</label>
        <input id="stab_narration_voice" type="number" min="0" max="999" value="${settings.narrationVoiceId}" />
        <input id="stab_dialogue_voice" type="number" min="0" max="999" value="${settings.dialogueVoiceId}" />
      </div>

      <div class="stab-row">
        <label>额外忽略标签名（逗号分隔，默认已跳过所有 &lt;...&gt; 与状态栏）</label>
        <input id="stab_ignored_tags" type="text" value="${settings.ignoredTagsText}" />
      </div>

      <div class="stab-row">
        <label><input id="stab_read_narration" type="checkbox" ${settings.readNarration ? "checked" : ""} /> 朗读旁白</label>
        <label><input id="stab_read_dialogue" type="checkbox" ${settings.readDialogue ? "checked" : ""} /> 朗读对白</label>
        <label><input id="stab_skip_brackets" type="checkbox" ${settings.skipBrackets ? "checked" : ""} /> 跳过括号内容</label>
        <label><input id="stab_auto_play" type="checkbox" ${settings.autoPlayNewAiMsg ? "checked" : ""} /> 自动朗读新 AI 回复</label>
      </div>

      <div class="stab-row stab-buttons">
        <div id="stab_btn_pause_toggle" class="menu_button">暂停/继续朗诵</div>
        <div id="stab_btn_stop" class="menu_button">停止朗诵</div>
      </div>

      <div class="stab-row stab-buttons">
        <div id="stab_btn_load" class="menu_button">手动加载/复用音源</div>
        <div id="stab_btn_clear_cache" class="menu_button">清理音频缓存</div>
      </div>
    </div>
  `;

  container.appendChild(drawer);

  drawer.querySelector(".inline-drawer-toggle")?.addEventListener("click", () => {
    drawer.classList.toggle("open");
    const content = drawer.querySelector(".inline-drawer-content");
    if (content) {
      content.style.display = drawer.classList.contains("open") ? "block" : "none";
    }
  });

  const bindChange = (id, fn) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      const s = getSettings();
      fn(s, e.target);
      saveSettings(s);
    });
  };

  bindChange("stab_engine", (s, el) => { s.engine = el.value; });
  bindChange("stab_max_chars", (s, el) => { s.maxChars = Math.max(10, Number(el.value) || 40); });
  bindChange("stab_yield_ms", (s, el) => { s.yieldMs = Math.max(0, Number(el.value) || 40); });
  bindChange("stab_narration_voice", (s, el) => { s.narrationVoiceId = Number(el.value) || 0; });
  bindChange("stab_dialogue_voice", (s, el) => { s.dialogueVoiceId = Number(el.value) || 1; });
  bindChange("stab_ignored_tags", (s, el) => { s.ignoredTagsText = el.value; });
  bindChange("stab_read_narration", (s, el) => { s.readNarration = el.checked; });
  bindChange("stab_read_dialogue", (s, el) => { s.readDialogue = el.checked; });
  bindChange("stab_skip_brackets", (s, el) => { s.skipBrackets = el.checked; });
  bindChange("stab_auto_play", (s, el) => { s.autoPlayNewAiMsg = el.checked; });

  document.getElementById("stab_btn_pause_toggle")?.addEventListener("click", () => {
    togglePauseAudiobook();
  });

  document.getElementById("stab_btn_stop")?.addEventListener("click", () => {
    stopAudiobook();
  });

  document.getElementById("stab_btn_load")?.addEventListener("click", async () => {
    try {
      await engine.ensureLocalTtsLoaded((msg) => setStatusText(msg));
    } catch (err) {
      setStatusText(`加载失败：${err?.message || err}`);
    }
  });

  document.getElementById("stab_btn_clear_cache")?.addEventListener("click", () => {
    engine.clearCache();
    setStatusText("已清理已生成的音频缓存");
  });
}

function observeChatMessages() {
  const chatEl = document.getElementById("chat");
  if (!chatEl) return;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.classList?.contains("mes")) {
          injectMessageButtons(node);
          const settings = getSettings();
          const isUser = node.getAttribute("is_user") === "true" || node.classList.contains("is_user");
          if (settings.enabled && settings.autoPlayNewAiMsg && !isUser) {
            setTimeout(() => {
              const textEl = node.querySelector(".mes_text");
              const raw = textEl ? (textEl.innerText || textEl.textContent || "") : "";
              speakFromMessageElement(node, raw);
            }, 250);
          }
        }
      }
    }
  });

  observer.observe(chatEl, { childList: true, subtree: true });
}

(function initExtension() {
  const start = () => {
    createSettingsPanel();
    createFloatingBar();
    createWandMenuItem();
    bindWandButtonFallback();
    injectAllMessageButtons();
    observeChatMessages();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
