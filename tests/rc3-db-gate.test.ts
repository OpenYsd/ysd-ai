/**
 * بوابة قاعدة البيانات (v0.6.6 RC3) — تحقق المعرّف، عزل عميل الخدمة،
 * وسلامة الترحيلَين. بلا شبكة وبلا أسرار حقيقية.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CLIENT_REQUEST_ID_RE, chatRequestSchema } from "../lib/validation/chat";
import { _resetAdminClient, getAdminClient, isServiceRoleConfigured } from "../lib/supabase/admin";

const SQL_0017 = fs.readFileSync(
  path.resolve("supabase/migrations/0017_chat_request_ids.sql"),
  "utf8",
);
const SQL_0018 = fs.readFileSync(
  path.resolve("supabase/migrations/0018_observability_events.sql"),
  "utf8",
);

const validBody = (id?: string) => ({
  conversationId: "11111111-1111-4111-8111-111111111111",
  modelId: "ysd/free",
  message: "مرحبا",
  ...(id === undefined ? {} : { clientRequestId: id }),
});

describe("★ RC3 — تحقق client_request_id", () => {
  it("★ يرفض المسافات والعربية والرموز غير المسموحة", () => {
    for (const bad of [
      "مع مسافة",
      "معرّف عربي",
      "has space",
      "has/slash",
      "semi;colon",
      "quote'here",
      "with.dot",
      "emoji😀here",
      "short",           // أقصر من 8
      "a".repeat(65),    // أطول من 64
      "",
    ]) {
      expect(CLIENT_REQUEST_ID_RE.test(bad), `يجب رفض: ${bad}`).toBe(false);
      expect(chatRequestSchema.safeParse(validBody(bad)).success).toBe(false);
    }
  });

  it("★ يقبل UUID والمعرّفات المستعملة فعليًا", () => {
    for (const good of [
      "550e8400-e29b-41d4-a716-446655440000", // UUID v4
      "e2e-double-1737000000000",             // من اختبارات Playwright
      "req_ABC123xyz",
      "a1b2c3d4",                             // 8 أحرف بالضبط
      "A".repeat(64),                         // 64 بالضبط
    ]) {
      expect(CLIENT_REQUEST_ID_RE.test(good), `يجب قبول: ${good}`).toBe(true);
      expect(chatRequestSchema.safeParse(validBody(good)).success).toBe(true);
    }
  });

  it("المعرّف اختياري — غيابه لا يُفشل الطلب", () => {
    expect(chatRequestSchema.safeParse(validBody()).success).toBe(true);
  });

  it("★ نمط Zod مطابق حرفيًا لقيد القاعدة", () => {
    expect(SQL_0017).toContain("^[A-Za-z0-9_-]{8,64}$");
    expect(CLIENT_REQUEST_ID_RE.source).toBe("^[A-Za-z0-9_-]{8,64}$");
  });
});

describe("★ RC3 — عميل الخدمة معزول عن المتصفح", () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeEach(() => _resetAdminClient());
  afterEach(() => {
    if (saved === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
    _resetAdminClient();
  });

  it("★ الملف server-only — يستحيل استيراده في حزمة المتصفح", () => {
    const src = fs.readFileSync(path.resolve("lib/supabase/admin.ts"), "utf8");
    expect(src).toMatch(/^import "server-only";/m);
  });

  it("★ المفتاح بلا بادئة NEXT_PUBLIC في أي مكان", () => {
    const src = fs.readFileSync(path.resolve("lib/supabase/admin.ts"), "utf8");
    expect(src).not.toMatch(/NEXT_PUBLIC_SUPABASE_SERVICE|NEXT_PUBLIC_SERVICE/);
    expect(src).toContain("process.env.SUPABASE_SERVICE_ROLE_KEY");
  });

  it("★ غياب المفتاح لا يرمي — يُرجع null فقط", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isServiceRoleConfigured()).toBe(false);
    expect(() => getAdminClient()).not.toThrow();
    expect(getAdminClient()).toBeNull();
  });

  it("★ لا يُطبع المفتاح ولا قيمته في أي سجل", () => {
    const src = fs.readFileSync(path.resolve("lib/supabase/admin.ts"), "utf8");
    // كل console هنا يجب أن يكون رمزًا ثابتًا بلا استيفاء متغيرات
    const logs = src.match(/console\.\w+\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/key|token|SERVICE_ROLE/i);
      expect(l).not.toMatch(/\$\{/); // بلا استيفاء
    }
    expect(src).toContain("observability_persistence=disabled");
  });

  it("لا يُستورد عميل الخدمة من أي مكوّن عميل", () => {
    const clientFiles = ["components/chat/chat-view.tsx"];
    for (const f of clientFiles) {
      const p = path.resolve(f);
      if (!fs.existsSync(p)) continue;
      expect(fs.readFileSync(p, "utf8")).not.toContain("supabase/admin");
    }
  });
});

describe("★ RC3 — سلامة الترحيلَين", () => {
  it("★ لا DROP لجدول أو عمود أو بيانات", () => {
    for (const sql of [SQL_0017, SQL_0018]) {
      expect(sql).not.toMatch(/drop\s+table(?!\s+if\s+exists\s+public\.(chat_request_ids|observability_events))/i);
      expect(sql).not.toMatch(/drop\s+(column|database|schema)/i);
      expect(sql).not.toMatch(/truncate/i);
      // كل DROP موجود هو drop policy فقط
      for (const m of sql.match(/drop\s+\w+/gi) ?? []) {
        expect(m.toLowerCase()).toBe("drop policy");
      }
    }
  });

  it("★ search_path مثبّت بـpg_temp في كل SECURITY DEFINER", () => {
    // التعليقات تذكر «security definer» شرحًا — تُجرَّد قبل العدّ
    const stripComments = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");

    for (const sql of [SQL_0017, SQL_0018]) {
      const code = stripComments(sql);
      const definers = (code.match(/security definer/gi) ?? []).length;
      const guarded = (code.match(/set search_path = public, pg_temp/gi) ?? []).length;
      expect(definers).toBeGreaterThan(0);
      expect(guarded).toBe(definers);
      expect(code).not.toMatch(/set search_path = public\s*$/im); // لا الصيغة الضعيفة
    }
  });

  it("★ 0017: القيد الفريد والتنظيف المحدود بالمنتهي", () => {
    expect(SQL_0017).toMatch(/unique\s*\(user_id,\s*client_request_id\)/i);
    expect(SQL_0017).toMatch(/delete from public\.chat_request_ids where expires_at < now\(\)/i);
    // لا حذف بلا شرط
    expect(SQL_0017).not.toMatch(/delete from public\.chat_request_ids\s*;/i);
  });

  it("★ 0018: قراءة إدارية فقط ولا سياسة كتابة لأي مستخدم", () => {
    expect(SQL_0018).toMatch(/for select\s+using \(public\.is_admin\(\)\)/i);
    // لا create policy للإدراج/التحديث/الحذف
    expect(SQL_0018).not.toMatch(/create policy[\s\S]*?for (insert|update|delete)/i);
    expect(SQL_0018).toMatch(/revoke all on public\.observability_events from anon, authenticated/i);
    expect(SQL_0018).toMatch(/delete from public\.observability_events where created_at </i);
  });

  it("★ 0018: بلا أعمدة نص مستخدم/مساعد أو بريد أو IP", () => {
    const forbidden = [
      /\buser_text\b/i, /\bassistant_text\b/i, /\bcontent\b/i, /\bmessage\b/i,
      /\bemail\b/i, /\bip_address\b/i, /\bip\b\s+(text|inet)/i, /\buser_agent\b/i,
      /\bfile_content\b/i, /\bprompt\b/i,
    ];
    // نفحص تعريف الجدول وحده (التعليقات تذكر هذه الكلمات نفيًا)
    const body = SQL_0018.slice(
      SQL_0018.indexOf("create table"),
      SQL_0018.indexOf(");", SQL_0018.indexOf("create table")),
    );
    for (const re of forbidden) expect(body, `عمود ممنوع: ${re}`).not.toMatch(re);
    expect(body).not.toMatch(/\buser_id\b/); // ولا حتى هوية المستخدم
  });

  it("★ 0018: القيم النصية كلها enums مغلقة", () => {
    const body = SQL_0018.slice(SQL_0018.indexOf("create table"), SQL_0018.indexOf("create index"));
    // كل عمود text يجب أن يتبعه check (...)
    const textCols = body.match(/^\s*(\w+)\s+text\b/gim) ?? [];
    expect(textCols.length).toBeGreaterThan(0);
    for (const col of textCols) {
      const name = col.trim().split(/\s+/)[0]!;
      const idx = body.indexOf(name);
      expect(body.slice(idx, idx + 400)).toMatch(/check\s*\(/i);
    }
  });
});

describe("★ RC3 — لا تراجع في idempotency", () => {
  it("جدول الحجز لا يحفظ نص الرسالة", () => {
    const body = SQL_0017.slice(SQL_0017.indexOf("create table"), SQL_0017.indexOf("create index"));
    expect(body).not.toMatch(/\bcontent\b|\bmessage_text\b|\bbody\b/i);
    expect(body).toMatch(/user_message_id uuid/); // معرّف فقط لا نص
  });

  it("الحالة محصورة في القيم الثلاث", () => {
    expect(SQL_0017).toMatch(/check \(status in \('in_progress', 'completed', 'failed'\)\)/);
  });
});
