/**
 * استعلامُ الاسترجاع لدورِ «متابعةٍ مجرّدة» («كمل» / «continue» …) في محادثةٍ فيها ملفّات.
 *
 * ★ العطل (مرصودٌ على staging): بعد جوابٍ مستنِدٍ إلى الملفّات قُطع بثُّه كتب المستخدم «continue». السياقُ وصل النموذجَ
 *   صحيحًا، لكنّ الاسترجاع ضمَّن كلمةَ «continue» نفسَها وبحث بها (أعلى تشابه 0.281) فجاءت مقاطعُ لا صلةَ لها، وقال
 *   النموذج إنّ المصادر لا تحوي الجواب. والأمرُ نفسُه لكلّ متابعةٍ قصيرة في محادثةٍ فيها ملفّات.
 *
 * ★ الإصلاح — أصغرُ تغييرٍ آمن:
 *   - الرسالةُ «متابعةٌ مجرّدة» إن كانت كلُّ كلماتها من معجمٍ ضيّق (أفعالُ المتابعة بالعربيّة والإنجليزيّة + كلماتُ
 *     مجاملةٍ وحشوٍ لا محتوى فيها) وفيها فعلُ متابعةٍ واحدٌ على الأقلّ. أيُّ كلمةِ محتوى واحدة ⇒ ليست متابعة.
 *   - عندها يصير استعلامُ الاسترجاع آخرَ سؤالٍ حقيقيٍّ في **سياق النموذج المبنيّ** (`history` من gatherChatContext):
 *     سياقٌ محصورٌ في هذه المحادثة، بلا إشعاراتِ فشلٍ ولا أسئلةٍ بلا جواب، ونافذتُه 30 رسالة. فلا يُبعث سؤالٌ فاشل،
 *     ولا يتسرّب شيءٌ من محادثةٍ أخرى، ولا تُقرأ القاعدةُ مرّةً أخرى.
 *   - وأيُّ رسالةٍ أخرى (سؤالٌ جديد، كلمةٌ مفتاحيّة، «لا تكمل»، «more details»…) تبقى استعلامَها حرفًا بحرف.
 *   - لا تضمينَ إضافيًّا ولا رحلةَ قاعدةٍ إضافيّة: ما يتغيّر هو نصُّ الاستعلام الممرَّر للاسترجاع وحده؛ النموذجُ يرى
 *     دورَ «كمل» كما كتبه المستخدم.
 *
 * الوحدةُ نقيّة: لا قاعدةَ ولا شبكةَ ولا بيئةَ ولا حالةً قابلةً للتغيّر.
 */
import type { ChatMessage } from "../ai/types";

/** أطولُ رسالةٍ تُفحص أصلًا — ما فوقها ليس متابعةً مجرّدة ولا يُطبَّع */
export const BARE_FOLLOW_UP_MAX_CHARS = 80;
/** أقصى كلماتٍ بعد التطبيع — القائمةُ البيضاء هي الحارس؛ السقفُ يحدّ العملَ فقط (مجاملةٌ مضاعفة تبلغ ١٠ كلمات) */
export const BARE_FOLLOW_UP_MAX_TOKENS = 12;

export type RetrievalQuerySource = "message" | "continued";

/**
 * أفعالُ المتابعة — كلمةٌ واحدةٌ منها تكفي (مخزّنةٌ مطبَّعة: أ/إ/آ ⇒ ا، ة ⇒ ه، ى ⇒ ي).
 * ليست هنا عمدًا: resume (ملفُّ سيرةٍ ذاتيّة)، rest/go وحدهما، كلماتُ الإعادة (again/أعد/حاول)،
 * كلماتُ الشرح (details/explain/اشرح/وضح)، والنفيُ والإيقاف (no/not/don't/stop/لا/ما/توقف/بس/يكفي).
 */
const TRIGGERS: ReadonlySet<string> = new Set([
  // الإنجليزيّة
  "continue", "cont", "proceed", "more", "next", "finish", "complete",
  // العربيّة (فصحى ولهجات شائعة): أمرٌ، ومضارعٌ بعد «ممكن/تقدر»، ومصدرٌ بعد «الرجاء/يرجى»
  "كمل", "كملي", "كملوا", "كمله", "كملها", "اكمل", "اكملي", "اكمله", "اكملها", "تكمل", "تكملي", "تكملين", "تكملون", "استكمل",
  "تابع", "تابعي", "تتابع", "استمر", "استمري", "تستمر", "واصل", "واصلي", "اتمم", "اتم",
  "الاستمرار", "الاكمال", "اكمال", "الاستكمال", "استكمال", "اتمام",
  "الباقي", "باقي", "البقيه", "بقيه", "المزيد", "مزيد", "التكمله", "تكمله", "التتمه", "تتمه", "كمان", "تفضل",
]);

/** زوجان متجاوران يعملان عملَ فعلِ متابعة */
const PAIRS: ReadonlySet<string> = new Set([
  "go on", "keep going", "carry on", "go ahead", "keep writing", "the rest", "rest of", "left off", "you stopped", "it stopped",
  "حيث توقفت", "حيث وقفت", "حيث توقف", "حيث انتهي", "حيث انقطع", "وين وقفت", "وين توقفت", "فين وقفت", "فين توقفت", "فين الباقي",
]);

/**
 * حشوٌ ومجاملة — لا تكون متابعةً وحدها أبدًا. ★ لا كلمةَ محتوى هنا: كلمةٌ واحدة («allowance»، «المخزون») تحوّل
 * سؤالًا حقيقيًّا إلى متابعة. الاختبارُ يحرس ذلك بأمثلةٍ من الملفّات نفسها.
 */
const FILLERS: ReadonlySet<string> = new Set([
  // الإنجليزيّة
  "please", "pls", "plz", "thanks", "thank", "thx", "you", "u", "ok", "okay", "k", "yes", "yeah", "yep", "sure", "alright",
  "now", "then", "and", "so", "just", "can", "could", "would", "kindly", "lets", "the", "your", "this", "that", "it",
  "with", "answer", "response", "reply", "writing", "going", "go", "on", "keep", "carry", "ahead", "from",
  "where", "left", "off", "stopped", "pick", "up", "of", "rest", "me", "tell", "give", "show", "want", "need",
  "about", "in", "english", "arabic", "a", "bit", "some", "cut", "got", "last", "previous",
  // العربيّة
  "لو", "سمحت", "سمحتي", "من", "فضلك", "رجاء", "الرجاء", "ارجوك", "ارجو", "يرجي", "بليز", "ممكن", "تقدر", "تقدري", "تقدرين",
  "يمكنك", "بامكانك", "هل", "فضلا", "لطفا", "شكرا", "طيب", "تمام", "زين", "منيح", "اوكي", "اوك", "حسنا", "ماشي", "يلا", "يالله",
  "هيا", "نعم", "ايوه", "ايوا", "اي", "اه", "ايه", "الله", "يخليك", "يعطيك", "العافيه", "الان", "الجواب", "جوابك", "الاجابه",
  "اجابتك", "الرد", "ردك", "الشرح", "شرحك", "الكلام", "كلامك", "الكتابه", "بالشرح", "بالاجابه", "بالكتابه", "بالرد", "في",
  "السابق", "السابقه", "انقطع", "ناقص", "اللي", "الي", "حيث", "توقفت", "وقفت", "توقف", "انتهي", "انتهيت", "انقطعت", "وين", "فين",
  "هات", "اعطني", "عطني", "اديني", "ادي", "اريد", "ابغي", "ابي", "لي", "بقي", "كده", "كدا", "شوي", "زياده", "زود", "زد", "اكثر",
  "بالعربي", "بالعربيه", "بالانجليزي", "بالانجليزيه",
]);

/** كلماتٌ لا تُقبل إلا قبل كلمةٍ بعينها (تمنع «where next?» و«من الباقي؟») */
const NEEDS_NEXT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["where", new Set(["you", "it"])],
  ["من", new Set(["فضلك", "حيث", "وين", "فين"])],
  // «توقف» وحدها أمرٌ بالإيقاف؛ لا تُقبل إلا بعد «حيث» («أكمل من حيث توقف»)
  ["توقف", new Set([])],
]);

/** للاختبار: المعجمُ كما هو مخزَّن */
export function followUpLexicon(): { triggers: string[]; pairs: string[]; fillers: string[] } {
  return { triggers: [...TRIGGERS], pairs: [...PAIRS], fillers: [...FILLERS] };
}

/**
 * التطبيع: NFKC، حروفٌ صغيرة، إزالةُ التشكيل والتطويل والمحارف الصفريّة، توحيدُ الألف والياء والتاء المربوطة،
 * إسقاطُ الفواصل العليا، طيُّ تكرار الحرف ثلاثًا فأكثر («كمللل»، «continueee»)، ثمّ كلماتٌ من حروفٍ وأرقام فقط.
 * يُعيد null إن خرج النصُّ عن الحدود (طولًا أو عددَ كلمات) أو لم يبقَ منه شيء.
 */
export function normalizeFollowUp(raw: string): string[] | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > BARE_FOLLOW_UP_MAX_CHARS) return null;
  const tokens = t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "")
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ک/g, "ك")
    .replace(/['’ʼ`]/g, "")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > BARE_FOLLOW_UP_MAX_TOKENS) return null;
  return tokens;
}

const known = (tok: string): boolean => TRIGGERS.has(tok) || FILLERS.has(tok);

/**
 * الكلمةُ كما تُطابَق: مباشرةً، أو بعد نزع واو العطف من كلمةٍ طولُها ٣ فأكثر («وكمل»، «والباقي»، «وهل»).
 * لا طيَّ للحرف المضعَّف هنا: كان يحوّل أعلامًا إلى أفعال متابعة (Moore ⇒ more، Finnish ⇒ finish، II ⇒ i).
 */
function resolveToken(tok: string): string | null {
  if (known(tok)) return tok;
  if (tok.length >= 3 && tok.startsWith("و")) {
    const rest = tok.slice(1);
    if (known(rest)) return rest;
  }
  return null;
}

/** هل الرسالةُ متابعةٌ مجرّدة («كمل»، «continue please»، «أكمل من حيث توقفت» …) لا سؤالًا جديدًا؟ */
export function isBareContinuation(raw: string): boolean {
  const tokens = normalizeFollowUp(raw);
  if (!tokens) return false;
  const resolved: string[] = [];
  for (const tok of tokens) {
    const r = resolveToken(tok);
    if (r === null) return false;
    resolved.push(r);
  }
  for (let i = 0; i < resolved.length; i++) {
    const allowedNext = NEEDS_NEXT.get(resolved[i]!);
    if (!allowedNext) continue;
    // كلمةٌ مقيَّدة: إمّا بما بعدها (where you / من فضلك) أو بما قبلها («حيث توقف»)
    if (allowedNext.has(resolved[i + 1] ?? "")) continue;
    if (allowedNext.size === 0 && resolved[i - 1] === "حيث") continue;
    return false;
  }
  if (resolved.some((r) => TRIGGERS.has(r))) return true;
  for (let i = 0; i + 1 < resolved.length; i++) {
    if (PAIRS.has(`${resolved[i]} ${resolved[i + 1]}`)) return true;
  }
  return false;
}

/**
 * نصُّ استعلام الاسترجاع لهذا الدور.
 *
 * `turnText` = نصُّ الدور كما يحسبه المسار (الرسالة، أو آخرُ دورِ مستخدمٍ في السياق عند إعادة التوليد).
 * `history` = سياقُ النموذج المبنيّ (ينتهي بالدور الذي يُجاب الآن).
 *
 * - ليست متابعةً مجرّدة ⇒ النصُّ نفسُه، بلا قراءةِ السياق.
 * - متابعةٌ مجرّدة ⇒ أقربُ دورِ مستخدمٍ سابقٍ ليس متابعةً وله جوابُ مساعدٍ بعده (سلاسلُ «كمل» تُتخطّى).
 * - لا مرساةَ في النافذة، أو سياقٌ لا ينتهي بهذا الدور، أو أيُّ استثناء ⇒ النصُّ نفسُه (سلوكُ اليوم).
 */
export function deriveRetrievalQuery(
  turnText: string,
  history: readonly ChatMessage[],
): { text: string; source: RetrievalQuerySource } {
  const literal = { text: turnText, source: "message" as const };
  try {
    if (!isBareContinuation(turnText)) return literal;
    const last = history[history.length - 1];
    if (!last || last.role !== "user" || last.content !== turnText) return literal;
    for (let i = history.length - 2; i >= 0; i--) {
      const m = history[i]!;
      if (m.role !== "user" || typeof m.content !== "string") continue;
      if (isBareContinuation(m.content)) continue;
      const reply = history[i + 1];
      if (!reply || reply.role !== "assistant" || typeof reply.content !== "string" || !reply.content.trim() || !m.content.trim()) return literal;
      return { text: m.content, source: "continued" };
    }
    return literal;
  } catch {
    return literal;
  }
}
