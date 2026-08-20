import { YSD_FREE_MODEL_ID } from "./free-models";

/**
 * سطرُ توضيحٍ تحت اسم النموذج (v0.9.14، المرحلة 6C) — **عرضٌ لا توجيه**.
 *
 * ── لماذا ──
 *
 * كان `ysd/free` يُعرض «YSD مجاني» و`ysd/model-alpha` يُعرض «نموذج YSD
 * (ألفا)». والاسمان يقرأهما المستخدم على أن YSD تملك النموذج وتُدرّبه —
 * وذلك ليس واقعًا: الأوزان مفتوحة، وما تملكه YSD طبقاتُ التشغيل والتوجيه
 * والاسترجاع والأمان وتجربة المنتج.
 *
 * والادّعاء لا يُكسب ثقةً: يكذّبه أوّل سؤالٍ تقنيّ، فيسقط معه ما هو صحيح.
 *
 * ── وما لا تفعله هذه الوحدة ──
 *
 * لا تمسّ معرّفًا منطقيًّا ولا توجيهًا ولا اختيار مزوّد ولا سلسلة الاحتياط.
 * خريطةُ نصوصٍ للعرض، وحدها.
 *
 * ── ولماذا المعرّف مكتوب هنا ──
 *
 * `YSD_ALPHA_MODEL_ID` يقيم في `lib/ai/ysd.ts` وهو `server-only`، فلا
 * يُستورَد في مكوّن عميل. والقيمة مكتوبةٌ هنا ويحرس تطابقَها اختبار — نسخةٌ
 * مكشوفةٌ محروسة خيرٌ من استيرادٍ يكسر البناء.
 */

/** يطابق `YSD_ALPHA_MODEL_ID` في `lib/ai/ysd.ts` — يحرسه `tests/v125` */
export const YSD_ALPHA_MODEL_ID_PUBLIC = "ysd/model-alpha";

export type ModelNoteKey = "modelNoteFree" | "modelNoteAlpha";

/** معرّف النموذج ⇒ مفتاح الشرح في القاموس */
export const MODEL_NOTE_KEYS: Readonly<Record<string, ModelNoteKey>> = Object.freeze({
  [YSD_FREE_MODEL_ID]: "modelNoteFree",
  [YSD_ALPHA_MODEL_ID_PUBLIC]: "modelNoteAlpha",
});

/** الشرح إن وُجد — وإلا `null` فلا يُرسم سطرٌ فارغ */
export function modelNoteKey(modelId: string): ModelNoteKey | null {
  return MODEL_NOTE_KEYS[modelId] ?? null;
}
