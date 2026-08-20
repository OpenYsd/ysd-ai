import { getAdminContext, forbidden, unauthorized } from "@/lib/admin/guard";
import { buildTrainingSummary } from "@/lib/training/summary";

export const runtime = "nodejs";

/**
 * GET — ملخّص جمع بيانات التدريب (v0.9.11، المرحلة 5A).
 *
 * ── أعدادٌ فقط ──
 *
 * لا نصّ عيّنة، ولا هوّية، ولا معرّف محادثة، ولا بصمة. والمعرّفات تُعدّ
 * مميَّزةً في الخادم ثم تُطرَح عددًا — ولا يصل واحدٌ منها إلى متصفّح.
 *
 * ── و`GET` وحده ──
 *
 * فهذا سؤالٌ عن حال، لا فعلٌ يُحدث أثرًا. ولا `POST` هنا يعتمد شيئًا ولا
 * يُنشئ مجموعة: بلوغُ الحدّ يُقال للمشرف، والقرار قراره.
 */

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET() {
  const ctx = await getAdminContext();
  if (!ctx) {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user ? forbidden() : unauthorized();
  }

  const summary = await buildTrainingSummary();
  if (!summary) return json({ error: "تعذّرت العملية | Operation failed" }, 503);

  return json({ ok: true, ...summary }, 200);
}
