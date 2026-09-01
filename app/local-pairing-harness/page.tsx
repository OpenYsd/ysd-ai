import { notFound } from "next/navigation";

import { PairingHarness } from "@/components/local-pairing/pairing-harness";
import { isLocalPairingEnabled } from "@/lib/local-pairing/flag";

/**
 * مِنصّةُ قبولٍ للاقتران — **تطويرٌ فقط**، ولا وجودَ لها في الإنتاج.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ لماذا صفحةٌ منفصلةٌ أصلًا
 *
 *  لوحةُ الاقتران تعيش في `/settings`، وتلك تشترط جلسةَ Supabase. وقبولُ
 *  البروتوكول في متصفّحٍ حقيقيّ لا علاقةَ له بتسجيل الدخول: المُختبَرُ هو
 *  ما بين المتصفّح والمحرّك على الجهاز، لا ما بين المتصفّح وحسابِ YSD.
 *
 *  فتُقدَّم اللوحةُ **نفسُها** — لا نسخةٌ منها — من مسارٍ لا يشترط حسابًا،
 *  فيُقاس ما يُشحن فعلًا.
 *
 *  ★ وبوّابتان لا واحدة
 *
 *  `NODE_ENV !== "production"` **و** الرايةُ مشتعلة. والأولى وحدَها كافية
 *  لإخراجها من كلّ بناءِ إنتاج؛ والثانيةُ تمنع ظهورَها في تطويرٍ لم تُطلب
 *  فيه الميزة. وحارسٌ في `tests/v135-local-pairing-policy` يمنع سقوطَ
 *  إحداهما.
 * ══════════════════════════════════════════════════════════════════
 */
export default function LocalPairingHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();
  if (!isLocalPairingEnabled()) notFound();
  return <PairingHarness />;
}
