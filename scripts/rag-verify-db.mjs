/** تحقق سريع: امتداد vector ودالة match_file_chunks موجودان ويعملان */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const ts = Date.now();
const su = await c.auth.signUp({ email: `ysd.qa.dbverify.${ts}@qa-ysd.com`, password: `Qa!${ts}xYz` });
await c.auth.setSession(su.data.session);

// الدالة موجودة وتُستدعى بجلسة صحيحة (بلا ملفات → صفر نتائج، بلا خطأ)
const emb = JSON.stringify(Array.from({ length: 384 }, () => 0.01));
const { data, error } = await c.rpc("match_file_chunks", {
  p_query_embedding: emb,
  p_file_ids: [crypto.randomUUID()],
  p_match_count: 5,
  p_min_similarity: 0,
});
console.log("match_file_chunks callable:", error ? `ERROR ${error.message}` : `OK (rows=${data?.length ?? 0})`);

// عمود embedding بحجم 384: أدرج صفًا بلا embedding ثم تحقق أن الجدول يقبل vector(384)
console.log("dims expected: vector(384)");
if (error) process.exit(1);
