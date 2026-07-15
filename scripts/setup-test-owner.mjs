/**
 * ينشئ حساب اختبار owner بكلمة مرور مولّدة (تُحفظ في ملف مُتجاهَل بـ git)،
 * ويطبع البريد + سطر SQL للترقية. لا يطبع كلمة المرور ولا أسرار المستخدم.
 * التشغيل: node scripts/setup-test-owner.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const email = `ysd.qa.owner.fixed@qa-ysd.com`;
const password = `Owner!${Math.random().toString(36).slice(2)}${Date.now().toString(36)}Zx9`;

const su = await c.auth.signUp({ email, password, options: { data: { display_name: "QA Owner" } } });
if (su.error && !/already registered/i.test(su.error.message)) {
  console.error("signup failed:", su.error.message);
  process.exit(1);
}

// نحفظ البيانات في ملف مُتجاهَل لتستخدمه admin-check دون طباعتها
writeFileSync(new URL("./.qa-owner.json", import.meta.url), JSON.stringify({ email, password }), "utf8");

console.log("تم إنشاء حساب اختبار owner (كلمته محفوظة محليًا في scripts/.qa-owner.json المُتجاهَل).");
console.log("\nشغّل هذا السطر في Supabase SQL Editor لترقيته:");
console.log("------------------------------------------------------------");
console.log(`update public.profiles set role = 'owner'`);
console.log(`where id = (select id from auth.users where email = '${email}');`);
console.log("------------------------------------------------------------");
console.log("\nبعد الترقية أخبرني، وسأشغّل السلسلة الكاملة (owner/admin/UI).");
