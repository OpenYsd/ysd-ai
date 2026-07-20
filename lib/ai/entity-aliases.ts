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

export type EntityKind = "game" | "product";

export interface EntityAlias {
  /** الاسم الموحّد كما يُذكر للنموذج */
  canonical: string;
  kind: EntityKind;
  /** صور مكتوبة شائعة — تُطبَّع عند المطابقة فلا حاجة لسرد كل الاحتمالات */
  aliases: string[];
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

/** سجل الكيانات — يتوسّع بإضافة سطر واحد */
export const ENTITY_ALIASES: EntityAlias[] = [
  {
    canonical: "Elden Ring",
    kind: "game",
    // «الدن رينق» تغطي إلدن/الدن/آلدن × رينق/رينغ بعد التطبيع
    aliases: ["Elden Ring", "الدن رينق", "الدن رينج", "ايلدن رينق", "ايلدن رينج"],
  },
  {
    canonical: "Minecraft",
    kind: "game",
    aliases: ["Minecraft", "ماين كرافت", "ماينكرافت"],
  },
  {
    canonical: "Photoshop",
    kind: "product",
    aliases: ["Photoshop", "فوتوشوب", "فوتو شوب"],
  },
];

/** أقصر طول مطبَّع يُقبل للمطابقة — يمنع مطابقات عابرة */
const MIN_ALIAS_LEN = 5;

export interface DetectedEntity {
  canonical: string;
  kind: EntityKind;
  /** الصورة التي وردت في نص المستخدم (كما وردت، للتوثيق لا للعرض) */
  matched: string;
}

/**
 * يكشف الكيانات المذكورة في نص المستخدم دون تعديله.
 * المطابقة على النص المطبَّع، والأسماء متعددة الكلمات فاحتمال الخطأ ضئيل.
 */
export function detectEntities(userText: string): DetectedEntity[] {
  if (!userText) return [];
  const haystack = normalizeForMatch(userText);
  if (!haystack) return [];
  const found: DetectedEntity[] = [];
  for (const entry of ENTITY_ALIASES) {
    for (const alias of entry.aliases) {
      const norm = normalizeForMatch(alias);
      if (norm.length < MIN_ALIAS_LEN) continue;
      if (haystack.includes(norm)) {
        found.push({ canonical: entry.canonical, kind: entry.kind, matched: alias });
        break; // صورة واحدة تكفي لكل كيان
      }
    }
  }
  return found;
}

/**
 * سياق داخلي يُضاف إلى موجّه النظام وحده — يمنع سؤال المستخدم عن اسم معروف،
 * ويعطي صيغة الاعتراف الصحيحة حين تغيب الخطوات الدقيقة، بلا اختراع مواقع.
 */
export function buildEntityContext(entities: DetectedEntity[]): string {
  if (entities.length === 0) return "";
  const lines = entities.map(
    (e) =>
      `- «${e.matched}» في رسالة المستخدم تعني ${e.kind === "game" ? "لعبة" : "منتج"} ${e.canonical}.`,
  );
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
