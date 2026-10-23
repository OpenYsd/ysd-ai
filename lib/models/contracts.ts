/**
 * عقد بوابة النماذج — أنواع ودوال صافية يشترك فيها الخادم والعميل.
 *
 * ── الحدّ ──
 *
 * هنا **وصف** النموذج وما يقبله وما يُخرجه وقدراته، وترتيب عرضه في المنتقي.
 * لا أسماء نماذج ولا معرّفات ولا نقاط اتصال: كل نموذج يأتي من مزوّده المسجّل في
 * lib/ai/registry.ts، ونماذج YSD المستقبلية تدخل من هناك مثل غيرها.
 * والتشغيل نفسه (البثّ، الاحتياط، التهدئة) يبقى في lib/ai بلا تغيير.
 */

/** أنواع المدخلات والمخرجات. الغياب في تعريف المزوّد = نصّ فقط (لا ادّعاء بقدرة لم تُعلَن) */
export type Modality = "text" | "image" | "audio" | "file";

export const DEFAULT_INPUT: readonly Modality[] = ["text"];
export const DEFAULT_OUTPUT: readonly Modality[] = ["text"];

export interface ModelCapabilities {
  /** البثّ — من إعلان المزوّد؛ غيابه يعني مدعومًا (عقد AIProviderAdapter) */
  streaming: boolean;
}

/** وصف نموذجٍ متاحٍ فعلًا: مزوّده مهيّأ، وهو مفعَّل، ويجوز للمستخدم اختياره */
export interface ModelDescriptor {
  id: string;
  providerId: string;
  providerName: string;
  nameAr: string;
  nameEn: string;
  contextWindow: number;
  input: readonly Modality[];
  output: readonly Modality[];
  capabilities: ModelCapabilities;
}

/** ما يصل منتقي النموذج: الاسم والإتاحة لهذا المستخدم — الشكل الذي تقبله ChatView */
export interface PickerModel {
  id: string;
  nameAr: string;
  nameEn: string;
  provider?: string;
  /** غيابه = متاح (المزوّدات القائمة لا ترسله) */
  available?: boolean;
  /** خارج خطة المستخدم: يُعرض بشارة ولا يُختار */
  locked?: boolean;
  minTier?: string;
}

export function accepts(model: Pick<ModelDescriptor, "input">, modality: Modality): boolean {
  return model.input.includes(modality);
}

/**
 * ترتيب المنتقي: النموذج الحالي، ثم المتاح، ثم غير المتاح والمقفول في قسمين.
 * `available !== false` لا `=== true`: غياب الحقل يعني «متاح».
 */
export function orderForPicker<T extends PickerModel>(
  models: readonly T[],
  selectedId: string | null,
): { available: T[]; unavailable: T[]; locked: T[] } {
  const locked = models.filter((m) => m.locked === true);
  const rest = models.filter((m) => m.locked !== true);
  const available = rest.filter((m) => m.available !== false);
  const unavailable = rest.filter((m) => m.available === false);
  available.sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0));
  return { available, unavailable, locked };
}
