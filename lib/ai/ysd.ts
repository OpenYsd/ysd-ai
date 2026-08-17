import type { AIProviderAdapter, ModelInfo, StreamChunk } from "./types";

/**
 * YSD — مزوّد نموذج المنصّة، **خامل بالكامل في هذه الرقعة**.
 *
 * ── ما هذا الملف ──
 *
 * عقدٌ لا خدمة. يُثبّت شكل المزوّد ومعرّفاته وسياسته كي تُبنى عليه الرقعات
 * التالية، ولا يحمل نداءً شبكيًّا ولا عنوانًا ولا مفتاحًا. فلا شيء هنا يمكن
 * أن يتصل بشيء.
 *
 * ── لماذا خامل لا مؤجَّل ──
 *
 * التعطيل هنا **مزدوج ومقصود**:
 *
 *   (١) `isConfigured()` يرد `false` بلا `YSD_PROVIDER_ENABLED=1`، فيرشّحه
 *       السجلّ فلا يصل إليه طلب أصلًا.
 *   (٢) `enabled: false` على النموذج، فحتى لو فُتح العَلَم لا يظهر للمستخدم
 *       ولا يُوجَّه إليه طلب.
 *
 * والطبقتان لأن الأولى وحدها تجعل فتح العَلَم — لتجربة أو بالخطأ — يعرض على
 * المستخدم نموذجًا لا وجود له خلفه. والثانية تُرفع في رقعة تفعيل مستقلّة،
 * بعد سجلّ النماذج وواجهة YSD الحقيقية.
 *
 * ── وسياسته ──
 *
 * `fallbackPolicy = "none"`: لا يُحوَّل طلبٌ قُصد به نموذج المنصّة إلى مزوّد
 * خارجيّ. فالمستخدم الذي اختار YSD يريد YSD؛ وإجابةٌ من غيره تحت اسمه أسوأ
 * من رسالة عطل صريحة — لأن العطل يظهر والاستبدال لا يظهر.
 */

export const YSD_PROVIDER_ID = "ysd";

/** معرّف نموذج المنصّة الأول — محجوز الآن، غير مفعَّل */
export const YSD_ALPHA_MODEL_ID = "ysd/model-alpha";

/**
 * ★ قيمة تعاقدية مؤقتة — **ليست قدرة مقيسة**.
 *
 * وُضعت محافظةً عمدًا كي لا تُبنى عليها قرارات إنتاج (تقدير رموز، تقليم
 * سياق، اختيار نموذج). وتُستبدل بالقيمة الحقيقية حين تُبنى واجهة YSD
 * ويُقاس السياق فعلًا. ولا يقرأها اليوم أحد: النموذج `enabled: false`.
 */
const CONTRACT_PLACEHOLDER_CONTEXT_WINDOW = 8_192;

/**
 * رسالة العطل العامة — هي نفسها المستعملة في مسارات المزوّدين الأخرى.
 *
 * لا تذكر YSD ولا سببًا داخليًّا: المستخدم لا يعنيه أي مزوّد تعثّر، ورسالةٌ
 * تسمّي مكوّنًا داخليًّا تُسرّب بنية النظام بلا فائدة له.
 */
const UNAVAILABLE_MESSAGE = "خدمة الذكاء الاصطناعي غير متاحة الآن. حاول مرة أخرى لاحقًا.";

export class YSDProvider implements AIProviderAdapter {
  readonly id = YSD_PROVIDER_ID;
  readonly displayName = "YSD";

  readonly userSelectable = true;
  readonly supportsStreaming = true;
  readonly supportsTools = false;
  readonly supportsVision = false;

  /** لا عبور لحدود المزوّد — انظر شرح الرأس */
  readonly fallbackPolicy = "none" as const;

  /**
   * ولا يصلح بديلًا لأحد في هذه المرحلة — لا خدمة خلفه بعد.
   *
   * وهي الوجه الآخر من `fallbackPolicy`: تلك تمنع الخروج منه، وهذه تمنع
   * الدخول إليه. فلا يُحوَّل طلبه إلى غيره، ولا يُحوَّل إليه طلب غيره.
   */
  readonly fallbackEligible = false;

  /**
   * مغلق افتراضيًّا: الغياب أو أي قيمة غير `"1"` تعني `false`.
   *
   * فوجود هذا المزوّد في السجلّ لا يغيّر سلوك الإنتاج بحرف — يرشّحه
   * `getConfiguredProviders` قبل أن يصل إليه شيء.
   */
  isConfigured(): boolean {
    return process.env.YSD_PROVIDER_ENABLED === "1";
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: YSD_ALPHA_MODEL_ID,
        providerId: YSD_PROVIDER_ID,
        displayNameAr: "نموذج YSD (ألفا)",
        displayNameEn: "YSD Model (Alpha)",
        contextWindow: CONTRACT_PLACEHOLDER_CONTEXT_WINDOW,
        /**
         * ★ `false` عمدًا — الطبقة الثانية من التعطيل.
         *
         * يبقى كذلك حتى تكتمل واجهة YSD ويُرفع في رقعة تفعيل مستقلّة.
         */
        enabled: false,
      },
    ];
  }

  /**
   * يفشل **مغلقًا** بلا أي اتصال.
   *
   * لا `fetch` ولا عنوان ولا مفتاح ولا استثناء خام: يُعيد إطار خطأ مصنَّفًا
   * كما تفعل بقية المزوّدين عند التعثّر، فيسلك المسار مساره المعتاد بلا
   * حالة خاصة. ورمي استثناء هنا كان سيجعل مزوّدًا خاملًا يُسقط طلبًا.
   */
  async *streamChat(): AsyncGenerator<StreamChunk> {
    yield {
      type: "error",
      error: UNAVAILABLE_MESSAGE,
      errorCode: "provider_unavailable",
    };
  }

  /**
   * غير عامل بعد — يُعلن الفشل بلا محاولة.
   *
   * وجوده يجعل المسار يعامله كمزوّدٍ لا يصلح للاسترداد بدل أن يفترض قدرة
   * غير موجودة. ولا `healthCheck` هنا: فحصٌ يقول «متصل» بلا اتصال كذبٌ
   * تُبنى عليه قرارات.
   */
  async requestJsonCompletion(): Promise<
    { ok: true; text: string } | { ok: false; reason: "timeout" | "error" }
  > {
    return { ok: false, reason: "error" };
  }
}
