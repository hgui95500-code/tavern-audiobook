// 听书 Audiobook —— SillyTavern 扩展
// 本地音源：sherpa-onnx (WebAssembly)，备用：浏览器系统语音。
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { buildItems, cleanText, characterGender, estimateF0, genderFromF0 } from './core.js';

const MODULE = 'st_audiobook';
const BASE = new URL('.', import.meta.url).href;
const SHERPA_BASE = BASE + 'sherpa/';
const TEST_SENTENCE = '今天天气很好，我们一起去散步吧。';

const DEFAULTS = {
    enabled: true,
    onlyAI: true,
    autoPlay: false,
    autoVoice: true,
    engine: 'auto', // auto | sherpa | system
    readNarration: true,
    readDialogue: true,
    skipParen: true,
    skipTags: 'think,thinking,reasoning,details,summary,状态栏,StatusBlock',
    narratorVoice: '',
    maleVoice: '',
    femaleVoice: '',
    fixedVoice: '',
    userGender: 'male',
    speed: 1.0,
    volume: 1.0,
    scanCount: 40,
    scanned: {}, // 说话人编号 -> 基频 Hz
    charGender: {}, // 角色 -> auto | male | female
};

const sherpa = { tts: null, loading: null, available: null };
const P = { items: [], idx: 0, token: 0, state: 'idle', cur: null, mesId: null, needReplay: false, ctx: null };
let scanCancel = false;
let scanning = false;

const S = () => extension_settings[MODULE];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const say = (type, msg) => { try { toastr[type](msg, '听书'); } catch { console.log('[听书]', msg); } };

/* ---------------- 本地音源 (sherpa-onnx WASM) ---------------- */

async function probeSherpa() {
    if (sherpa.available !== null) return sherpa.available;
    try {
        const r = await fetch(SHERPA_BASE + 'sherpa-onnx-wasm-main-tts.js', { method: 'HEAD' });
        sherpa.available = r.ok;
    } catch { sherpa.available = false; }
    return sherpa.available;
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error('无法加载 ' + src));
        document.head.appendChild(el);
    });
}

function setStatus(text) { $('#stab_status').text(text); }

function ensureSherpa() {
    if (sherpa.tts) return Promise.resolve(true);
    if (sherpa.loading) return sherpa.loading;
    sherpa.loading = (async () => {
        if (!(await probeSherpa())) {
            setStatus('未找到本地音源文件（见安装说明，放进扩展目录的 sherpa 文件夹）');
            return false;
        }
        setStatus('正在加载本地音源，首次需要几十秒…');
        await new Promise((resolve, reject) => {
            window.Module = {
                locateFile: (p) => SHERPA_BASE + p,
                onRuntimeInitialized: () => {
                    try {
                        // createOfflineTts 由 sherpa-onnx-tts.js 提供
                        sherpa.tts = window.createOfflineTts(window.Module);
                        resolve();
                    } catch (e) { reject(e); }
                },
            };
            loadScript(SHERPA_BASE + 'sherpa-onnx-tts.js')
                .then(() => loadScript(SHERPA_BASE + 'sherpa-onnx-wasm-main-tts.js'))
                .catch(reject);
        });
        const preset = sherpaPreset();
        setStatus(preset
            ? `本地音源已就绪：${preset.name}，已套用中文男女声对应表，无需识别`
            : `本地音源已就绪：${sherpa.tts.numSpeakers} 个说话人，采样率 ${sherpa.tts.sampleRate} Hz。请点「识别男女声」`);
        $('#stab_scan_row').toggle(!preset);
        autoAssignDefaults();
        refreshVoiceSelects();
        return true;
    })().catch((e) => {
        console.error('[听书] 本地音源加载失败', e);
        setStatus('本地音源加载失败：' + e.message);
        sherpa.loading = null;
        return false;
    });
    return sherpa.loading;
}

function synthSherpa(text, sid, speed) {
    const a = sherpa.tts.generate({ text, sid, speed });
    return { samples: new Float32Array(a.samples), sampleRate: a.sampleRate || sherpa.tts.sampleRate };
}

/* ---------------- 声线目录 ---------------- */

// Kokoro 多语言模型自带中文男女声，编号见 sherpa-onnx 官方模型表。
// 说话人数量 53 = v1.0，103 = v1.1；其他模型走「识别男女声」。
const KOKORO_V10 = {
    45: 'zf_xiaobei', 46: 'zf_xiaoni', 47: 'zf_xiaoxiao', 48: 'zf_xiaoyi',
    49: 'zm_yunjian', 50: 'zm_yunxi', 51: 'zm_yunxia', 52: 'zm_yunyang',
};

function sherpaPreset() {
    const n = sherpa.tts ? sherpa.tts.numSpeakers : 0;
    if (n === 53) {
        return {
            name: 'Kokoro v1.0',
            list: Object.keys(KOKORO_V10).map(k => {
                const sid = Number(k);
                return { sid, gender: sid <= 48 ? 'female' : 'male', label: KOKORO_V10[sid] };
            }),
            defaults: { narrator: 52, male: 50, female: 47 },
        };
    }
    if (n === 103) {
        const list = [];
        for (let sid = 3; sid <= 57; sid++) list.push({ sid, gender: 'female', label: `中文女声 ${sid - 2}` });
        for (let sid = 58; sid <= 102; sid++) list.push({ sid, gender: 'male', label: `中文男声 ${sid - 57}` });
        return { name: 'Kokoro v1.1', list, defaults: { narrator: 59, male: 58, female: 3 } };
    }
    return null;
}

function sherpaGender(sid) {
    const preset = sherpaPreset();
    if (preset) {
        const hit = preset.list.find(v => v.sid === Number(sid));
        return hit ? hit.gender : null;
    }
    const f0 = S().scanned[sid];
    return f0 ? genderFromF0(f0) : null;
}

function systemVoices() {
    try {
        return speechSynthesis.getVoices().filter(v => /zh|cmn|yue/i.test(v.lang) || /chinese|中文|普通话/i.test(v.name));
    } catch { return []; }
}

function systemVoiceGender(v) {
    if (/female|woman|girl|女|xiaoxiao|xiaoyi|huihui|yaoyao|tingting|meijia|sinji/i.test(v.name)) return 'female';
    if (/\bmale\b|man\b|boy|男|yunxi|yunyang|yunjian|kangkang|danny|liang/i.test(v.name)) return 'male';
    return null;
}

const GENDER_MARK = { male: '♂ ', female: '♀ ' };

function listVoices() {
    const out = [];
    const preset = sherpaPreset();
    if (preset) {
        // 只列出中文声线，其他语言的说话人对中文用处不大
        for (const v of preset.list) {
            out.push({ id: 'sherpa:' + v.sid, label: `${GENDER_MARK[v.gender]}${v.label}`, group: '本地音源', gender: v.gender });
        }
    } else if (sherpa.tts) {
        for (let sid = 0; sid < sherpa.tts.numSpeakers; sid++) {
            const g = sherpaGender(sid);
            out.push({ id: 'sherpa:' + sid, label: `${g ? GENDER_MARK[g] : ''}说话人 ${sid}`, group: '本地音源', gender: g });
        }
    }
    for (const v of systemVoices()) {
        const g = systemVoiceGender(v);
        out.push({ id: 'sys:' + v.voiceURI, label: `${g ? GENDER_MARK[g] : ''}${v.name}`, group: '系统语音', gender: g });
    }
    return out;
}

function resolveVoice(id) {
    if (!id) return null;
    if (id.startsWith('sherpa:') && sherpa.tts) return { engine: 'sherpa', sid: parseInt(id.slice(7), 10), id };
    if (id.startsWith('sys:')) return { engine: 'system', uri: id.slice(4), id };
    return null;
}

function defaultVoice(gender) {
    const all = listVoices();
    const preferSherpa = all.some(v => v.id.startsWith('sherpa:'));
    const pool = all.filter(v => (preferSherpa ? v.id.startsWith('sherpa:') : true));
    const hit = gender ? pool.find(v => v.gender === gender) : null;
    const pick = hit || pool[0];
    if (pick) return resolveVoice(pick.id);
    return { engine: 'system', uri: '', id: '' };
}

function voiceFor(item) {
    const s = S();
    if (item.forceVoice) return resolveVoice(item.forceVoice) || defaultVoice(null);
    if (!s.autoVoice) return resolveVoice(s.fixedVoice) || defaultVoice(null);
    if (item.kind === 'narration' || !item.gender) return resolveVoice(s.narratorVoice) || defaultVoice('female');
    const pref = item.gender === 'female' ? s.femaleVoice : s.maleVoice;
    return resolveVoice(pref) || defaultVoice(item.gender);
}

function autoAssignDefaults() {
    const s = S();
    const all = listVoices().filter(v => v.id.startsWith('sherpa:'));
    const preset = sherpaPreset();
    if (preset) {
        const valid = (id) => all.some(v => v.id === id);
        const d = preset.defaults;
        if (!valid(s.narratorVoice)) s.narratorVoice = 'sherpa:' + d.narrator;
        if (!valid(s.maleVoice)) s.maleVoice = 'sherpa:' + d.male;
        if (!valid(s.femaleVoice)) s.femaleVoice = 'sherpa:' + d.female;
        if (!valid(s.fixedVoice)) s.fixedVoice = s.narratorVoice;
        saveSettingsDebounced();
        return;
    }
    const firstOf = (g) => (all.find(v => v.gender === g) || {}).id;
    if (!s.maleVoice && firstOf('male')) s.maleVoice = firstOf('male');
    if (!s.femaleVoice && firstOf('female')) s.femaleVoice = firstOf('female');
    if (!s.narratorVoice && (firstOf('female') || all[0])) s.narratorVoice = firstOf('female') || all[0].id;
    if (!s.fixedVoice && all[0]) s.fixedVoice = s.narratorVoice || all[0].id;
    saveSettingsDebounced();
}

/* ---------------- 播放 ---------------- */

let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended' && P.state !== 'paused') audioCtx.resume();
    return audioCtx;
}

function playSamples(clip, vol) {
    return new Promise((resolve) => {
        const ctx = getAudioCtx();
        const buf = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
        buf.copyToChannel(clip.samples, 0);
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = vol;
        src.buffer = buf;
        src.connect(gain);
        gain.connect(ctx.destination);
        P.cur = { engine: 'sherpa', stop: () => { try { src.stop(); } catch { /* 已结束 */ } } };
        src.onended = () => resolve();
        src.start();
    });
}

function speakSystem(clip, speed, vol) {
    return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(clip.text);
        u.lang = 'zh-CN';
        const v = speechSynthesis.getVoices().find(x => x.voiceURI === clip.uri);
        if (v) { u.voice = v; u.lang = v.lang; }
        // 没有区分男女的系统语音时，用音调做粗略区分
        if (!v || !systemVoiceGender(v)) u.pitch = clip.gender === 'male' ? 0.7 : clip.gender === 'female' ? 1.15 : 1;
        u.rate = clamp(speed, 0.5, 2);
        u.volume = vol;
        u.onend = u.onerror = () => resolve();
        P.cur = { engine: 'system', stop: () => speechSynthesis.cancel() };
        speechSynthesis.speak(u);
    });
}

function prepare(i, t) {
    const item = P.items[i];
    const v = voiceFor(item);
    if (v.engine === 'sherpa' && sherpa.tts) {
        return new Promise((resolve) => setTimeout(() => {
            if (t !== P.token) return resolve(null);
            try { resolve({ engine: 'sherpa', ...synthSherpa(item.text, v.sid, S().speed) }); }
            catch (e) { console.error('[听书] 合成失败', e); resolve({ engine: 'error' }); }
        }, 0));
    }
    return Promise.resolve({ engine: 'system', text: item.text, uri: v.uri || '', gender: item.gender });
}

async function waitWhilePaused(t) {
    while (P.state === 'paused' && t === P.token) await sleep(200);
}

async function runLoop(t) {
    try {
        const mode = S().engine;
        if (mode !== 'system') {
            if (mode === 'sherpa' || (mode === 'auto' && await probeSherpa())) await ensureSherpa();
        }
        if (t !== P.token) return;
        if (sherpa.tts && !sherpaPreset() && S().autoVoice && !Object.keys(S().scanned).length) {
            say('info', '还没识别男女声，目前男女对白会用同一个声线。到设置里点「识别男女声」即可。');
        }
        let pending = prepare(P.idx, t);
        while (P.idx < P.items.length && t === P.token) {
            const i = P.idx;
            const clip = await pending;
            if (t !== P.token || !clip) return;
            pending = i + 1 < P.items.length ? prepare(i + 1, t) : null;
            updateBar();
            if (clip.engine !== 'error') {
                let redo;
                do {
                    redo = false;
                    await waitWhilePaused(t);
                    if (t !== P.token) return;
                    if (clip.engine === 'sherpa') await playSamples(clip, S().volume);
                    else await speakSystem(clip, S().speed, S().volume);
                    if (t !== P.token) return;
                    if (P.needReplay) { // 系统语音暂停时被取消，恢复后重读这一句
                        P.needReplay = false;
                        redo = true;
                    }
                } while (redo);
            }
            if (t !== P.token) return;
            P.idx = i + 1;
            if (!pending) break;
        }
        if (t === P.token) stopAll();
    } catch (e) {
        console.error('[听书] 播放出错', e);
        say('error', '播放出错：' + e.message);
        if (t === P.token) stopAll();
    }
}

function stopAudioOnly() {
    try { if (P.cur) P.cur.stop(); } catch { /* 忽略 */ }
    try { speechSynthesis.cancel(); } catch { /* 忽略 */ }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function stopAll() {
    P.token++;
    stopAudioOnly();
    P.state = 'idle';
    P.needReplay = false;
    P.items = [];
    P.idx = 0;
    $('#chat .mes.stab-playing').removeClass('stab-playing');
    P.mesId = null;
    updateBar();
}

function startPlayback(items, mesId) {
    if (!items.length) { say('info', '没有可朗读的内容'); return; }
    P.token++;
    stopAudioOnly();
    $('#chat .mes.stab-playing').removeClass('stab-playing');
    P.items = items;
    P.idx = 0;
    P.mesId = mesId ?? null;
    P.state = 'playing';
    P.needReplay = false;
    if (mesId != null) $(`#chat .mes[mesid="${mesId}"]`).addClass('stab-playing');
    updateBar();
    runLoop(P.token);
}

function togglePause() {
    if (P.state === 'playing') {
        P.state = 'paused';
        if (P.cur && P.cur.engine === 'sherpa' && audioCtx) audioCtx.suspend();
        else { P.needReplay = true; try { speechSynthesis.cancel(); } catch { /* 忽略 */ } }
    } else if (P.state === 'paused') {
        P.state = 'playing';
        if (P.cur && P.cur.engine === 'sherpa' && audioCtx) audioCtx.resume();
    }
    updateBar();
}

function jump(delta) {
    if (P.state === 'idle') return;
    const target = clamp(P.idx + delta, 0, P.items.length);
    if (target >= P.items.length) { stopAll(); return; }
    P.token++;
    stopAudioOnly();
    P.idx = target;
    P.state = 'playing';
    P.needReplay = false;
    updateBar();
    runLoop(P.token);
}

/* ---------------- 把酒馆消息变成朗读队列 ---------------- */

function findChar(ctx, msg) {
    if (msg && !msg.is_user && msg.name) {
        const c = ctx.characters.find(x => x.name === msg.name);
        if (c) return c;
    }
    return ctx.characters[ctx.characterId] || null;
}

function charKey(c) { return c ? (c.avatar || c.name) : ''; }

function resolveCharGender(c) {
    const o = c ? S().charGender[charKey(c)] : null;
    if (o === 'male' || o === 'female') return o;
    return characterGender(c);
}

function buildForMessage(mesId) {
    const ctx = getContext();
    const msg = ctx.chat[mesId];
    const s = S();
    if (!msg || msg.is_system) return [];
    if (s.onlyAI && msg.is_user) return [];
    const ch = findChar(ctx, msg);
    const charGender = resolveCharGender(ch);
    const clean = cleanText(msg.mes, { skipParen: s.skipParen, skipTags: s.skipTags });
    return buildItems(clean, {
        charName: ch ? ch.name : '',
        userName: ctx.name1,
        charGender,
        userGender: s.userGender,
        fallbackGender: msg.is_user ? s.userGender : charGender,
        readNarration: s.readNarration,
        readDialogue: s.readDialogue,
    });
}

function playMessage(mesId) {
    if (!S().enabled) return;
    startPlayback(buildForMessage(mesId), mesId);
}

function lastReadableMesId() {
    const chat = getContext().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m.is_system) continue;
        if (S().onlyAI && m.is_user) continue;
        return i;
    }
    return -1;
}

/* ---------------- 自动识别男女声 ---------------- */

async function scanVoices() {
    if (scanning) { scanCancel = true; return; }
    if (!(await ensureSherpa())) { say('warning', '请先放好本地音源文件并加载'); return; }
    if (sherpaPreset()) { say('info', '这个模型已内置中文男女声对应表，不需要识别'); return; }
    const s = S();
    const total = sherpa.tts.numSpeakers;
    const todo = [];
    for (let sid = 0; sid < total && todo.length < s.scanCount; sid++) if (!s.scanned[sid]) todo.push(sid);
    if (!todo.length) { say('info', '所有说话人都已识别过了'); return; }
    scanning = true; scanCancel = false;
    $('#stab_scan').text('停止识别');
    let done = 0;
    for (const sid of todo) {
        if (scanCancel) break;
        try {
            const clip = synthSherpa(TEST_SENTENCE, sid, 1);
            s.scanned[sid] = Math.round(estimateF0(clip.samples, clip.sampleRate)) || -1;
        } catch (e) { console.error(e); s.scanned[sid] = -1; }
        done++;
        setStatus(`正在识别男女声：${done}/${todo.length}`);
        await sleep(10);
    }
    for (const k of Object.keys(s.scanned)) if (s.scanned[k] === -1) s.scanned[k] = 0;
    scanning = false; scanCancel = false;
    $('#stab_scan').text('识别男女声');
    saveSettingsDebounced();
    const males = Object.keys(s.scanned).filter(k => sherpaGender(k) === 'male').length;
    const females = Object.keys(s.scanned).filter(k => sherpaGender(k) === 'female').length;
    setStatus(`识别完成：已识别 ${males} 个男声、${females} 个女声（共 ${total} 个说话人）`);
    autoAssignDefaults();
    refreshVoiceSelects();
}

/* ---------------- 界面 ---------------- */

const VOICE_SELECTS = [
    ['stab_narrator', 'narratorVoice'],
    ['stab_male', 'maleVoice'],
    ['stab_female', 'femaleVoice'],
    ['stab_fixed', 'fixedVoice'],
];

function refreshVoiceSelects() {
    const voices = listVoices();
    for (const [id, key] of VOICE_SELECTS) {
        const sel = $('#' + id);
        if (!sel.length) continue;
        let html = '<option value="">（自动选择）</option>';
        for (const group of ['本地音源', '系统语音']) {
            const g = voices.filter(v => v.group === group);
            if (!g.length) continue;
            html += `<optgroup label="${group}">` + g.map(v => `<option value="${v.id}">${v.label}</option>`).join('') + '</optgroup>';
        }
        sel.html(html).val(S()[key] || '');
    }
}

function refreshCharGenderUI() {
    const ctx = getContext();
    const c = ctx.characters[ctx.characterId];
    const row = $('#stab_char_row');
    if (!c) { row.hide(); return; }
    row.show();
    $('#stab_char_name').text(c.name);
    $('#stab_char_gender').val(S().charGender[charKey(c)] || 'auto');
}

function settingsHtml() {
    const sel = (id) => `<select id="${id}" class="text_pole"></select>`;
    return `
<div class="inline-drawer" id="stab_drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>🎧 听书 Audiobook</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="checkbox_label"><input type="checkbox" id="stab_enabled"><span>启用听书</span></label>
    <label class="checkbox_label"><input type="checkbox" id="stab_onlyAI"><span>只朗读 AI 生成的文字</span></label>
    <label class="checkbox_label"><input type="checkbox" id="stab_autoPlay"><span>自动朗诵新消息</span></label>
    <label class="checkbox_label"><input type="checkbox" id="stab_autoVoice"><span>自动切换声线（旁白 / 男声 / 女声）</span></label>

    <div class="stab-row"><label>声音引擎</label>
      <select id="stab_engine" class="text_pole">
        <option value="auto">自动（有本地音源就用本地）</option>
        <option value="sherpa">仅本地音源</option>
        <option value="system">仅系统语音</option>
      </select></div>
    <div class="stab-row"><small id="stab_status">本地音源未加载</small></div>
    <div class="stab-row stab-buttons">
      <div class="menu_button" id="stab_load">加载本地音源</div>
    </div>
    <div id="stab_scan_row">
      <div class="stab-row stab-buttons"><div class="menu_button" id="stab_scan">识别男女声</div></div>
      <div class="stab-row"><label>每次识别数量</label><input type="number" id="stab_scanCount" class="text_pole" min="5" max="300" step="5"></div>
    </div>

    <hr>
    <div class="stab-row"><label>旁白声线</label>${sel('stab_narrator')}<div class="menu_button stab-test" data-target="stab_narrator">试听</div></div>
    <div class="stab-row"><label>男声声线</label>${sel('stab_male')}<div class="menu_button stab-test" data-target="stab_male">试听</div></div>
    <div class="stab-row"><label>女声声线</label>${sel('stab_female')}<div class="menu_button stab-test" data-target="stab_female">试听</div></div>
    <div class="stab-row"><label>统一声线（关闭自动切换时使用）</label>${sel('stab_fixed')}<div class="menu_button stab-test" data-target="stab_fixed">试听</div></div>

    <hr>
    <div class="stab-row" id="stab_char_row"><label>当前角色「<span id="stab_char_name"></span>」性别</label>
      <select id="stab_char_gender" class="text_pole">
        <option value="auto">自动判断</option><option value="male">男</option><option value="female">女</option>
      </select></div>
    <div class="stab-row"><label>我（用户）的性别</label>
      <select id="stab_userGender" class="text_pole"><option value="male">男</option><option value="female">女</option></select></div>

    <label class="checkbox_label"><input type="checkbox" id="stab_readNarration"><span>朗读旁白</span></label>
    <label class="checkbox_label"><input type="checkbox" id="stab_readDialogue"><span>朗读对白</span></label>
    <label class="checkbox_label"><input type="checkbox" id="stab_skipParen"><span>跳过括号里的内容（）【】[]</span></label>
    <div class="stab-row"><label>整段忽略的标签（逗号分隔）</label><input type="text" id="stab_skipTags" class="text_pole"></div>

    <div class="stab-row"><label>语速 <span id="stab_speed_v"></span></label><input type="range" id="stab_speed" min="0.6" max="2" step="0.1"></div>
    <div class="stab-row"><label>音量 <span id="stab_volume_v"></span></label><input type="range" id="stab_volume" min="0.1" max="1" step="0.05"></div>
  </div>
</div>`;
}

function bindSettings() {
    const s = S();
    const checks = ['enabled', 'onlyAI', 'autoPlay', 'autoVoice', 'readNarration', 'readDialogue', 'skipParen'];
    for (const k of checks) {
        $('#stab_' + k).prop('checked', !!s[k]).on('change', function () { s[k] = this.checked; saveSettingsDebounced(); });
    }
    $('#stab_engine').val(s.engine).on('change', function () { s.engine = this.value; saveSettingsDebounced(); });
    $('#stab_userGender').val(s.userGender).on('change', function () { s.userGender = this.value; saveSettingsDebounced(); });
    $('#stab_skipTags').val(s.skipTags).on('input', function () { s.skipTags = this.value; saveSettingsDebounced(); });
    $('#stab_scanCount').val(s.scanCount).on('change', function () { s.scanCount = clamp(parseInt(this.value, 10) || 40, 5, 300); saveSettingsDebounced(); });
    for (const [k, label] of [['speed', '#stab_speed_v'], ['volume', '#stab_volume_v']]) {
        $('#stab_' + k).val(s[k]).on('input', function () { s[k] = parseFloat(this.value); $(label).text(s[k].toFixed(2)); saveSettingsDebounced(); });
        $(label).text(Number(s[k]).toFixed(2));
    }
    for (const [id, key] of VOICE_SELECTS) {
        $('#' + id).on('change', function () { s[key] = this.value; saveSettingsDebounced(); });
    }
    $('#stab_char_gender').on('change', function () {
        const ctx = getContext();
        const c = ctx.characters[ctx.characterId];
        if (c) { s.charGender[charKey(c)] = this.value; saveSettingsDebounced(); }
    });
    $('#stab_load').on('click', async () => { getAudioCtx(); await ensureSherpa(); });
    $('#stab_scan').on('click', () => { getAudioCtx(); scanVoices(); });
    $(document).on('click', '.stab-test', async function () {
        getAudioCtx();
        const id = $('#' + $(this).data('target')).val();
        if (id && id.startsWith('sherpa:')) await ensureSherpa();
        startPlayback([{ text: TEST_SENTENCE, kind: 'narration', gender: null, forceVoice: id || undefined }], null);
    });
    refreshVoiceSelects();
    refreshCharGenderUI();
}

/* ---------------- 悬浮播放条 & 消息按钮 ---------------- */

function createBar() {
    $('body').append(`
<div id="stab_bar" class="stab-idle">
  <div class="stab-fab fa-solid fa-headphones" id="stab_fab" title="朗读最新一条"></div>
  <div class="stab-controls">
    <div class="stab-btn fa-solid fa-backward-step" id="stab_prev" title="上一句"></div>
    <div class="stab-btn fa-solid fa-pause" id="stab_pp" title="暂停/继续"></div>
    <div class="stab-btn fa-solid fa-forward-step" id="stab_next" title="下一句"></div>
    <div class="stab-btn fa-solid fa-stop" id="stab_stop" title="停止"></div>
    <div class="stab-btn" id="stab_rate" title="倍速"></div>
  </div>
</div>`);
    $('#stab_fab').on('click', () => {
        getAudioCtx();
        const id = lastReadableMesId();
        if (id >= 0) playMessage(id); else say('info', '没有可朗读的消息');
    });
    $('#stab_pp').on('click', togglePause);
    $('#stab_prev').on('click', () => jump(-1));
    $('#stab_next').on('click', () => jump(1));
    $('#stab_stop').on('click', stopAll);
    $('#stab_rate').on('click', () => {
        const steps = [0.8, 1.0, 1.2, 1.5, 1.8];
        const cur = S().speed;
        const nxt = steps.find(x => x > cur + 0.01) || steps[0];
        S().speed = nxt;
        $('#stab_speed').val(nxt); $('#stab_speed_v').text(nxt.toFixed(2));
        saveSettingsDebounced();
        updateBar();
    });
}

function updateBar() {
    const bar = $('#stab_bar');
    if (!bar.length) return;
    const active = P.state !== 'idle';
    bar.toggleClass('stab-idle', !active).toggleClass('stab-active', active);
    $('#stab_pp').toggleClass('fa-pause', P.state === 'playing').toggleClass('fa-play', P.state === 'paused');
    $('#stab_rate').text(Number(S().speed).toFixed(1) + '×');
    bar.toggle(!!S().enabled);
}

function injectMessageButtons() {
    $('#chat .mes').each(function () {
        const mes = $(this);
        if (mes.find('.stab-msg-btn').length) return;
        const host = mes.find('.extraMesButtons').first().length ? mes.find('.extraMesButtons').first() : mes.find('.mes_buttons').first();
        if (!host.length) return;
        host.prepend('<div class="mes_button stab-msg-btn fa-solid fa-headphones" title="朗读这条消息"></div>');
    });
}

function bindChatEvents() {
    $(document).on('click', '.stab-msg-btn', function (e) {
        e.stopPropagation();
        getAudioCtx();
        const id = parseInt($(this).closest('.mes').attr('mesid'), 10);
        if (Number.isNaN(id)) return;
        if (P.state !== 'idle' && P.mesId === id) togglePause(); else playMessage(id);
    });
    const chatEl = document.getElementById('chat');
    if (chatEl) new MutationObserver(() => injectMessageButtons()).observe(chatEl, { childList: true });
    injectMessageButtons();

    const onNew = (id) => {
        injectMessageButtons();
        if (S().enabled && S().autoPlay) playMessage(Number(id));
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onNew);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (id) => {
        injectMessageButtons();
        if (S().enabled && S().autoPlay && !S().onlyAI) playMessage(Number(id));
    });
    eventSource.on(event_types.GENERATION_STARTED, () => { if (P.state !== 'idle') stopAll(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { stopAll(); setTimeout(() => { injectMessageButtons(); refreshCharGenderUI(); }, 300); });
}

/* ---------------- 启动 ---------------- */

jQuery(async () => {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE]);
    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    createBar();
    bindChatEvents();
    updateBar();
    // 手机浏览器要求有过一次点击之后才能出声：第一次触摸时解锁
    $(document).one('pointerdown', () => { try { getAudioCtx(); } catch { /* 忽略 */ } });
    try { speechSynthesis.addEventListener('voiceschanged', refreshVoiceSelects); } catch { /* 忽略 */ }

    if (await probeSherpa()) {
        setStatus('检测到本地音源文件，点「加载本地音源」或直接开始朗读（首次加载需几十秒）');
    } else {
        setStatus('未找到本地音源文件，目前使用系统语音');
    }
    console.log('[听书] 扩展已加载');
});
