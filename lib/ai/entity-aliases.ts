/**
 * تطبيع أسماء الكيانات (v0.6.5 RC5) — يفهم أسماء الألعاب والمنتجات المكتوبة
 * بالنقحرة العربية («الدن رينق» = Elden Ring).
 *
 * المشكلة المرصودة حيًّا: المختبِر يكتب «في الدن رينق…» فيسأله النموذج عن اسم
 * اللعبة لأنه لا يربط النقحرة بالاسم الإنجليزي — فيبدو الرد جاهلًا بلا سبب.
 *
 * المبدأ: **لا يُمسّ نص المستخدم** إطلاقًا — لا المحفوظ ولا المعروض ولا المُرسل
 * ضمن الرسائل. يُضاف سياق داخلي إلى موجّه النظام فقط يوضّح الاسم الموحّد.
 *
 * البنية قابلة للتوسعة: أضف عنصرًا إلى ENTITY_ALIASES وحسب — لا قواعد مربوطة
 * بجملة سؤال بعينها. المطابقة تتم على صورة مطبَّعة من الطرفين.
 *
 * لا يعتمد على `@/` ليبقى قابلًا للاستيراد في اختبارات vitest.
 */

export type EntityKind = "game" | "product" | "media";

/** نوع الكيان بدقة أعلى — يمنع الخلط بين عملين مختلفين متشابهي النقحرة */
export type EntityType = "video_game" | "software" | "anime_manga";

export interface EntityAlias {
  /** الاسم الموحّد كما يُذكر للنموذج */
  canonical: string;
  kind: EntityKind;
  entityType: EntityType;
  /** صور مكتوبة شائعة مع ثقتها — تُطبَّع عند المطابقة */
  aliases: AliasForm[];
}

/**
 * التطبيع للمطابقة فقط (لا يُعرض ولا يُحفظ):
 * الهمزات → ا، ى → ي، ة → ه، غ → ق (شائعة في النقحرة: رينغ/رينق)،
 * إسقاط التشكيل والتطويل، وتوحيد المسافات المتكررة.
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/غ/g, "ق")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * صورة مكتوبة واحدة مع درجة ثقتها.
 * confidence = 1 اسم كامل لا يلتبس · 0.8 نقحرة واضحة · 0.5 صورة مختصرة تلتبس.
 * ما دون عتبة الوثوق لا يُحوَّل تلقائيًا — يُطرح سؤال توضيح بدل التخمين.
 */
export interface AliasForm {
  form: string;
  confidence: number;
}

/** سجل الكيانات — يتوسّع بإضافة عنصر واحد */
export const ENTITY_ALIASES: EntityAlias[] = [
  {
    canonical: "Elden Ring",
    kind: "game",
    entityType: "video_game",
    // «الدن رينق» تغطي إلدن/الدن/آلدن × رينق/رينغ بعد التطبيع
    aliases: [
      { form: "Elden Ring", confidence: 1 },
      { form: "الدن رينق", confidence: 0.95 },
      { form: "الدن رينج", confidence: 0.95 },
      { form: "ايلدن رينق", confidence: 0.95 },
      { form: "ايلدن رينج", confidence: 0.95 },
    ],
  },
  {
    canonical: "Minecraft",
    kind: "game",
    entityType: "video_game",
    aliases: [
      { form: "Minecraft", confidence: 1 },
      { form: "ماين كرافت", confidence: 0.95 },
      { form: "ماينكرافت", confidence: 0.95 },
    ],
  },
  {
    canonical: "Photoshop",
    kind: "product",
    entityType: "software",
    aliases: [
      { form: "Photoshop", confidence: 1 },
      { form: "فوتوشوب", confidence: 0.95 },
      { form: "فوتو شوب", confidence: 0.95 },
    ],
  },
  // ── عملان مختلفان تمامًا تتشابه نقحرتهما العربية — رُصد خلطهما حيًّا ──
  {
    canonical: "JoJo's Bizarre Adventure",
    kind: "media",
    entityType: "anime_manga",
    // «جوجو» وحدها ملتبسة (قد يقصد جوجيتسو) فثقتها دون العتبة
    aliases: [
      { form: "JoJo's Bizarre Adventure", confidence: 1 },
      { form: "JoJo Bizarre Adventure", confidence: 1 },
      { form: "JoJo", confidence: 0.6 },
      { form: "مغامرة جوجو الغريبة", confidence: 1 },
      { form: "جوجو الغريبة", confidence: 0.95 },
      { form: "جوجو بيزار", confidence: 0.95 },
      { form: "جوجو", confidence: 0.6 },
    ],
  },
  {
    canonical: "Jujutsu Kaisen",
    kind: "media",
    entityType: "anime_manga",
    aliases: [
      { form: "Jujutsu Kaisen", confidence: 1 },
      { form: "جوجيتسو كايسن", confidence: 1 },
      { form: "جوجتسو كايسن", confidence: 1 },
      { form: "جوجيتسو", confidence: 0.9 },
      { form: "جوجتسو", confidence: 0.9 },
      { form: "صراع السحرة", confidence: 0.9 },
    ],
  },
];

/** أقصر طول مطبَّع يُقبل للمطابقة — يمنع مطابقات عابرة */
const MIN_ALIAS_LEN = 4;

/** عتبة التحويل التلقائي — دونها يُطلب توضيح بدل التخمين */
export const CONFIDENT_THRESHOLD = 0.85;

export interface DetectedEntity {
  canonical: string;
  kind: EntityKind;
  entityType: EntityType;
  /** الصورة التي وردت في نص المستخدم (كما وردت، للتوثيق لا للعرض) */
  matched: string;
  confidence: number;
}

/**
 * مطابقة على حدود الكلمات — لا مجرد `includes`.
 * تمنع أن يبتلع اسمٌ اسمًا آخر يشاركه بادئة (جوجو داخل جوجيتسو مثلًا).
 */
/**
 * السوابق العربية الملتصقة (و/ف/ب/ل/ك) و«ال» التعريف: «بجوجيتسو» و«والدن رينق»
 * إشارتان صحيحتان للكيان. إهمالها كان يُفقد الكشف تمامًا (رُصد في اختبار
 * «قارن جوجو بجوجيتسو كايسن» — لم يُكتشف Jujutsu Kaisen أصلًا).
 */
function isArabicProclitic(before: string, haystack: string, at: number): boolean {
  if (!/[وفبلك]/.test(before)) return false;
  // الحرف السابق للسابقة يجب أن يكون فاصلًا (بداية كلمة)
  const prev = at >= 2 ? haystack[at - 2] ?? "" : "";
  return prev === "" || !/[\p{L}\p{N}]/u.test(prev);
}

function containsAtBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isLetter = (c: string) => c !== "" && /[\p{L}\p{N}]/u.test(c);
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : haystack[i - 1] ?? "";
    const after = haystack[i + needle.length] ?? "";
    if (!isLetter(after)) {
      if (!isLetter(before)) return true;
      if (isArabicProclitic(before, haystack, i)) return true;
      // «ال» التعريف قبل الاسم
      if (before === "ل" && i >= 2 && haystack[i - 2] === "ا") {
        const prev = i >= 3 ? haystack[i - 3] ?? "" : "";
        if (prev === "" || !isLetter(prev)) return true;
      }
    }
    from = i + 1;
  }
}

/**
 * يكشف الكيانات المذكورة في نص المستخدم دون تعديله.
 * لكل كيان تُختار أعلى صورة ثقةً طابقت، والمطابقة على حدود الكلمات.
 */
export function detectEntities(userText: string): DetectedEntity[] {
  if (!userText) return [];
  const haystack = normalizeForMatch(userText);
  if (!haystack) return [];
  const found: DetectedEntity[] = [];
  for (const entry of ENTITY_ALIASES) {
    let best: DetectedEntity | null = null;
    for (const alias of entry.aliases) {
      const norm = normalizeForMatch(alias.form);
      if (norm.length < MIN_ALIAS_LEN) continue;
      if (!containsAtBoundary(haystack, norm)) continue;
      if (!best || alias.confidence > best.confidence) {
        best = {
          canonical: entry.canonical,
          kind: entry.kind,
          entityType: entry.entityType,
          matched: alias.form,
          confidence: alias.confidence,
        };
      }
    }
    if (best) found.push(best);
  }
  return found;
}

/** الكيانات الواثقة وحدها — هي التي تُحقن كسياق مؤكَّد */
export function confidentEntities(userText: string): DetectedEntity[] {
  return detectEntities(userText).filter((e) => e.confidence >= CONFIDENT_THRESHOLD);
}

/**
 * حالة الالتباس: صورة غير واثقة، أو أكثر من كيان محتمل من النوع نفسه.
 * في الحالتين يُطلب توضيح مختصر بدل التخمين.
 */
export function ambiguousCandidates(userText: string): DetectedEntity[] {
  const all = detectEntities(userText);
  if (all.length === 0) return [];
  const confident = all.filter((e) => e.confidence >= CONFIDENT_THRESHOLD);
  if (confident.length === 1) return []; // واثق ووحيد → لا التباس
  if (confident.length > 1) return confident; // أكثر من كيان واثق → وضّح
  return all; // لا شيء واثقًا لكن هناك مرشحون → وضّح
}

/** سؤال توضيح مختصر يُعرض بدل التخمين */
const TYPE_AR: Record<EntityType, string> = {
  video_game: "لعبة",
  software: "برنامج",
  anime_manga: "أنمي",
};

export function buildClarifyQuestion(candidates: DetectedEntity[]): string {
  if (candidates.length === 0) return "";
  const first = candidates[0]!;
  if (candidates.length === 1) {
    return `تقصد ${TYPE_AR[first.entityType]} ${first.canonical}؟ أكّد لي الاسم حتى لا أعطيك معلومة عن عمل آخر.`;
  }
  const list = candidates
    .slice(0, 3)
    .map((c) => c.canonical)
    .join(" أم ");
  return `تقصد ${list}؟ عملان مختلفان تمامًا، وأفضّل أن أتأكد بدل أن أخلط بينهما.`;
}

/**
 * سياق داخلي يُضاف إلى موجّه النظام وحده — يمنع سؤال المستخدم عن اسم معروف،
 * ويعطي صيغة الاعتراف الصحيحة حين تغيب الخطوات الدقيقة، بلا اختراع مواقع.
 */
const KIND_AR: Record<EntityKind, string> = {
  game: "لعبة",
  product: "منتج",
  media: "عمل (أنمي/مانغا)",
};

/** أعمال يسهل خلطها — تُذكر صراحةً كي لا يخلط النموذج بينها */
const CONFUSABLE: Record<string, string> = {
  "JoJo's Bizarre Adventure": "Jujutsu Kaisen",
  "Jujutsu Kaisen": "JoJo's Bizarre Adventure",
};

export function buildEntityContext(entities: DetectedEntity[]): string {
  if (entities.length === 0) return "";
  const lines = entities.map(
    (e) => `- «${e.matched}» في رسالة المستخدم تعني ${KIND_AR[e.kind]} ${e.canonical}.`,
  );
  for (const e of entities) {
    const other = CONFUSABLE[e.canonical];
    if (other) {
      lines.push(
        `- تنبيه: ${e.canonical} عمل مختلف تمامًا عن ${other} — لا تخلط بينهما ولا تنقل معلومة من أحدهما إلى الآخر.`,
      );
    }
  }
  const first = entities[0]!.canonical;
  return [
    "سياق أسماء (داخلي — لا تعرضه ولا تعلّق عليه):",
    ...lines,
    "",
    "بناءً عليه:",
    "- الاسم معروف لديك الآن، فلا تسأل المستخدم عن اسم اللعبة أو المنتج ولا تطلب توضيحه.",
    "- لا تقل «اللعبة التي تقصدها» ولا «وضّح اسم اللعبة» — اذكر الاسم صراحةً.",
    `- إن لم تكن متأكدًا من التفاصيل الدقيقة، صرّح بذلك مع ذكر الاسم، بهذه الصيغة:`,
    `  «عرفت أنك تقصد ${first}، لكني غير متأكد من خطوات الحصول على (اسم العنصر)، ولا أبغى أعطيك معلومة خاطئة.»`,
    "- ولا تخترع مواقع أو خطوات أو أسماء عناصر لتغطية النقص.",
  ].join("\n");
}
