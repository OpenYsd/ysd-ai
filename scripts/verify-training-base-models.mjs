/**
 * التحقّق من هوّية النماذج الأساسية المثبَّتة (v0.9.9، المرحلة 4B-A).
 *
 * ── متى يُشغَّل ──
 *
 * عند تثبيت مراجعةٍ جديدة، أو عند مراجعة القائمة. **لا** مع كل طلب ولا في
 * البناء: هوّيةُ النموذج تُتحقَّق منها **مرّة** ثم تُكتب في الشيفرة وتمرّ
 * من مراجعةٍ ودَفعٍ ونشر. وإنتاجٌ يسأل مستودعًا خارجيًّا عند كل إنشاء
 * مهمّةٍ يربط عملَه بتوفّر خدمةٍ لا يملكها.
 *
 *   npm run verify:base-models
 *
 * ── وما لا يفعله ──
 *
 * لا يُنزّل أوزانًا (نحو ١٢٫٨ ج.ب للـ20B). التحقّق بالوصف وحده: المراجعة،
 * وشجرة الملفّات، والأحجام، ومعرّفات LFS. ولا رمزَ ولا مفتاح: المستودع
 * عامّ، ومن يضيف رمزًا هنا يضيف سرًّا إلى مسارٍ لا يحتاجه.
 */

import { readFileSync } from "node:fs";

const API = "https://huggingface.co/api/models";
const COMMIT_SHA = /^[a-f0-9]{40}$/;

/** ما يجب أن يوجد عند المراجعة — وإلّا فليست لقطةَ أوزانٍ كاملة */
const REQUIRED = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "model.safetensors.index.json",
  "LICENSE",
];

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}`);
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

/**
 * ★ يقرأ القائمة من المصدر نفسه لا من نسخةٍ ثانية.
 *
 * فسكربتٌ يحمل قائمته الخاصّة يتحقّق من قائمته هو — ويظلّ أخضر بينما
 * الشيفرة تحمل غيرها.
 */
function readCatalog() {
  const src = readFileSync("lib/training/base-models.ts", "utf8");
  const entries = [];
  const re = /id:\s*"([^"]+)"[\s\S]*?upstreamRef:\s*"([^"]+)"[\s\S]*?defaultRevision:\s*(null|"([a-f0-9]+)")/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({ id: m[1], upstreamRef: m[2], revision: m[4] ?? null });
  }
  return entries;
}

async function verify(entry) {
  console.log(`\n▶ ${entry.id}`);

  if (entry.revision === null) {
    console.log("  ⏭  غير مثبَّت — لا شيء يُتحقَّق منه (وهذا مقصود)");
    return;
  }

  ok(COMMIT_SHA.test(entry.revision), "المراجعة أربعون خانةً ستّ عشريّة");

  const repo = encodeURI(entry.upstreamRef);

  /** (١) المستودع الرسميّ — عامٌّ وغير مقيَّد */
  const model = await getJson(`${API}/${repo}`);
  ok(model.id === entry.upstreamRef, `المستودع ${model.id}`);
  ok(model.private === false, "عامّ");
  ok(!model.gated, "غير مقيَّد");

  /** (٢) المراجعة تُحلّ إلى نفسها — أي أنها التزامة لا اسم */
  const atRev = await getJson(`${API}/${repo}/revision/${entry.revision}`);
  ok(atRev.sha === entry.revision, "المراجعة تُحلّ إلى نفسها");

  /** (٣) وليست اسمَ فرعٍ ولا وسم */
  const refs = await getJson(`${API}/${repo}/refs`);
  const names = [...(refs.branches ?? []), ...(refs.tags ?? [])].map((r) => r.name);
  ok(!names.includes(entry.revision), `ليست اسمًا متحرّكًا (${names.join(", ")})`);

  /** (٤) الملفّات عند تلك المراجعة */
  const files = (atRev.siblings ?? []).map((f) => f.rfilename);
  for (const f of REQUIRED) ok(files.includes(f), `موجود: ${f}`);
  const shards = files.filter((f) => f.endsWith(".safetensors") && !f.includes("index"));
  ok(shards.length > 0, `شرائح الأوزان: ${shards.length}`);

  /** (٥) الرخصة — من المصدر لا من الشيفرة */
  const license = (atRev.cardData ?? {}).license ?? null;
  ok(license === "apache-2.0", `الرخصة ${license}`);

  /** (٦) دليل هوّية الأوزان — وصفًا لا تنزيلًا */
  const res = await fetch(`${API}/${repo}/paths-info/${entry.revision}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: shards, expand: true }),
  });
  if (res.ok) {
    const rows = await res.json();
    let total = 0;
    for (const r of rows) {
      const lfs = r.lfs ?? {};
      const size = lfs.size ?? r.size ?? 0;
      total += size;
      const oid = (lfs.oid ?? "").slice(0, 16);
      console.log(`     ${r.path}  ${size.toLocaleString()} B  oid=${oid}…`);
    }
    ok(total > 0, `مجموع الأوزان ${(total / 1024 ** 3).toFixed(1)} ج.ب — لم تُنزَّل`);
  }
}

const catalog = readCatalog();
console.log(`قائمة النماذج: ${catalog.length}`);
for (const entry of catalog) {
  try {
    await verify(entry);
  } catch (e) {
    failed += 1;
    console.log(`  ❌ ${entry.id}: ${String(e.message ?? e)}`);
  }
}

console.log(`\n═══ النتيجة: ${passed}/${passed + failed} ${failed === 0 ? "✅" : "❌"}   الإخفاقات: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
