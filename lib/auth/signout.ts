import type { NextResponse } from "next/server";

/**
 * أدوات تسجيل الخروج — مهلة قصيرة ومسح كوكيز الجلسة.
 *
 * المشكلة التي تعالجها: `supabase.auth.signOut()` رحلة شبكية إلى GoTrue. حين
 * تتعثّر، كان الطلب يتعلّق على `/auth/signout` حتى مهلة المنصّة، فيبقى المستخدم
 * على صفحة بيضاء ثم يرى خطأ — **وهو ما زال داخلًا**، لأن الكوكيز لم تُمسح.
 *
 * القاعدة هنا: الخروج **قرارٌ محلّي** لا يملك الخادم البعيد نقضه. نُبلغ GoTrue
 * إن أمكن، لكن مسح الكوكيز والتحويل يقعان في كل الأحوال. أسوأ ما يحدث عند
 * انتهاء المهلة أن يبقى refresh token صالحًا في القاعدة بلا حاملٍ له — وهذا
 * أهون بكثير من مستخدمٍ ظنّ أنه خرج ولم يخرج.
 */

/** مهلة نداء GoTrue. قصيرة عمدًا: الخروج يجب أن يبدو فوريًا. */
export const SIGNOUT_TIMEOUT_MS = 5_000;

/**
 * يسابق وعدًا بمهلة. **لا يُلغي** الاستدعاء — يمضي دونه فقط؛ ولو أُلغي لما
 * وصل GoTrue الإبلاغُ أصلًا في الحالات التي يكون فيها بطيئًا لا ميتًا.
 *
 * وفشل الاستدعاء يُعامل معاملة النجاح: لا شيء نفعله حياله، والتحويل واجب.
 */
export async function withTimeout(p: Promise<unknown>, ms: number): Promise<{ timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const settled = await Promise.race([
    p.then(() => "done" as const).catch(() => "done" as const),
    timeout,
  ]);
  clearTimeout(timer);
  return { timedOut: settled === "timeout" };
}

/**
 * كوكي جلسة Supabase: `sb-<ref>-auth-token` وقد تكون مجزّأة (`.0`, `.1`) حين
 * يتجاوز التوكن حدّ حجم الكوكي، وكذلك `-code-verifier` أثناء تدفّق OAuth.
 * النمط نفسه المستعمل في الوسيط، فلا يفترقان.
 */
export function isSupabaseAuthCookie(name: string): boolean {
  return /^sb-.*auth-token/.test(name);
}

/**
 * يمسح كوكيز الجلسة من **استجابة الخادم** — لا من العميل. يُعيد الأسماء
 * الممسوحة (للعدّ في السجل، لا للطباعة).
 */
export function clearAuthCookies(res: NextResponse, cookieNames: string[]): string[] {
  const cleared = cookieNames.filter(isSupabaseAuthCookie);
  for (const name of cleared) {
    res.cookies.set(name, "", { path: "/", maxAge: 0, expires: new Date(0) });
  }
  return cleared;
}
