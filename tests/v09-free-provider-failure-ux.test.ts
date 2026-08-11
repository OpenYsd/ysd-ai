import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { ERROR_MESSAGES } from "@/lib/ai/error-codes";

/**
 * فشل المزوّد الطرفي: أثرٌ مفهوم في المحادثة بدل فراغ.
 *
 * الحادثة: أربع محاولات · 44.478 ثانية · لا رسالة مساعد · ولا رسالة خطأ ظاهرة
 * للمستخدم رغم أن الكود يضبط `setError`.
 *
 * ملاحظة على النطاق: كان هنا قسمٌ يحكم بموت `gpt-oss-120b:free` استنادًا إلى
 * واجهة OpenRouter العامة. أُزيل — الواجهة غير المصادَقة تعرض مزوّدين أقلّ
 * ممّا تعرضه صفحة النموذج نفسها، فلا تصلح دليلًا على انعدامهم. السلسلة تبقى
 * أربعة حتى يأتي دليل حيّ من مفتاح YSD نفسه.
 */

const ROUTE = readFileSync("app/api/chat/route.ts", "utf8");
const CHAT_VIEW = readFileSync("components/chat/chat-view.tsx", "utf8");
const NEW_PAGE = readFileSync("app/(app)/chat/page.tsx", "utf8");
const CONV_PAGE = readFileSync("app/(app)/chat/[id]/page.tsx", "utf8");

// ════════════════════════════════════════════════════════════
//  (ب) سبب اختفاء الرسالة — مُثبَت بنيويًا
// ════════════════════════════════════════════════════════════

describe("(ب) لماذا لم تظهر رسالة الخطأ", () => {
  /**
   * ★ السبب المُثبَت: إعادة تركيب المكوّن تمحو حالة العميل.
   *
   * أول رسالة في محادثة جديدة تبدأ في `/chat` (بلا `key`)، ثم ينتقل العنوان
   * إلى `/chat/<id>` حيث `key={id}` — فيُركَّب مكوّن جديد وتُمحى `error`
   * لحظة انتهاء الطلب. ولذلك لا يكفي أي إصلاح يعتمد حالة العميل.
   */
  it("★ الصفحتان تركّبان ChatView بمفتاحين مختلفين", () => {
    expect(CONV_PAGE).toMatch(/<ChatView\s+key=\{id\}/);
    expect(NEW_PAGE).toContain("<ChatView");
    expect(NEW_PAGE).not.toMatch(/<ChatView\s+key=/);
  });

  it("★ العميل يمحو الفقاعة الفارغة عند الانتهاء", () => {
    expect(CHAT_VIEW).toContain('m.role === "assistant" && m.content === ""');
  });

  /** ولذلك الحلّ في الخادم: أثرٌ محفوظ لا حالةُ عميل */
  it("★ ٤+٦) الفشل الطرفي يُحفظ رسالةً معلَّمة ناقصة", () => {
    expect(ROUTE).toContain("providerFailureNotice = true");
    expect(ROUTE).toContain('completionStatus = "incomplete_provider"');
    // يصل العميل فورًا كي لا تُحذف الفقاعة قبل أن يرى شيئًا
    expect(ROUTE).toMatch(/send\(\{ type: "text", text: notice \}\)/);
  });

  it("★ الشرط: بلا نص · برمز خطأ · وليس إلغاءً من المستخدم", () => {
    expect(ROUTE).toContain("if (!assistantText.trim() && lastErrorCode && !clientAborted)");
  });

  it("★ ٧) الإشعار لا يدخل Evidence", () => {
    expect(ROUTE).toContain("!providerFailureNotice &&");
  });

  it("★ نصّ الإشعار عربي وواضح ويقول ما العمل", () => {
    const msg = ERROR_MESSAGES.provider_unavailable;
    expect(msg).toMatch(/[؀-ۿ]/);
    expect(msg).toMatch(/أعد المحاولة/);
    expect(msg).not.toMatch(/[A-Za-z]{4,}/); // بلا مصطلحات تقنية إنجليزية
  });

  /**
   * ★ ٨) لا صفّ مساعد مكرّر: مسار الإدراج واحد.
   *
   * الإشعار يملأ `assistantText` قبل كتلة الحفظ الوحيدة، فيمرّ منها لا
   * بمسار موازٍ. ولو أُضيف إدراج ثانٍ لظهر هنا.
   */
  it("★ ٨) إدراج رسالة المساعد يقع في موضع واحد", () => {
    const inserts = ROUTE.match(/role: "assistant"/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  /**
   * ★ ٩) لا احتساب رموز للإشعار.
   *
   * صفّ الاستهلاك مشروط بوصول إطار `usage` من المزوّد، والفشل الطرفي لا
   * يُنتج إطارًا. فالإشعار لا يضيف رموزًا لأنه لا يمرّ بذلك الشرط أصلًا.
   */
  it("★ ٩) الاستهلاك مشروط بإطار usage من المزوّد", () => {
    expect(ROUTE).toContain("pendingUsage");
    // لا يُشتق الاستهلاك من طول النص
    expect(ROUTE).not.toMatch(/outputTokens:\s*assistantText\.length/);
  });
});

// ════════════════════════════════════════════════════════════
//  (ج) القياسات التشخيصية — بلا محتوى
// ════════════════════════════════════════════════════════════

describe("(ج) سجلّ المحاولة المنظّم", () => {
  const PROVIDER = readFileSync("lib/ai/openrouter.ts", "utf8");
  const logLine =
    PROVIDER.split("\n")
      .filter((l) => l.includes("attempt failed: model="))
      .join("\n") + PROVIDER.slice(PROVIDER.indexOf("attempt failed: model="), PROVIDER.indexOf("attempt failed: model=") + 700);

  it("★ ١٢) يحمل الحقول التشخيصية المطلوبة", () => {
    for (const field of [
      "attempt_index=",
      "timeout_stage=",
      "headers_received=",
      "sse_frame_count=",
      "content_byte_count=",
      "status=",
      "kind=",
    ]) {
      expect(logLine).toContain(field);
    }
  });

  it("★ مراحل المهلة الثلاث معرّفة", () => {
    for (const stage of ["before_response", "first_content", "stream_idle"]) {
      expect(PROVIDER).toContain(`"${stage}"`);
    }
  });

  /**
   * ★ ١٢) ولا يحمل شيئًا حسّاسًا.
   *
   * القيد قائم منذ v0.9.0: لا موجّه ولا نصّ ردّ ولا اسم ملف ولا محتوى مستخدم
   * ولا مفتاح في أي سجل. هذا الحارس يقيسه على السطر الجديد بعينه.
   */
  it("★ ١٢) لا محتوى ولا أسرار في سطر السجل", () => {
    for (const forbidden of [
      "userText",
      "assistantText",
      "prompt",
      "messages",
      "API_KEY",
      "Authorization",
      "file_name",
      "fileName",
      "quote",
      "snippet",
      "text=",
      "content=",
    ]) {
      expect(logLine).not.toContain(forbidden);
    }
    // المسموح: عدّادات فقط بعد content_byte_count
    expect(logLine).toContain("content_byte_count=${result.contentByteCount ?? 0}");
  });
});
