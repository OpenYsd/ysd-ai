/**
 * تخطيط الأدلة — **الخادم يقرّر، والعميل يستهلك** (v0.9.2، المرحلة الأولى).
 *
 * ── لماذا ──
 *
 * كان التقسيم يُحسب مرتين: مرة في الخادم لاشتقاق `segmentIndex` المحفوظ، ومرة
 * في العميل لوضع أزرار الاستشهاد. محرّكان لقاعدة واحدة — وأي افتراق بينهما
 * يضع الأزرار على فقرات خاطئة بلا أن يشتكي أحد. وقد أطال هذا النمط بعينه
 * (مُنتِجٌ سليم ومستهلكٌ يحسب وحده) عمرَ عطلين في هذا المشروع.
 *
 * الآن يُحسب مرة واحدة عند اكتمال النصّ، ويُبثّ ويُخزَّن ويُشتقّ منه
 * `segmentIndex` — **من الكائن نفسه**. فالتطابق بنيويّ لا مُتحقَّق منه: لا
 * يوجد حسابٌ ثانٍ يمكن أن يفترق.
 *
 * ── وما لا يفعله ──
 *
 * لا يمسّ النصّ المعروض ولا حدود الفقرات ولا قواعد التحقق. ينقل **ملكية
 * الحساب** لا نتيجته: في المرحلة الأولى الإصدار المختار = 1 دائمًا، فالحدود
 * مطابقة لما في الإنتاج اليوم حرفيًّا.
 */

/** إصدارات التقسيم المعروفة */
export type SegmentationVersion = 1 | 2;

/**
 * أعلى إصدار يفهمه **الخادم**.
 *
 * المرحلة الأولى أبقته 1 عمدًا: نُقلت ملكية الحساب ووُصِّل كل شيء — بثًّا
 * وتخزينًا وقياسًا — بينما بقيت حدود التقسيم كما هي حرفيًّا. فثبت التوصيل
 * حيًّا معزولًا عن التقسيم.
 *
 * والمرحلة الثانية هي هذا السطر وحده: 1 ← 2. لا منطق يتغيّر معه، لأن كل
 * ما يلزم كان قد شُحن وعمل. والتراجع سطر واحد كذلك — وهذا هو الغرض من
 * تقسيم العمل مرحلتين.
 *
 * ── وقد استُعمل هذا التراجع فعلًا ──
 *
 * أُعيد إلى 1 مؤقتًا حين تبيّن أن مسار الاسترداد يحلّل بـv1: كان
 * `parseEvidenceMarkers` تُستدعى فيه بلا `segmentation`، فصار `resolved`
 * ثلاثيّ المقاطع والاسترداد أُحاديّه — ومطابقة الفهارس في الدمج تُلصق
 * اقتباس ادّعاءٍ بادّعاءٍ آخر. والاستشهاد في غير موضعه أسوأ من غيابه،
 * لأن الغياب يظهر للقارئ.
 *
 * ثم أُصلح السبب: `ResolvedEvidence` صارت تحمل `segmentationVersion`
 * صراحةً، والاسترداد الجزئي يرثه من الأساس، والكامل يتلقّاه من المسار،
 * ونقطة الدمج ترفض ما اختلف إصداره. فأُعيد التفعيل إلى 2.
 *
 * والرسائل المخزَّنة — بأيّ تخطيط — تبقى صحيحة العرض: كلٌّ تُعرض بتخطيطها
 * هي لا بإعادة حساب.
 */
export const SERVER_ENABLED_VERSION: SegmentationVersion = 2;

/** أعلى إصدار تفهمه حزمة العميل الحالية — يُرسَل في الطلب */
export const CLIENT_MAX_VERSION: SegmentationVersion = 2;

/**
 * سقف أسطر التخطيط.
 *
 * تجاوزه يعني **حذف التخطيط** لا تقليصه: تخطيطٌ ناقص يضع أزرارًا في مواضع
 * خاطئة، وغيابه يُخفيها. والإخفاء أصدق من موضعٍ مغلوط.
 */
export const MAX_EVIDENCE_LAYOUT_LINES = 2_000;

/** التخطيط المحفوظ — بنية واحدة للبثّ والتخزين */
export interface EvidenceLayout {
  v: SegmentationVersion;
  /** فهرس المقطع لكل سطر — `-1` لما لا ينتمي إلى مقطع */
  lines: number[];
}

/**
 * ★ تفاوض القدرات.
 *
 * `chosen = min(الخادم, العميل)`. وغياب الحقل من الطلب يعني عميلًا قديمًا
 * أقصاه 1 — فلا يستطيع توليد رسالة بإصدار لا يفهمه. المشكلة تُمنع بالبناء
 * لا بالانضباط.
 */
export function negotiateSegmentationVersion(
  clientMax: number | undefined,
  serverEnabled: SegmentationVersion = SERVER_ENABLED_VERSION,
): SegmentationVersion {
  const client: SegmentationVersion = clientMax === 2 ? 2 : 1;
  return (Math.min(serverEnabled, client) as SegmentationVersion) ?? 1;
}

/**
 * يبني التخطيط من `lineSegments` الذي أنتجه تحليل الخادم **نفسه**.
 *
 * لا يُعاد الحساب لغرض التخزين: تمريرُ نتيجة التحليل القائمة هو ما يجعل
 * المخزَّن والمبثوث والمُشتقَّ منه شيئًا واحدًا.
 *
 * `null` تعني «لا تُخزّن تخطيطًا» — والعميل يُخفي الاستشهادات حينها.
 */
export function buildEvidenceLayout(
  lineSegments: readonly (number | null)[],
  v: SegmentationVersion,
): EvidenceLayout | null {
  if (lineSegments.length > MAX_EVIDENCE_LAYOUT_LINES) return null;
  return { v, lines: lineSegments.map((s) => (typeof s === "number" ? s : -1)) };
}

/** يقرأ تخطيطًا محفوظًا بلا ثقة في شكله */
export function readEvidenceLayout(raw: unknown): EvidenceLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const { v, lines } = raw as { v?: unknown; lines?: unknown };
  if (v !== 1 && v !== 2) return null;
  if (!Array.isArray(lines)) return null;
  if (lines.length > MAX_EVIDENCE_LAYOUT_LINES) return null;
  for (const n of lines) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < -1) return null;
  }
  return { v, lines: lines as number[] };
}

/** سبب القرار — رمز مغلق للتشخيص، بلا محتوى */
export type LayoutDecisionReason =
  | "server_layout"
  | "legacy_parse"
  | "hidden_layout_missing"
  | "hidden_version_mismatch"
  | "hidden_unsupported_version";

export interface LayoutDecision {
  /** `"layout"` استهلك المخزَّن · `"legacy"` حلّل بـv1 · `"hidden"` أخفِ */
  mode: "layout" | "legacy" | "hidden";
  lines: number[] | null;
  reason: LayoutDecisionReason;
}

/**
 * ★ القرار الوحيد الذي يحكم عرض الاستشهادات.
 *
 * أربع حالات لا خامسة لها، ولا **تراجع صامت** إلى تحليل في أيٍّ منها:
 *
 *   إصدار + تخطيط متوافقان  ⇒ استهلك المخزَّن — ولا يُستدعى المحلّل إطلاقًا
 *   لا إصدار ولا تخطيط      ⇒ رسالة تاريخية: يُسمح بمحلّل v1 وحده
 *   إصدار بلا تخطيط         ⇒ إخفاء
 *   `layout.v ≠ version`    ⇒ إخفاء
 *
 * والحالة الثالثة والرابعة هما بيت القصيد: إعادة التفسير هناك تُنتج أرقامًا
 * لا تُطابق ما بُنيت عليه الاستشهادات المحفوظة، فتظهر الأزرار في مواضع خاطئة
 * بلا أي إشارة إلى الخطأ. الإخفاء مرئيّ، والموضع المغلوط ليس كذلك.
 */
export function decideLayout(input: {
  version: number | null | undefined;
  layout: EvidenceLayout | null;
  clientMax?: SegmentationVersion;
}): LayoutDecision {
  const { version, layout } = input;
  const clientMax = input.clientMax ?? CLIENT_MAX_VERSION;

  /**
   * «تحمل إصدارًا» ≠ «إصدارًا نفهمه».
   *
   * التفريق مقصود: رسالة من خادم أحدث تحمل إصدارًا حقيقيًّا لا نعرفه، وهي
   * ليست رسالة تاريخية. فحصرُ الشرط في {1,2} كان يجعلها تسقط في «اختلاف
   * الإصدار» ويترك فرع «غير المدعوم» ميتًا لا يُبلَغ أبدًا. والسلوك واحد —
   * إخفاء في الحالين — لكن السبب المسجَّل كان يكذب.
   */
  const hasVersion = typeof version === "number" && Number.isInteger(version) && version >= 1;

  // (١) تاريخية: بلا إصدار وبلا تخطيط ⇒ المحلّل القديم مسموح
  if (!hasVersion && !layout) {
    return { mode: "legacy", lines: null, reason: "legacy_parse" };
  }

  // (٢) إصدار بلا تخطيط ⇒ إخفاء بلا إعادة تفسير
  if (hasVersion && !layout) {
    return { mode: "hidden", lines: null, reason: "hidden_layout_missing" };
  }

  // (٣) تخطيط بلا إصدار، أو اختلافهما ⇒ إخفاء
  if (!layout || !hasVersion || layout.v !== version) {
    return { mode: "hidden", lines: null, reason: "hidden_version_mismatch" };
  }

  // (٤) إصدار أعلى مما تفهمه هذه الحزمة ⇒ إخفاء، ولا هبوط إلى v1
  if (version > clientMax) {
    return { mode: "hidden", lines: null, reason: "hidden_unsupported_version" };
  }

  return { mode: "layout", lines: layout.lines, reason: "server_layout" };
}
