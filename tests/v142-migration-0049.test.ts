import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * v142 — الترحيل 0049: فهرسُ بصمة المحتوى.
 *
 * ★ ما يُحرس هنا بنيويًّا (والسلوكُ نفسُه أُثبت على Postgres حقيقيّ في staging
 *   داخل معاملةٍ مُلغاة: تكرارُ المحادثة نفسها يُرفض 23505، والمحادثةُ الأخرى
 *   مسموحة، وغيرُ المربوط مرّتين يُرفض، والمحذوفُ منطقيًّا لا يحجب، والصفوفُ
 *   القديمة بلا بصمة تتكرّر، والبناءُ ينجح فوق تكرارٍ قديم ويُرفض فوق تكرارٍ مبصوم):
 *
 *   ١) الفهرسُ جزئيّ: يستثني المحذوفَ منطقيًّا والصفوفَ القديمة بلا بصمة — وإلّا
 *      فشل إنشاؤه على الإنتاج (فيه مجموعاتُ تكرارٍ قديمة) أو حجب إعادةَ رفعٍ بعد حذف.
 *   ٢) مفتاحُه هو مفتاحُ بحث المسار حرفيًّا — لو افترقا لبحث المسارُ عن توأمٍ
 *      بمفتاحٍ ويرفض الفهرسُ بآخر، فيفشل الرفعُ 500 بدل أن يُعاد الصفُّ القائم.
 *   ٣) إضافيٌّ محض: لا حذفَ ولا تعديلَ لبيانات.
 */

const SQL = readFileSync("supabase/migrations/0049_file_content_fingerprint.sql", "utf8");
const code = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .replace(/\s+/g, " ")
  .toLowerCase();
const ROUTE = readFileSync("app/api/files/upload/route.ts", "utf8");

describe("★ 0049 — شكلُ الفهرس", () => {
  it("★ ★ ★ فهرسٌ فريدٌ متكرّرُ التطبيق بلا ضرر (if not exists)", () => {
    expect(code).toContain("create unique index if not exists files_content_fingerprint_uniq on public.files");
  });

  it("★ ★ ★ جزئيّ: يستثني المحذوفَ منطقيًّا والصفوفَ القديمة بلا بصمة", () => {
    expect(code).toMatch(/where deleted_at is null and metadata->>'content_sha256' is not null/);
  });

  it("★ ★ ★ المفتاح: المستخدم، المحادثة (NULL مطويّةٌ إلى قيمةٍ ثابتة)، البصمة، الحجم", () => {
    expect(code).toContain(
      "user_id, coalesce(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid), (metadata->>'content_sha256'), size_bytes",
    );
  });

  it("★ ★ ★ إضافيٌّ محض: لا حذف ولا تعديل ولا إسقاط", () => {
    expect(code).not.toMatch(/\b(delete from|update |drop |truncate |alter table)/);
  });
});

describe("★ 0049 ⇄ مسار الرفع — المفتاحُ نفسُه في الطرفين", () => {
  it("★ ★ ★ بحثُ التوأم يرشّح بأعمدة الفهرس نفسها وشرطه نفسه", () => {
    const twin = ROUTE.slice(ROUTE.indexOf("async function findContentTwin"));
    expect(twin).toContain('.eq("user_id", userId)');
    expect(twin).toContain('.is("deleted_at", null)');
    expect(twin).toContain('.eq("metadata->>content_sha256", contentSha)');
    expect(twin).toContain('.eq("size_bytes", sizeBytes)');
    expect(twin).toMatch(/q\.eq\("conversation_id", conversationId\) : q\.is\("conversation_id", null\)/);
  });

  it("★ ★ ★ الإدراجُ يكتب البصمة، و23505 يُعيد صفَّ الرابح لا خطأ 500", () => {
    expect(ROUTE).toMatch(/content_sha256: contentSha/);
    expect(ROUTE).toMatch(/insertError\.code === "23505"/);
  });
});
