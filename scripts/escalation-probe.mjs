/**
 * إثبات دقيق لإغلاق ثغرة التصعيد + البند 4 (تعديل الأعمدة الشخصية ينجح).
 * بحساب user حقيقي عبر Supabase Client. لا يطبع أسرارًا.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ts = Date.now();
const su = await c.auth.signUp({ email: `ysd.qa.esc.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz`, options: { data: { display_name: "قبل" } } });
await c.auth.setSession(su.data.session);
const uid = su.data.user.id;

console.log("=== 2/3) محاولة تصعيد role إلى admin مباشرة ===");
const esc = await c.from("profiles").update({ role: "admin" }).eq("id", uid).select("role");
console.log("  خطأ الصلاحية:", esc.error ? `${esc.error.code} ${esc.error.message}` : "لا خطأ (سيئ!)");
const roleNow = (await c.from("profiles").select("role").eq("id", uid).single()).data?.role;
console.log(`  الدور بعد المحاولة: ${roleNow}  → ${roleNow === "user" ? "✅ لم يتغير" : "❌ تغيّر!"}`);

console.log("\n=== محاولة تصعيد status ===");
const escS = await c.from("profiles").update({ status: "active" }).eq("id", uid).select("status");
console.log("  خطأ الصلاحية على status:", escS.error ? `${escS.error.code}` : "لا خطأ (سيئ!)");

console.log("\n=== 4) تعديل display_name وlocale يجب أن ينجح ===");
const ok = await c.from("profiles").update({ display_name: "بعد", locale: "en" }).eq("id", uid).select("display_name, locale").single();
console.log("  نتيجة:", ok.error ? `❌ ${ok.error.code}` : `✅ ${ok.data.display_name} / ${ok.data.locale}`);

console.log("\n=== 5) تأكيد من قاعدة البيانات: role ما زال user ===");
const final = (await c.from("profiles").select("role, status, display_name, locale").eq("id", uid).single()).data;
console.log(`  role=${final.role} status=${final.status} name=${final.display_name} locale=${final.locale}`);
console.log(final.role === "user" ? "  ✅ الثغرة مغلقة والأعمدة الشخصية قابلة للتعديل" : "  ❌ خلل");
