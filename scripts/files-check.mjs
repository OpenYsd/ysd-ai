/**
 * اختبارات Runtime لنظام الملفات عبر المسار الكامل (الخادم المحلي + Supabase).
 * يتطلب: تطبيق migration 0005 + الخادم على المنفذ 3000.
 * لا يطبع أي مفاتيح. التشغيل: node scripts/files-check.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP = process.env.YSD_APP_URL ?? "http://localhost:3000";
const projectRef = new URL(URL_).host.split(".")[0];

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function cookieHeader(session) {
  const name = `sb-${projectRef}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * MAX < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * MAX, (i + 1) * MAX)}`);
  return parts.join("; ");
}

async function newUser(label) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const ts = Date.now();
  const su = await c.auth.signUp({
    email: `ysd.qa.files.${label}.${ts}@qa-ysd.com`,
    password: `Qa!${ts}xYz`,
    options: { data: { display_name: `فاحص ملفات ${label}` } },
  });
  if (su.error) throw new Error(`signup ${label} failed: ${su.error.message}`);
  await c.auth.setSession(su.data.session);
  return { client: c, cookie: cookieHeader(su.data.session), userId: su.data.user.id };
}

async function upload(cookie, name, mime, bytes, extra = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: mime }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(`${APP}/api/files/upload`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** PDF صغير حقيقي يحمل نصًا */
function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + "\n";
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** DOCX صغير حقيقي (zip بمحتوى Word أدنى) */
async function makeDocx(text) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const A = await newUser("a");
const B = await newUser("b");
const fileRow = async (client, id) =>
  (await client.from("files").select("*").eq("id", id).maybeSingle()).data;

console.log("\n=== 1) رفع TXT واستخراج النص ===");
const txtContent = "هذا ملف نصي تجريبي لمنصة YSD AI.\nيحتوي سطرين من النص العربي.";
const up1 = await upload(A.cookie, "ملاحظات.txt", "text/plain", Buffer.from(txtContent, "utf8"));
check("رفع TXT → 201", up1.status === 201, `HTTP ${up1.status} ${up1.body?.error ?? ""}`);
const txtId = up1.body?.file?.id;
check("الحالة ready", up1.body?.file?.status === "ready", String(up1.body?.file?.status));
const txtRow = txtId ? await fileRow(A.client, txtId) : null;
check("النص المستخرج مطابق", txtRow?.extracted_text?.includes("سطرين من النص العربي") === true);

console.log("\n=== 2) رفع PDF واستخراج النص ===");
const up2 = await upload(A.cookie, "report.pdf", "application/pdf", makePdf("Hello YSD AI from PDF"));
check("رفع PDF → 201", up2.status === 201, `HTTP ${up2.status} ${up2.body?.error ?? ""}`);
const pdfId = up2.body?.file?.id;
check("PDF ready ونص مستخرج", up2.body?.file?.status === "ready", `${up2.body?.file?.status} | ${up2.body?.file?.extraction_error ?? ""}`);
const pdfRow = pdfId ? await fileRow(A.client, pdfId) : null;
check("نص PDF يحوي المحتوى", pdfRow?.extracted_text?.includes("Hello YSD AI") === true, (pdfRow?.extracted_text ?? "").slice(0, 40));

console.log("\n=== 3) رفع DOCX واستخراج النص ===");
const docxBuf = await makeDocx("مستند وورد تجريبي لمنصة YSD AI");
const up3 = await upload(
  A.cookie, "doc.docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docxBuf,
);
check("رفع DOCX → 201", up3.status === 201, `HTTP ${up3.status} ${up3.body?.error ?? ""}`);
const docxId = up3.body?.file?.id;
check("DOCX ready", up3.body?.file?.status === "ready", `${up3.body?.file?.status} | ${up3.body?.file?.extraction_error ?? ""}`);
const docxRow = docxId ? await fileRow(A.client, docxId) : null;
check("نص DOCX مطابق", docxRow?.extracted_text?.includes("مستند وورد تجريبي") === true);

console.log("\n=== 4) رفض الأنواع والأحجام ===");
const bad1 = await upload(A.cookie, "malware.exe", "application/x-msdownload", Buffer.from("MZ..."));
check("رفض exe → 400", bad1.status === 400, `HTTP ${bad1.status}`);
const bad2 = await upload(A.cookie, "archive.zip", "application/zip", Buffer.from("PK.."));
check("رفض zip → 400", bad2.status === 400, `HTTP ${bad2.status}`);
const bad3 = await upload(A.cookie, "fake.pdf", "text/plain", Buffer.from("not pdf"));
check("رفض عدم تطابق الامتداد/MIME → 400", bad3.status === 400, `HTTP ${bad3.status}`);
const big = Buffer.alloc(11 * 1024 * 1024, 65); // 11MB > حد free (10MB)
const bad4 = await upload(A.cookie, "big.txt", "text/plain", big);
check("رفض تجاوز حد الحجم → 413", bad4.status === 413, `HTTP ${bad4.status} ${bad4.body?.error ?? ""}`);

console.log("\n=== 5) فشل الاستخراج → failed مع السبب ===");
const corrupt = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 3, 4, 5])]);
const up5 = await upload(A.cookie, "corrupt.pdf", "application/pdf", corrupt);
check("الملف التالف قُبل رفعه ثم فشل الاستخراج", up5.status === 201 && up5.body?.file?.status === "failed", String(up5.body?.file?.status));
check("سبب الفشل مسجل بالعربية", Boolean(up5.body?.file?.extraction_error && /[؀-ۿ]/.test(up5.body.file.extraction_error)));
const corruptId = up5.body?.file?.id;
const retry = await fetch(`${APP}/api/files/${corruptId}/process`, { method: "POST", headers: { Cookie: A.cookie } });
const retryBody = await retry.json();
check("إعادة المعالجة تعمل وتبقى failed", retry.status === 200 && retryBody?.file?.status === "failed", `HTTP ${retry.status}`);

console.log("\n=== 6) الربط بمشروع ومحادثة ===");
const projRes = await fetch(`${APP}/api/projects`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: A.cookie },
  body: JSON.stringify({ name: "مشروع الملفات" }),
});
const projId = (await projRes.json())?.project?.id;
const link1 = await fetch(`${APP}/api/files/${txtId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: A.cookie },
  body: JSON.stringify({ projectId: projId }),
});
check("ربط الملف بمشروع → 200", link1.status === 200, `HTTP ${link1.status}`);
const listByProject = await fetch(`${APP}/api/files?projectId=${projId}`, { headers: { Cookie: A.cookie } });
const listBody = await listByProject.json();
check("قائمة ملفات المشروع تتضمنه", listBody?.files?.some((f) => f.id === txtId) === true);

const convRes = await fetch(`${APP}/api/conversations`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: A.cookie },
  body: "{}",
});
const convId = (await convRes.json())?.conversation?.id;
const link2 = await fetch(`${APP}/api/files/${pdfId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: A.cookie },
  body: JSON.stringify({ conversationId: convId }),
});
check("ربط الملف بمحادثة → 200", link2.status === 200, `HTTP ${link2.status}`);
const unlink1 = await fetch(`${APP}/api/files/${txtId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: A.cookie },
  body: JSON.stringify({ projectId: null }),
});
check("فك ربط الملف عن المشروع", unlink1.status === 200, `HTTP ${unlink1.status}`);

console.log("\n=== 7) التنزيل عبر Signed URL ===");
const dl = await fetch(`${APP}/api/files/${txtId}/download`, { headers: { Cookie: A.cookie } });
const dlBody = await dl.json();
check("رابط تنزيل موقّت → 200", dl.status === 200 && Boolean(dlBody?.url), `HTTP ${dl.status}`);
const fetched = dlBody?.url ? await fetch(dlBody.url) : null;
const fetchedText = fetched ? await fetched.text() : "";
check("محتوى التنزيل مطابق", fetched?.status === 200 && fetchedText.includes("سطرين من النص العربي"), `HTTP ${fetched?.status}`);

console.log("\n=== 8) عزل RLS بين المستخدمين ===");
const spy1 = await fetch(`${APP}/api/files/${txtId}`, { headers: { Cookie: B.cookie } });
check("ب لا يقرأ ملف أ → 404", spy1.status === 404, `HTTP ${spy1.status}`);
const spy2 = await fetch(`${APP}/api/files/${txtId}/download`, { headers: { Cookie: B.cookie } });
check("ب لا ينزّل ملف أ → 404", spy2.status === 404, `HTTP ${spy2.status}`);
const spy3 = await fetch(`${APP}/api/files/${txtId}`, { method: "DELETE", headers: { Cookie: B.cookie } });
check("ب لا يحذف ملف أ → 404", spy3.status === 404, `HTTP ${spy3.status}`);
const spy4 = await B.client.from("files").select("id").eq("id", txtId);
check("RLS: ب لا يرى الصف مباشرة", spy4.data?.length === 0);
// وصول مباشر للتخزين بمسار أ
const aPath = txtRow?.storage_path ?? `${A.userId}/general/unknown/file.txt`;
const spy5 = await B.client.storage.from("files").download(aPath);
check("Storage: ب لا ينزّل بمسار أ", Boolean(spy5.error));
const spy6 = await B.client.storage.from("files").createSignedUrl(aPath, 60);
check("Storage: ب لا يوقّع رابطًا لمسار أ", Boolean(spy6.error));
// ب لا يرفع في مجلد أ
const spy7 = await B.client.storage.from("files").upload(`${A.userId}/general/x/hack.txt`, Buffer.from("x"));
check("Storage: ب لا يرفع في مجلد أ", Boolean(spy7.error));

console.log("\n=== 8ب) قيود الـ Bucket نفسها ===");
// خاص: الوصول العام المباشر (بدون توقيع) يجب أن يفشل
const publicUrl = `${URL_}/storage/v1/object/public/files/${aPath}`;
const pubRes = await fetch(publicUrl);
check("Bucket خاص: لا وصول عامًا بدون توقيع", pubRes.status !== 200, `HTTP ${pubRes.status}`);
// تقييد MIME على مستوى المزود (migration 0006): رفع نوع محظور مباشرة إلى Storage
const mimeBypass = await A.client.storage
  .from("files")
  .upload(`${A.userId}/general/qa-mime/evil.bin`, Buffer.from("MZ..."), {
    contentType: "application/x-msdownload",
  });
check("Bucket يرفض MIME محظورًا حتى بتجاوز API (0006)", Boolean(mimeBypass.error), mimeBypass.error?.message?.slice(0, 60) ?? "uploaded!");
if (!mimeBypass.error) {
  await A.client.storage.from("files").remove([`${A.userId}/general/qa-mime/evil.bin`]);
}

console.log("\n=== 9) البقاء بعد التحديث ثم الحذف ===");
const again = await fileRow(A.client, txtId);
check("بيانات الملف باقية بعد إعادة الجلب", again?.original_name === "ملاحظات.txt" && again?.status === "ready");
const del = await fetch(`${APP}/api/files/${txtId}`, { method: "DELETE", headers: { Cookie: A.cookie } });
check("حذف الملف → 200", del.status === 200, `HTTP ${del.status}`);
const afterDel = await fetch(`${APP}/api/files/${txtId}`, { headers: { Cookie: A.cookie } });
check("بعد الحذف → 404", afterDel.status === 404, `HTTP ${afterDel.status}`);
const gone = await A.client.storage.from("files").download(aPath);
check("الملف أُزيل من التخزين فعلًا", Boolean(gone.error));
const softRow = await A.client.from("files").select("status, deleted_at").eq("id", txtId).maybeSingle();
check("الحذف ناعم في قاعدة البيانات", softRow.data?.status === "deleted" && softRow.data?.deleted_at !== null);

console.log("\n=== 10) تنظيف ===");
for (const id of [pdfId, docxId, corruptId]) {
  if (id) await fetch(`${APP}/api/files/${id}`, { method: "DELETE", headers: { Cookie: A.cookie } });
}
console.log("  ℹ حُذفت ملفات الاختبار — مستخدما QA يحتاجان service role للحذف الكامل.");

console.log(`\n========================================`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (failures.length) { console.log("الإخفاقات:", failures.join(" | ")); process.exit(1); }
