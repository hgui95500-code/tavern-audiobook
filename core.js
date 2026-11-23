// core.js —— 纯逻辑：文本清洗、旁白/对白切分、说话人性别判断、音高估计。
// 不依赖酒馆，可在 Node 里单独测试。

const FEMALE_WORDS = ['女', '姑娘', '小姐', '姐', '妹', '妈', '母亲', '娘', '妻', '夫人', '公主', '王后', '阿姨', '奶奶', '婆', '太太', '少妇', '闺'];
const MALE_WORDS = ['男', '少年', '先生', '哥', '弟', '爸', '父亲', '叔', '爷', '夫君', '丈夫', '王子', '国王', '大叔', '公子', '兄', '汉子'];

function countOf(text, word) {
    let n = 0, i = 0;
    while ((i = text.indexOf(word, i)) !== -1) { n++; i += word.length; }
    return n;
}

function safeRegex(src, flags, fallbackSrc) {
    try { return new RegExp(src, flags); } catch { return new RegExp(fallbackSrc, flags); }
}

const RE_HE = safeRegex('(?<![其另])他(?![人们处])', 'g', '他');
const RE_SHE = /她/g;
const RE_EN_F = /\b(she|her|hers|woman|girl|female|lady|mother|sister)\b/gi;
const RE_EN_M = /\b(he|his|him|man|boy|male|sir|father|brother)\b/gi;

/** 统计文本里偏男/偏女的线索数量 */
export function countGender(text) {
    const t = text || '';
    let f = (t.match(RE_SHE) || []).length * 2;
    let m = (t.match(RE_HE) || []).length * 2;
    for (const w of FEMALE_WORDS) f += countOf(t, w);
    for (const w of MALE_WORDS) m += countOf(t, w);
    f += (t.match(RE_EN_F) || []).length;
    m += (t.match(RE_EN_M) || []).length;
    return { m, f };
}

/** 根据角色卡判断角色性别，返回 'male' | 'female' | null */
export function characterGender(char) {
    if (!char) return null;
    const text = [char.description, char.personality, char.scenario].filter(Boolean).join('\n');
    const explicit = text.match(/(性别|gender|sex)\s*[:：=]\s*(女|男|female|male|woman|man)/i);
    if (explicit) {
        return /女|female|woman/i.test(explicit[2]) ? 'female' : 'male';
    }
    const { m, f } = countGender(text);
    if (f > m) return 'female';
    if (m > f) return 'male';
    return null;
}

/** 清洗要朗读的文本 */
export function cleanText(raw, opts = {}) {
    let t = String(raw ?? '');
    const tags = String(opts.skipTags || '').split(/[,，\s]+/).filter(Boolean);
    for (const tag of tags) {
        const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`<${esc}(\\s[^>]*)?>[\\s\\S]*?</${esc}>`, 'gi'), '');
    }
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/https?:\/\/\S+/g, '');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (opts.skipParen) {
        t = t.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '').replace(/【[^【】]*】/g, '').replace(/\[[^\[\]]*\]/g, '');
    }
    t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*>\s?/gm, '');
    t = t.replace(/[*_~`]+/g, '');
    try { t = t.replace(/\p{Extended_Pictographic}/gu, ''); } catch { /* 旧浏览器忽略 */ }
    t = t.replace(/[ \t　]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    return t;
}

const QUOTE_RE = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g;

/** 切成 旁白 / 对白 段，并带上前后文用于判断说话人 */
export function segment(text) {
    const out = [];
    let last = 0, m;
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(text)) !== null) {
        if (m.index > last) out.push({ kind: 'narration', text: text.slice(last, m.index) });
        out.push({
            kind: 'dialogue',
            text: m[0].slice(1, -1),
            // 前后文只取同一段落内、相邻引号之间的叙述，避免把别人的线索算进来
            before: text.slice(Math.max(0, m.index - 24), m.index).split(/\n|“|”|「|」|『|』|"/).pop(),
            after: text.slice(m.index + m[0].length, m.index + m[0].length + 24).split(/\n|“|”|「|」|『|』|"/)[0],
        });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'narration', text: text.slice(last) });
    return out;
}

const SPEAKABLE = /[\p{L}\p{N}]/u;

/** 把一段文字切成适合逐句合成的短句 */
export function splitSentences(text, maxLen = 60) {
    const raw = text.match(/[^。！？!?；;\n]+[。！？!?；;…]*/g) || [];
    const pieces = [];
    for (let p of raw) {
        p = p.trim();
        if (!p) continue;
        while (p.length > maxLen) {
            let cut = -1;
            for (let i = maxLen; i > maxLen / 2; i--) {
                if ('，,、：: '.includes(p[i])) { cut = i + 1; break; }
            }
            if (cut < 0) cut = maxLen;
            pieces.push(p.slice(0, cut));
            p = p.slice(cut);
        }
        if (p) pieces.push(p);
    }
    const merged = [];
    for (const p of pieces) {
        const prev = merged[merged.length - 1];
        if (prev !== undefined && prev.length < 8 && prev.length + p.length <= maxLen) merged[merged.length - 1] = prev + p;
        else merged.push(p);
    }
    return merged.filter(s => SPEAKABLE.test(s));
}

/** 判断一句对白是谁说的（男/女），拿不准就返回 fallback */
export function inferDialogueGender(before, after, ctx) {
    const b = before.slice(-20);
    const a = after.slice(0, 20);
    const cb = countGender(b), ca = countGender(a);
    let m = cb.m + ca.m, f = cb.f + ca.f;
    const near = b + '|' + a;
    if (ctx.charName && near.includes(ctx.charName)) {
        if (ctx.charGender === 'male') m += 3; else if (ctx.charGender === 'female') f += 3;
    }
    if (ctx.userName && near.includes(ctx.userName)) {
        if (ctx.userGender === 'male') m += 3; else if (ctx.userGender === 'female') f += 3;
    }
    if (f > m) return 'female';
    if (m > f) return 'male';
    return ctx.fallbackGender || null;
}

/**
 * 把一条消息变成朗读队列。
 * ctx: { charName, userName, charGender, userGender, fallbackGender, readNarration, readDialogue }
 * 返回 [{ text, kind: 'narration'|'dialogue', gender: 'male'|'female'|null }]
 */
export function buildItems(clean, ctx) {
    const items = [];
    for (const seg of segment(clean)) {
        if (seg.kind === 'narration' && !ctx.readNarration) continue;
        if (seg.kind === 'dialogue' && !ctx.readDialogue) continue;
        const gender = seg.kind === 'dialogue' ? inferDialogueGender(seg.before, seg.after, ctx) : null;
        for (const s of splitSentences(seg.text, ctx.maxLen || 60)) items.push({ text: s, kind: seg.kind, gender });
    }
    return items;
}

/** 用自相关估计基频，返回中位数 Hz（失败返回 0） */
export function estimateF0(x, sr) {
    const win = Math.floor(sr * 0.04), hop = Math.floor(sr * 0.02);
    const minLag = Math.max(2, Math.floor(sr / 400)), maxLag = Math.floor(sr / 70);
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rmsAll = Math.sqrt(e / Math.max(1, x.length));
    const f0s = [];
    const nacf = new Float32Array(maxLag + 1);
    for (let st = 0; st + win + maxLag < x.length; st += hop) {
        let r0 = 0;
        for (let i = 0; i < win; i++) r0 += x[st + i] * x[st + i];
        if (Math.sqrt(r0 / win) < rmsAll * 0.6) continue;
        let best = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let c = 0, rl = 0;
            for (let i = 0; i < win; i++) {
                const y = x[st + i + lag];
                c += x[st + i] * y;
                rl += y * y;
            }
            const n = c / Math.sqrt(r0 * rl + 1e-9);
            nacf[lag] = n;
            if (n > best) best = n;
        }
        if (best < 0.5) continue;
        // 取第一个接近最大值的峰，避免跳到二倍周期（八度错误）
        for (let lag = minLag + 1; lag < maxLag; lag++) {
            if (nacf[lag] >= best * 0.9 && nacf[lag] >= nacf[lag - 1] && nacf[lag] >= nacf[lag + 1]) {
                f0s.push(sr / lag);
                break;
            }
        }
    }
    if (f0s.length < 3) return 0;
    f0s.sort((a, b) => a - b);
    return f0s[Math.floor(f0s.length / 2)];
}

export function genderFromF0(f0) {
    if (!f0) return null;
    return f0 < 155 ? 'male' : 'female';
}
