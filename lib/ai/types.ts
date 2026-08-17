/**
 * AIProviderAdapter — الطبقة الموحدة لموفري الذكاء الاصطناعي
 *
 * أي موفر جديد (OpenAI, Google, نماذج مفتوحة، موفر YSD الخاص مستقبلًا)
 * يُضاف بتنفيذ هذه الواجهة وتسجيله في registry.ts — دون أي تعديل
 * على واجهة المحادثة أو مسار الـ API.
 */

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  /** معرّف النموذج كما هو مسجّل في جدول ai_models */
  modelId: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** لإلغاء الطلب من جهة العميل */
  signal?: AbortSignal;
  /**
   * مصدر إسناد التفاصيل المتخصصة (v0.6.5 RC7). غيابه = "none" أي معرفة
   * النموذج وحدها، وهي غير كافية لتمرير المواقع والخطوات والأرقام.
   */
  grounding?: { source: "rag" | "knowledge_base" | "tool" | "user_context" | "none"; sourceId?: string };
  /**
   * مفردات لاتينية وردت في مقاطع المستخدم التي دخلت الموجّه (v0.9.0).
   *
   * حارس اللغة يعدّ كل كلمة لاتينية صغيرة في ردّ عربي تسريبًا — وهو صحيح إلا
   * حين تكون الكلمة في ملف المستخدم نفسه. نقلُها إليه هو الجواب لا مخالفة له.
   *
   * غيابها يعني السلوك القديم حرفيًا: بلا مصادر لا ترخيص.
   */
  sourceVocabulary?: ReadonlySet<string>;
  /**
   * سقف زمني يفرضه المسار على المزوّد (v0.9.0 — احتياط المزوّدين).
   *
   * المزوّد الاحتياطي يبدأ بعد أن استُهلك جزء من ميزانية الطلب، فلا يصحّ أن
   * يقرّر وحده كم ينتظر. غيابه يعني حدوده الداخلية كما هي.
   */
  budgetMs?: number;
}

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
}

export interface StreamChunk {
  /** "status" = حالة قصيرة تُعرض فورًا في الوضع المحمي (ليست جزءًا من الرد) */
  type: "text" | "usage" | "done" | "error" | "meta" | "status";
  text?: string;
  usage?: UsageReport;
  error?: string;
  /** رمز تصنيف الخطأ (v0.6.6) — تعرضه الواجهة برسالة مناسبة لكل حالة */
  errorCode?: string;
  /** معرّف النموذج الفعلي الذي أجاب (مع "meta") — للتسجيل والعرض في التطوير */
  model?: string;
  /** الوضع المختار (مع "meta"): بثّ عام أو محمي بالتحقق — للتسجيل الآمن */
  mode?: "general" | "protected";
  /** عدد مرات إعادة التوليد الصارمة (مع "meta") — يجب ألا يتجاوز 1 */
  regenerations?: number;
  /** عدد النماذج التي أنهت البثّ بلا نص (مع "meta") — للتسجيل الآمن */
  emptyCompletions?: number;
  /** حقول داخلية فقط (v0.6.5 RC7) — لا تُعرض للمستخدم */
  groundingSource?: "rag" | "knowledge_base" | "tool" | "user_context" | "none";
  protectedDetailBlocked?: boolean;
  /** v0.6.5 RC8: رُدّ بلا أي نداء للمزوّد (اختصار الوضع المحمي بلا مصدر) */
  shortCircuit?: boolean;
  /** عدد طلبات التوليد الفعلية المرسلة للمزوّد في هذا الرد */
  providerCalls?: number;
  /**
   * عدد محاولات النماذج التي جرت فعلًا (v0.9.0).
   *
   * `fallback_count` كان يُشتقّ من ترتيب `actualModelId` في السلسلة، وهو صفرٌ
   * مضلّل حين لا يصل أول بايت — فيبدو أن لا احتياط جرى بينما جرت محاولات.
   */
  attemptCount?: number;
  /**
   * تصنيف نهاية سلسلة المزوّد (v0.9.0) — للتشخيص وحده.
   *
   * `provider_unavailable` لا يقول هل جُرّب نموذج أصلًا أم لا. هذا يقوله:
   * صفر مرشّحين، أو سبر فاشل، أو استنفاد، أو خطأ حساب.
   */
  chainOutcome?: string;
  /**
   * حالة اكتمال الرد (v0.7.0 RC8) — تُرسل مع "done".
   * غيابها يعني رَدًّا مكتملًا؛ فالرسائل القديمة تبقى صالحة بلا ترحيل.
   */
  completion?: "incomplete_guard" | "incomplete_timeout" | "incomplete_provider";
  /** سبب فني مختصر للنقص (رمز فقط، بلا محتوى) — يُعرض في التطوير ويُسجَّل */
  completionReason?: string;
  /** v0.6.6: اسم ملتبس → سؤال توضيح من النظام بلا نداء مزوّد */
  ambiguousEntity?: boolean;
}

export interface ModelInfo {
  id: string;
  providerId: string;
  displayNameAr: string;
  displayNameEn: string;
  contextWindow: number;
  enabled: boolean;
}

/**
 * نتيجة فحص اتصال المزوّد (v0.8.0) — **مصنَّفة، لا نصّية**.
 *
 * الحالة رمز مغلق تعرضه الواجهة برسالة عربية جاهزة. لا يعبر من هنا نصّ خطأ
 * المزوّد ولا عنوانه ولا أي ترويسة: رسالة خطأ خام قد تحمل العنوان الداخلي
 * أو جزءًا من المفتاح، ولوحة الإدارة تُعرض في متصفح.
 */
export type ProviderHealthStatus =
  | "connected"
  | "unauthorized"
  | "no_models"
  | "unreachable"
  | "not_configured"
  /**
   * المزوّد لا يوفّر فاحص اتصال. كان يُعرض "connected" — وهو ادّعاء بفحص لم
   * يقع: غياب الفاحص ليس نجاحًا، والمشرف يقرأ «متصل» فيطمئن بلا دليل.
   */
  | "unsupported";

export interface ProviderHealth {
  status: ProviderHealthStatus;
  /** عدد النماذج المكتشفة — رقم فقط */
  modelCount?: number;
  /** زمن الاستجابة بالميلي ثانية — للتشخيص */
  latencyMs?: number;
}

/** تصنيف موحّد لأخطاء المزوّدين — رموز فقط، بلا نصوص المزوّد */
export type ProviderErrorKind =
  | "auth"
  | "payment"
  | "rate_limit"
  | "not_found"
  | "server"
  | "network"
  | "unknown";

export interface NormalizedProviderError {
  kind: ProviderErrorKind;
  /** رمز HTTP إن وُجد — بلا جسم الرد */
  status?: number;
  /** هل يستحق تهدئة النموذج؟ */
  cooldown: boolean;
}

export interface AIProviderAdapter {
  /** معرّف ثابت: "anthropic" | "openai" | "google" | "ysd" ... */
  readonly id: string;
  readonly displayName: string;

  /** هل مفتاح الموفر متوفر في البيئة؟ */
  isConfigured(): boolean;

  /**
   * النماذج التي يقدّمها هذا الموفر — من قائمة ثابتة أو كاش الاكتشاف.
   * تبقى **متزامنة** عمدًا: كل المستدعين الحاليين متزامنون، وجعلها async
   * كان سيفرض تعديلًا واسعًا بلا مقابل. الاكتشاف الشبكي في discoverModels.
   */
  listModels(): ModelInfo[];

  // ── إضافات v0.8.0 — كلها اختيارية حفاظًا على توافق المزوّدين القائمين ──

  /** قدرات المزوّد — الغياب يعني البثّ مدعوم وما عداه غير مدعوم */
  readonly supportsStreaming?: boolean;
  /**
   * هل يظهر للمستخدم في قائمة النماذج؟ (v0.9.0)
   *
   * غيابه = نعم (سلوك كل المزوّدين القائمين). و`false` تعني **الإخفاء
   * وحده**: لا يُعرض في القائمة ولا يُختار مباشرة.
   *
   * ★ ولا تقول شيئًا عن الاحتياط. كانت تُقرأ كذلك حتى v0.9.3 — فكان إخفاء
   * مزوّد يجعله مرشّحًا للاحتياط بلا قصد. الأهليّة صارت في
   * `fallbackEligible` وحدها، ولا رابط بين الخاصيتين.
   *
   * والإخفاء يبقى منفصلًا عن تعطيل النماذج: لو أُخفي مزوّدٌ بتعطيل نماذجه
   * لَتعطّل دوره الاحتياطيّ معه — وهما شيئان لا شيء واحد.
   */
  readonly userSelectable?: boolean;

  /**
   * هل يصلح هذا المزوّد ليكون **بديلًا** لمزوّد آخر فشل؟ (v0.9.3)
   *
   * ── الفرق عن `fallbackPolicy` ──
   *
   * الخاصيتان تصفان طرفَي العلاقة لا شيئًا واحدًا:
   *
   *   `fallbackPolicy`   — على المزوّد **الأساسي**: أيُسمح بالخروج منه إلى
   *                        غيره حين يفشل؟
   *   `fallbackEligible` — على المزوّد **البديل**: أيصلح أصلًا لأن يكون ذلك
   *                        الغير؟
   *
   * ولا تُشتقّ إحداهما من الأخرى: مزوّدٌ قد يسمح بالخروج منه ولا يصلح بديلًا
   * لأحد، والعكس. وربطُهما كان سيعيد الخلط الذي جاءت هذه الرقعة لتفكّه.
   *
   * ── الدلالة ──
   *
   * `undefined` أو `false` = **ليس مرشّحًا** — وهو الافتراض الآمن: مزوّد
   * جديد لا يصير بديلًا لأحد بمجرد إضافته، بل بإعلانٍ صريح.
   *
   * `true` = يجوز للسجلّ اعتباره مرشّحًا متى كان `isConfigured()`.
   */
  readonly fallbackEligible?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;

  /**
   * هل يجوز تحويل الرد إلى مزوّد **آخر** حين يفشل هذا؟ (v0.9.3)
   *
   * ── لماذا خاصية مستقلة ──
   *
   * `isConfigured` تقول «هل هذا المزوّد صالح للاستعمال؟» — وهي **توفّر**.
   * وهذه تقول «إن فشل، أيُسمح بمزوّد بديل؟» — وهي **سياسة**. والمفهومان
   * منفصلان: مزوّدٌ مُهيّأ وسليم قد يكون تحويلُ طلبه إلى غيره غير مقبول.
   *
   * والحالة التي تفرض الفصل: مزوّد يمثّل نموذجًا خاصًّا بالمنصّة. تحويل
   * طلبه إلى مزوّد خارجي يعني أن يظنّ المستخدم أنه يخاطب نموذجًا وهو يخاطب
   * آخر — وذلك أسوأ من رسالة عطل صريحة.
   *
   * ── الدلالة ──
   *
   * `undefined` = **السلوك القائم حرفيًّا** = `"external"`. اختياريّة عمدًا
   * كي لا يتغيّر أي مزوّد قائم بحرف: من لا يعلنها يبقى كما هو.
   *
   * `"external"` — يُسمح بمزوّد احتياطيّ خارجيّ (السلوك الحاليّ).
   * `"none"`     — لا يُحوَّل الطلب إلى مزوّد آخر مهما كان.
   *
   * ولا تمسّ هذه الخاصية سلسلة النماذج **داخل** المزوّد الواحد: تلك احتياطٌ
   * داخليّ لا عبورَ فيه لحدود المزوّد.
   */
  readonly fallbackPolicy?: "external" | "none";

  /**
   * اكتشاف النماذج من المزوّد عبر الشبكة (مثل GET /models).
   * غيابها يعني قائمة ثابتة لا تحتاج اكتشافًا.
   *
   * `force` يتخطّى الكاش. لازم لزرّ «تحديث القائمة» الإداري: زرٌّ يعيد الكاش
   * صامتًا يكذب على من ضغطه — وهو يضغطه تحديدًا ليُجبر إعادة الجلب.
   */
  discoverModels?(signal?: AbortSignal, force?: boolean): Promise<ModelInfo[]>;

  /** فحص اتصال مصنَّف — لزر «اختبار الاتصال» في لوحة الإدارة */
  healthCheck?(signal?: AbortSignal): Promise<ProviderHealth>;

  /** تصنيف خطأ المزوّد إلى رمز موحّد — بلا تسريب نصّ المزوّد */
  normalizeError?(status: number | null, err?: unknown): NormalizedProviderError;

  /**
   * نداء JSON غير متدفّق — لاسترداد الاستشهادات (v0.9.1).
   *
   * ★ **بلا حقل `model` عمدًا.**
   *
   * كان الاسترداد يمرّر `actualModelId` إلى نقطة OpenRouter دائمًا. فحين أجاب
   * Groq صار معرّف نموذجه يُرسَل إلى مزوّد آخر — تسريبٌ عبر حدود المزوّد،
   * ومعه فشلٌ مضمون. وغياب الحقل هنا يجعل ذلك **مستحيلًا بالبناء**: كل مزوّد
   * يختار نموذجه من سلسلته وحدها.
   */
  requestJsonCompletion?(input: {
    systemPrompt: string;
    userText: string;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ ok: true; text: string } | { ok: false; reason: "timeout" | "error" }>;

  /**
   * بث الرد قطعةً قطعة.
   * يجب أن يُرجع دائمًا chunk أخير من نوع "done" أو "error"،
   * ويُرجع "usage" قبل النهاية إن توفّر من الموفر.
   */
  streamChat(req: ChatRequest): AsyncGenerator<StreamChunk>;
}
