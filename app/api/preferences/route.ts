import { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { listAvailableModels } from "@/lib/ai/registry";

export const runtime = "nodejs";

const schema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  defaultModelId: z.string().min(1).max(100).nullable().optional(),
});

/** حفظ تفضيلات المستخدم */
export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات غير صحيحة." }, 400);

  const { theme, defaultModelId } = parsed.data;

  // النموذج الافتراضي يجب أن يكون من النماذج المتاحة فعلًا
  if (
    defaultModelId &&
    !listAvailableModels().some((m) => m.id === defaultModelId)
  ) {
    return json({ error: "النموذج غير متاح." }, 400);
  }

  const update: Record<string, unknown> = { user_id: user.id };
  if (theme !== undefined) update.theme = theme;
  if (defaultModelId !== undefined) update.default_model_id = defaultModelId;

  const { error } = await supabase.from("user_preferences").upsert(update);
  if (error) return json({ error: "تعذّر حفظ التفضيلات." }, 500);
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
