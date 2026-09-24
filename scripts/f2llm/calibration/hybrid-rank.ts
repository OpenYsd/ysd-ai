/**
 * ترتيبٌ هجين: متجهُ F2LLM + تطابقٌ لفظيٌّ محدود، مدموجان بالرتبة (RRF).
 *
 * ★ لماذا
 *
 *   قيس على staging: سؤالٌ عربيٌّ عن مستندٍ إنجليزيٍّ طويل رتّب F2LLM مقطعَ
 *   الجواب بعد ستّة مقاطع أخرى، فلم يدخل الموجّه، وقال النموذج صادقًا إن
 *   المعلومة غير موجودة. الترتيبُ عبر اللغتين أضعفُ منه داخل اللغة الواحدة.
 *   لكنّ السؤالَ والجوابَ يتشاركان كثيرًا ما لا يُترجَم: الأرقامَ والسنواتِ
 *   والرموزَ والأسماءَ اللاتينيّة («2021»، «QX-7741»، «CKA»).
 *
 * ★ المحدود
 *
 *   يعمل على المرشّحين وحدهم (ما أعاده البحث المتّجه، وما وجده البحثُ اللفظيّ
 *   المحدود في القاعدة)، بلا نداء نموذجٍ ولا ذاكرةٍ إضافيّة تُذكر. ولا يرفع
 *   أيَّ حدّ: الميزانيةُ نفسُها (عددُ المقاطع والأحرف) تُطبَّق بعد الدمج.
 *   وحين لا يشترك السؤالُ والمقاطعُ في شيء، يبقى الترتيبُ المتّجهيُّ كما هو.
 */

export interface RankedCandidate {
  /** معرّفٌ محلّيّ للمقطع (فهرسٌ أو مفتاح) */
  index: number;
  similarity: number;
}

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** تطبيعٌ يجعل «أ/إ/آ»، «ى/ي»، «ة/ه» والأرقامَ الهنديّة شيئًا واحدًا */
export function normalizeForLexical(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

const EN_STOP = new Set(
  "the and for with that this from what which when where who whom how many much does did was were are has have had his her its their them they into over under about than then also only very more most such been being will would could should there here your you our not any all per via".split(
    " ",
  ),
);
const AR_STOP = new Set(
  [
    "في", "من", "علي", "الي", "عن", "مع", "هذا", "هذه", "ذلك", "تلك", "التي", "الذي", "الذين", "كان", "كانت",
    "يكون", "ما", "ماذا", "متي", "كيف", "كم", "هل", "اين", "لماذا", "اي", "او", "ثم", "قد", "لقد", "لم", "لن",
    "ان", "انه", "انها", "هو", "هي", "هم", "بين", "عند", "كل", "بعد", "قبل", "حتي", "اذا", "لكن", "غير",
  ].map((w) => normalizeForLexical(w)),
);

/** يُجرّد «ال» وحروفَ العطف والجرّ الملتصقة — تجذيرٌ خفيفٌ يكفي للمطابقة */
function lightArabicStem(w: string): string {
  let s = w;
  for (const p of ["وال", "بال", "كال", "فال", "لل", "ال"]) {
    if (s.startsWith(p) && s.length - p.length >= 3) {
      s = s.slice(p.length);
      break;
    }
  }
  if (s.length >= 5 && (s.startsWith("و") || s.startsWith("ف"))) s = s.slice(1);
  for (const suf of ["ات", "ون", "ين", "ها", "هم", "ه"]) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

/** الرموزُ المميِّزة: أرقامٌ (≥ خانتين)، وكلماتٌ لاتينيّة (≥ 3)، وعربيّة (≥ 3) بعد التجذير */
export function lexicalTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeForLexical(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (/^\d+$/.test(raw)) {
      if (raw.length >= 2) out.add(raw);
      continue;
    }
    if (/^[a-z0-9]+$/.test(raw)) {
      if (raw.length >= 3 && !EN_STOP.has(raw)) out.add(raw);
      continue;
    }
    if (/\p{Script=Arabic}/u.test(raw)) {
      if (raw.length < 3 || AR_STOP.has(raw)) continue;
      const stem = lightArabicStem(raw);
      if (stem.length >= 3 && !AR_STOP.has(stem)) out.add(stem);
    }
  }
  return out;
}

/** أرقامُ السؤال ورموزُه اللاتينيّة — ما يُبحث عنه لفظيًّا في القاعدة (محدودٌ ومرتَّبٌ بالطول) */
export function lexicalProbeTerms(query: string, max = 4): string[] {
  const terms = [...lexicalTokens(query)].filter((t) => /^\d{2,}$/.test(t) || /^[a-z][a-z0-9]{2,}$/.test(t));
  return terms.sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * يدمج الترتيبَ المتّجهيَّ بترتيبٍ لفظيّ (IDF على المرشّحين) عبر RRF.
 * المقاطعُ بلا أيّ تطابقٍ لفظيّ تبقى في مواضعها المتّجهيّة النسبيّة.
 */
export function hybridRank(query: string, vectorRank: RankedCandidate[], contents: string[], k = 60): RankedCandidate[] {
  const qTokens = lexicalTokens(query);
  if (qTokens.size === 0 || vectorRank.length === 0) return vectorRank;
  const chunkTokens = new Map<number, Set<string>>();
  for (const c of vectorRank) chunkTokens.set(c.index, lexicalTokens(contents[c.index] ?? ""));
  const n = vectorRank.length;
  const df = new Map<string, number>();
  for (const toks of chunkTokens.values()) for (const t of qTokens) if (toks.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const lexScore = new Map<number, number>();
  for (const [idx, toks] of chunkTokens) {
    let s = 0;
    for (const t of qTokens) if (toks.has(t)) s += Math.log(1 + n / (df.get(t) ?? 1));
    if (s > 0) lexScore.set(idx, s);
  }
  if (lexScore.size === 0) return vectorRank;
  const lexOrder = [...lexScore.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const fused = new Map<number, number>();
  vectorRank.forEach((c, r) => fused.set(c.index, 1 / (k + r + 1)));
  lexOrder.forEach((idx, r) => fused.set(idx, (fused.get(idx) ?? 0) + 1 / (k + r + 1)));
  const bySim = new Map(vectorRank.map((c) => [c.index, c.similarity]));
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || (bySim.get(b[0]) ?? 0) - (bySim.get(a[0]) ?? 0))
    .map(([index]) => ({ index, similarity: bySim.get(index) ?? 0 }));
}
