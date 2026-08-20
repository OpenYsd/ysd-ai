/**
 * بنك تدريب YSD، المرحلة الأولى (v0.9.4) — **أساسٌ خامل**.
 *
 * ── المبدأ الذي يحرسه هذا الملفّ ──
 *
 *   لا مسار من محادثةٍ إلى أوزان.
 *
 * وبينهما حاجزان: لا مرشّح بلا موافقة سارية، ولا اعتماد إلا بعد بوّابتين.
 * والفشل **مغلق**: غيابُ الموافقة يعني صفر إدخال — لا افتراض قبول، ولا
 * «ربما»، ولا مرورًا لأن القراءة تعثّرت.
 *
 * ── وما يجعل الوعد بالإلغاء صادقًا ──
 *
 * لا حالة `exported` في هذه المرحلة. فكل عيّنةٍ قابلة للإبطال بالبناء، لا
 * بالنية. ومن يَعِد بمحو أثرٍ من أوزانٍ دُرّبت يَعِد بما لا يملك — ونحن
 * لم نصل إليها بعد، وهذه هي اللحظة الوحيدة التي يكون الإلغاء فيها كاملًا.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  CONSENT_DENIED,
  TRAINING_CONSENT_POLICY_VERSION,
  isConsentActive,
  readTrainingConsent,
  setTrainingConsent,
} from "@/lib/training/consent";
import { screenPrivacy } from "@/lib/training/privacy";
import { screenQuality } from "@/lib/training/quality";
import { createTrainingCandidate, revokeUserCandidates } from "@/lib/training/candidate";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const MIGRATION = readSrc("supabase/migrations/0040_ysd_training_bank.sql");
const CANDIDATE_SRC = readSrc("lib/training/candidate.ts");
const CHAT_ROUTE = readSrc("app/api/chat/route.ts");
const CONSENT_ROUTE = readSrc("app/api/training-consent/route.ts");

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const CONV = "bbbbbbbb-0000-4000-8000-000000000001";
const UMSG = "cccccccc-0000-4000-8000-000000000001";
const AMSG = "cccccccc-0000-4000-8000-000000000002";

const LONG_USER = "كيف أضبط مهلة الاتصال في هذا النظام بشكل صحيح؟";
const LONG_ASSISTANT = "تُضبط المهلة من إعدادات الخادم، ويُفضَّل أن تكون أقصر من مهلة العميل.";

/** عميلٌ في الذاكرة يحاكي ما تستعمله الطبقة فعلًا */
function memoryDb(over: {
  consent?: Record<string, unknown>[] | null;
  conversation?: Record<string, unknown>[] | null;
  messages?: Record<string, unknown>[] | null;
  insertError?: { code: string } | null;
  consentError?: boolean;
} = {}) {
  const calls = { inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => {
          if (table === "training_consents") {
            return Promise.resolve(
              over.consentError
                ? { data: null, error: { code: "42501" } }
                : { data: over.consent ?? [], error: null },
            );
          }
          if (table === "conversations") {
            return Promise.resolve({ data: over.conversation ?? [], error: null });
          }
          if (table === "messages") {
            return Promise.resolve({ data: over.messages ?? [], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert: (row: Record<string, unknown>) => {
          calls.inserts.push(row);
          return {
            select: () => ({
              limit: () =>
                Promise.resolve(
                  over.insertError
                    ? { data: null, error: over.insertError }
                    : { data: [{ id: "dddddddd-0000-4000-8000-000000000001" }], error: null },
                ),
            }),
          };
        },
        update: (row: Record<string, unknown>) => {
          calls.updates.push(row);
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            in: () => u,
            select: () => Promise.resolve({ data: [{ id: "x" }, { id: "y" }], error: null }),
          });
          return u;
        },
        upsert: () => Promise.resolve({ error: null }),
      });
      return self();
    },
  };
  return { client, calls };
}

const activeConsent = [
  {
    enabled: true,
    policy_version: TRAINING_CONSENT_POLICY_VERSION,
    granted_at: "2026-08-20T00:00:00Z",
    revoked_at: null,
  },
];

const goodSources = {
  conversation: [{ id: CONV, user_id: USER, deleted_at: null }],
  messages: [
    { id: UMSG, conversation_id: CONV, role: "user", content: LONG_USER, deleted_at: null },
    { id: AMSG, conversation_id: CONV, role: "assistant", content: LONG_ASSISTANT, deleted_at: null },
  ],
};

const input = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  conversationId: CONV,
  userMessageId: UMSG,
  assistantMessageId: AMSG,
  ...over,
});

const run = (db: ReturnType<typeof memoryDb>, over: Record<string, unknown> = {}) =>
  createTrainingCandidate(input(over), {
    getAdminClient: (() => db.client) as never,
    readConsent: readTrainingConsent,
  });

/* ═══════════ (١) الموافقة ═══════════ */

describe("★ (١) الموافقة — صريحة وإلا فلا", () => {
  it("★ ★ الافتراض «لا»: لا صفّ ⇒ لا موافقة", async () => {
    const db = memoryDb({ consent: [] });
    expect(await readTrainingConsent(db.client as never, USER)).toEqual(CONSENT_DENIED);
    expect(isConsentActive(CONSENT_DENIED)).toBe(false);
  });

  it("★ ★ وتعذّرُ القراءة يُقرأ «لا» لا «ربما»", async () => {
    const db = memoryDb({ consentError: true });
    expect(await readTrainingConsent(db.client as never, USER)).toEqual(CONSENT_DENIED);
  });

  it("★ وصفّان لمستخدمٍ واحد ⇒ «لا» — سجلٌّ لا نفهمه", async () => {
    const db = memoryDb({ consent: [...activeConsent, ...activeConsent] });
    expect((await readTrainingConsent(db.client as never, USER)).enabled).toBe(false);
  });

  it("★ ★ و`enabled` وحده لا يكفي", () => {
    const cases = [
      { label: "ملغاة", s: { enabled: true, policyVersion: TRAINING_CONSENT_POLICY_VERSION, grantedAt: "t", revokedAt: "t" } },
      { label: "بلا منح", s: { enabled: true, policyVersion: TRAINING_CONSENT_POLICY_VERSION, grantedAt: null, revokedAt: null } },
      { label: "نسخة نصٍّ قديمة", s: { enabled: true, policyVersion: "2020-01-01.v0", grantedAt: "t", revokedAt: null } },
      { label: "مطفأة", s: { enabled: false, policyVersion: TRAINING_CONSENT_POLICY_VERSION, grantedAt: "t", revokedAt: null } },
    ];
    for (const { label, s } of cases) expect(isConsentActive(s), label).toBe(false);

    expect(
      isConsentActive({
        enabled: true,
        policyVersion: TRAINING_CONSENT_POLICY_VERSION,
        grantedAt: "t",
        revokedAt: null,
      }),
    ).toBe(true);
  });

  it("★ والسحب يُبقي الأثر — لا يمحو الصفّ", async () => {
    const db = memoryDb();
    const res = await setTrainingConsent(db.client as never, USER, false);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.enabled).toBe(false);
      expect(res.state.revokedAt).not.toBeNull();
      expect(isConsentActive(res.state)).toBe(false);
    }
    // ولا حذف في الشيفرة إطلاقًا
    expect(stripComments(readSrc("lib/training/consent.ts"))).not.toContain(".delete(");
  });
});

/* ═══════════ (٢) لا إدخال بلا موافقة ═══════════ */

describe("★ (٢) البوّابة الأولى", () => {
  it("★ ★ بلا موافقة ⇒ صفر قراءةٍ لكلام أحد وصفر كتابة", async () => {
    /**
     * والترتيب مقصود: ما بعد الموافقة **يقرأ كلام إنسان**. فمن لم يأذن لا
     * يُقرأ كلامه لغرضٍ لم يأذن به، ولو كان القارئ سطرَ شيفرةٍ يحسب بصمة.
     */
    const db = memoryDb({ consent: [], ...goodSources });
    const res = await run(db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("consent_missing");
    expect(db.calls.inserts).toHaveLength(0);
  });

  it("★ وموافقةٌ ملغاة أو لنسخةٍ قديمة ⇒ رفض", async () => {
    for (const consent of [
      [{ ...activeConsent[0], revoked_at: "2026-08-20T01:00:00Z" }],
      [{ ...activeConsent[0], policy_version: "2020-01-01.v0" }],
      [{ ...activeConsent[0], enabled: false }],
    ]) {
      const db = memoryDb({ consent, ...goodSources });
      const res = await run(db);
      expect(res.ok).toBe(false);
      expect(db.calls.inserts).toHaveLength(0);
    }
  });
});

/* ═══════════ (٣) الملكية والحياة ═══════════ */

describe("★ (٣) المصدر: مملوكٌ وحيّ", () => {
  it("★ ★ محادثةُ شخصٍ آخر ⇒ رفض", async () => {
    const db = memoryDb({
      consent: activeConsent,
      conversation: [{ id: CONV, user_id: OTHER, deleted_at: null }],
      messages: goodSources.messages,
    });
    const res = await run(db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_owner");
    expect(db.calls.inserts).toHaveLength(0);
  });

  it("★ ★ ورسالةٌ من محادثةٍ أخرى ⇒ رفض", async () => {
    const db = memoryDb({
      consent: activeConsent,
      conversation: goodSources.conversation,
      messages: [
        goodSources.messages[0]!,
        { ...goodSources.messages[1]!, conversation_id: "eeeeeeee-0000-4000-8000-000000000009" },
      ],
    });
    const res = await run(db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_owner");
  });

  it("★ ومحادثةٌ محذوفة أو رسالةٌ محذوفة ⇒ رفض", async () => {
    const deletedConv = memoryDb({
      consent: activeConsent,
      conversation: [{ id: CONV, user_id: USER, deleted_at: "2026-08-19T00:00:00Z" }],
      messages: goodSources.messages,
    });
    let res = await run(deletedConv);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("source_deleted");

    const deletedMsg = memoryDb({
      consent: activeConsent,
      conversation: goodSources.conversation,
      messages: [
        { ...goodSources.messages[0]!, deleted_at: "2026-08-19T00:00:00Z" },
        goodSources.messages[1]!,
      ],
    });
    res = await run(deletedMsg);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("source_deleted");
  });

  it("★ ورسالةٌ مفقودة ⇒ رفض", async () => {
    const db = memoryDb({ consent: activeConsent, conversation: goodSources.conversation, messages: [] });
    const res = await run(db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("source_not_found");
  });
});

/* ═══════════ (٤) الجودة ═══════════ */

describe("★ (٤) الجودة — حتميّة لا حَكَم", () => {
  const base = {
    userText: LONG_USER,
    assistantText: LONG_ASSISTANT,
    userRole: "user",
    assistantRole: "assistant",
  };

  it("★ زوجٌ سليم يمرّ", () => {
    expect(screenQuality(base).status).toBe("passed");
  });

  it("★ ★ وردٌّ فارغ أو قصير أو مقطوع أو ملغى أو معطوب ⇒ رفض", () => {
    const cases: Array<[string, Parameters<typeof screenQuality>[0]]> = [
      ["فارغ", { ...base, assistantText: "" }],
      ["مسافات", { ...base, assistantText: "   " }],
      ["قصير", { ...base, assistantText: "نعم" }],
      ["سؤال فارغ", { ...base, userText: "" }],
      ["عطل مزوّد", { ...base, errorCode: "provider_unavailable" }],
      ["ناقص", { ...base, completion: "incomplete_provider" }],
      ["ملغى", { ...base, clientAborted: true }],
      ["دورٌ مقلوب", { ...base, userRole: "assistant", assistantRole: "user" }],
    ];
    for (const [label, q] of cases) {
      const v = screenQuality(q);
      expect(v.status, label).toBe("rejected");
      expect(v.reasonCodes.length, label).toBeGreaterThan(0);
    }
  });

  it("★ ★ والإبهام المرفوع ليس حكم جودة", () => {
    /**
     * يقول إن القارئ رضي، لا إن الجواب صحيح. فهو **مصدر** لا بوّابة.
     */
    expect(MIGRATION).toContain("'thumbs_up'");
    const code = stripComments(readSrc("lib/training/quality.ts"));
    expect(code).not.toContain("thumbs");
  });
});

/* ═══════════ (٥) الخصوصية ═══════════ */

describe("★ (٥) الخصوصية — تعرف حدّها", () => {
  it("★ ★ ما يُكشف يقينًا يُرفض", () => {
    const cases: Array<[string, string, string]> = [
      ["بريد", "تواصل معي على ahmed.test@example.com من فضلك", "email"],
      ["هاتف", "رقمي هو +966 50 123 4567 اتصل بي", "phone"],
      ["IPv4", "الخادم على 192.168.10.44 وليس غيره", "ip_address"],
      ["بطاقة", "البطاقة 4111 1111 1111 1111 منتهية", "credit_card"],
      ["مفتاح", "استخدم sk-or-abcdefghijklmnop لهذا", "secret_token"],
      ["JWT", "الرمز eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc", "secret_token"],
      ["Bearer", "أرسل Authorization: Bearer abcdefghijklmnopqrs", "secret_token"],
      ["عنوانٌ بسرّ", "افتح https://x.example/cb?access_token=abcdefghijklmnop الآن", "url_with_credentials"],
      ["اعتمادٌ في المضيف", "الرابط https://user:pass1234@host.example/path هنا", "url_with_credentials"],
    ];
    for (const [label, text, code] of cases) {
      const v = screenPrivacy(text);
      expect(v.status, label).toBe("rejected");
      expect(v.reasonCodes, label).toContain(code);
    }
  });

  it("★ ★ ونصٌّ نظيف ⇒ `needs_review` لا `passed`", () => {
    /**
     * ★ الحدّ الذي تعترف به هذه المرحلة.
     *
     * الفحص حتميّ: يكشف البريد والهاتف والمفتاح. ولا يكشف الأسماء ولا
     * العناوين ولا السياق الذي يدلّ على صاحبه بلا أن يسمّيه. فمنحُ
     * `passed` هنا ادّعاءُ كشفٍ لم يقع — و`needs_review` تقول الحقيقة:
     * لم نرفض ولم نطمئن.
     */
    const v = screenPrivacy("ما الفرق بين المؤشّر والمرجع في هذه اللغة؟ أريد شرحًا مبسّطًا.");
    expect(v.status).toBe("needs_review");
    expect(v.reasonCodes).toEqual([]);

    // ولا يمنح الفحص الحتميّ `passed` في أي مسار
    expect(stripComments(readSrc("lib/training/privacy.ts"))).not.toContain('status: "passed"');
  });

  it("★ وأقصر من أن يُحكم عليه ⇒ رفض", () => {
    expect(screenPrivacy("مرحبًا").status).toBe("rejected");
    expect(screenPrivacy("").reasonCodes).toContain("too_short_to_judge");
  });

  it("★ ولا يُعاد نصُّ العيّنة في الحكم", () => {
    const secret = "ahmed.private@example.com";
    const v = screenPrivacy(`راسلني على ${secret} اليوم`);
    expect(JSON.stringify(v)).not.toContain(secret);
    expect(JSON.stringify(v)).not.toContain("ahmed");
  });
});

/* ═══════════ (٦) التكرار ═══════════ */

describe("★ (٦) لا تكرار — والحارس في القاعدة", () => {
  it("★ ★ انتهاك الفرادة يُميَّز عن العطل", async () => {
    const db = memoryDb({ consent: activeConsent, ...goodSources, insertError: { code: "23505" } });
    const res = await run(db);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("duplicate");
  });

  it("★ ★ والفهرس الفريد موجود — فالتزامن محروس في القاعدة لا في الكود", () => {
    /**
     * فحصٌ ثم إدراج في التطبيق يسمح لطلبين متزامنين بالمرور معًا. والفهرس
     * يجعل الثاني يفشل بـ23505 مهما كان التوقيت.
     */
    expect(MIGRATION).toContain("create unique index if not exists training_candidates_fingerprint_unique");
    expect(MIGRATION).toContain("on public.training_candidates (content_fingerprint)");
  });

  it("★ والبصمة تُحسب ولا يُخزَّن أصلها", async () => {
    const db = memoryDb({ consent: activeConsent, ...goodSources });
    const res = await run(db);
    expect(res.ok).toBe(true);
    const row = db.calls.inserts[0]!;
    expect(String(row.content_fingerprint)).toMatch(/^[a-f0-9]{64}$/);
    // ولا نصّ في الصفّ المكتوب
    const written = JSON.stringify(row);
    expect(written).not.toContain(LONG_USER);
    expect(written).not.toContain(LONG_ASSISTANT);
  });
});

/* ═══════════ (٧) المسار الكامل والإبطال ═══════════ */

describe("★ (٧) المرشّح والإبطال", () => {
  it("★ زوجٌ سليم بموافقةٍ سارية ⇒ مرشّحٌ معلّق", async () => {
    const db = memoryDb({ consent: activeConsent, ...goodSources });
    const res = await run(db);
    expect(res.ok).toBe(true);
    const row = db.calls.inserts[0]!;
    expect(row.status).toBe("pending");
    expect(row.privacy_status).toBe("needs_review");
    expect(row.quality_status).toBe("passed");
    expect(row.user_id).toBe(USER);
  });

  it("★ ★ ولا انتقال مباشر إلى تدريبٍ أو تصدير", () => {
    /**
     * لا حالة `exported` أصلًا في المخطّط — فكل عيّنةٍ قابلة للإبطال
     * بالبناء لا بالنية.
     */
    expect(MIGRATION).not.toContain("'exported'");
    expect(MIGRATION).not.toContain("'training'");
    const code = stripComments(CANDIDATE_SRC);
    expect(code).not.toContain('status: "approved"');
    expect(code).toContain('status: "pending"');
  });

  it("★ ★ والاعتماد يشترط بوّابتين وقرارًا مؤرَّخًا", () => {
    expect(MIGRATION).toContain("status <> 'approved'");
    expect(MIGRATION).toContain("privacy_status = 'passed' and quality_status = 'passed'");
    expect(MIGRATION).toContain("decided_at is not null");
  });

  it("★ ★ والإبطال يطال المعلّق والمعتمد", async () => {
    const db = memoryDb();
    const res = await revokeUserCandidates(USER, { getAdminClient: (() => db.client) as never });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.revoked).toBe(2);
    const patch = db.calls.updates[0]!;
    expect(patch.status).toBe("revoked");
    expect(patch.revoked_at).toBeTruthy();
  });
});

/* ═══════════ (٨) الأمن والخمول ═══════════ */

describe("★ (٨) الحدود", () => {
  it("★ ★ لا سياسة كتابةٍ للمرشّحين — الفشل مغلق", () => {
    expect(MIGRATION).toContain("alter table public.training_candidates enable row level security");
    expect(MIGRATION).toContain("revoke all on public.training_candidates from anon, authenticated");
    // القراءة للمشرف وحده، ولا `insert/update/delete` لأي دور عميل
    expect(MIGRATION).toContain('create policy "training_candidates_admin_read"');
    for (const forbidden of [
      "training_candidates_insert",
      "training_candidates_update",
      "training_candidates_delete",
      "for insert with check (user_id = auth.uid())\n  on public.training_candidates",
    ]) {
      expect(MIGRATION, forbidden).not.toContain(forbidden);
    }
  });

  it("★ والموافقة يملكها صاحبها وحده", () => {
    expect(MIGRATION).toContain('create policy "training_consents_select_own"');
    expect(MIGRATION).toContain("user_id = auth.uid()");
    expect(MIGRATION).toContain("grant select, insert, update on public.training_consents to authenticated");
    // ولا `delete` — الإلغاء يُبقي الأثر
    expect(MIGRATION).not.toContain("grant delete on public.training_consents");
  });

  it("★ ★ والملكية محروسة بمرجعٍ مركّب لا بثقة", () => {
    /**
     * `messages` بلا `user_id`: ملكيتها عبر محادثتها. فبلا هذين المرجعين
     * يستحيل على القاعدة أن تمنع زوجًا يجمع رسالة شخصٍ بردٍّ من محادثة آخر.
     */
    expect(MIGRATION).toContain("foreign key (conversation_id, user_id)");
    expect(MIGRATION).toContain("references public.conversations (id, user_id)");
    expect(MIGRATION).toContain("foreign key (user_message_id, conversation_id)");
    expect(MIGRATION).toContain("foreign key (assistant_message_id, conversation_id)");
    expect(MIGRATION).toContain("references public.messages (id, conversation_id)");
  });

  it("★ ★ والعميل لا يملك حقول الخادم", () => {
    const code = stripComments(CONSENT_ROUTE);
    expect(code).toContain("z.object({ enabled: z.boolean() })");
    /**
     * الهوية من الجلسة (`ctx.userId`) هي الاستعمال الصحيح — والممنوع أن
     * تأتي من الجسم. فيُقاس ما يُقرأ من الطلب لا الكلمة أينما وردت.
     */
    for (const forbidden of [
      "parsed.data.userId",
      "body.userId",
      "approved",
      "quality_score",
      "quality_status",
      "privacy_status",
      "content_fingerprint",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("ctx.userId");
    // والمخطّط حقلٌ واحد لا غير — فلا يمرّ شيءٌ آخر أصلًا
    expect(code).not.toMatch(/z\.object\(\{[^}]*userId/);
  });

  it("★ ★ والبنك خاملٌ — لا يمسّ مسار المحادثة", () => {
    /**
     * مستخدمٌ يرسل رسالة لا ينتظر بنك تدريب: كل عملٍ يُضاف إلى مساره
     * الساخن يدفع ثمنه هو.
     */
    for (const forbidden of [
      "lib/training",
      "createTrainingCandidate",
      "training_candidates",
      "training_consents",
      "screenPrivacy",
      "screenQuality",
    ]) {
      expect(CHAT_ROUTE, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ولا نصَّ ولا سجلَّ في طبقات البنك", () => {
    for (const f of ["lib/training/candidate.ts", "lib/training/consent.ts", "lib/training/privacy.ts", "lib/training/quality.ts"]) {
      expect(stripComments(readSrc(f)), f).not.toContain("console.");
    }
  });

  it("★ والترحيلة لا تُدخل صفًّا ولا تملأ رجعيًّا", () => {
    const sql = MIGRATION.toLowerCase();
    expect(sql).not.toContain("insert into public.training_candidates");
    expect(sql).not.toContain("insert into public.training_consents");
    expect(sql).not.toContain("drop table");
    expect(sql).not.toContain("drop column");
  });

  it("★ وهي التالية في الترقيم", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(files).toContain("0040_ysd_training_bank.sql");
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(40);
    // ولا تكرار ولا فجوة في الترقيم
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let n = 1; n <= 40; n++) expect(numbers, String(n)).toContain(n);
  });
});

/* ═══════════ (٩) YSD لم يتغيّر ═══════════ */

describe("★ (٩) خدمة YSD كما هي", () => {
  it("★ المفتاح والاحتياط وysd/free", async () => {
    const env = readSrc(".env.example");
    expect(env).toContain("YSD_MODEL_ALPHA_ENABLED=0");
    const { YSDProvider } = await import("@/lib/ai/ysd");
    const p = new YSDProvider();
    expect(p.fallbackPolicy).toBe("none");
    expect(p.fallbackEligible).toBe(false);
    const { OpenRouterProvider } = await import("@/lib/ai/openrouter");
    expect(new OpenRouterProvider().listModels().some((m) => m.id === "ysd/free")).toBe(true);
  });

  it("★ ولا تمسّ هذه الرقعة ترحيلات YSD", () => {
    expect(readSrc("supabase/migrations/0039_ysd_release_staging.sql")).toContain("ysd_stage_release");
    expect(readSrc("supabase/migrations/0036_ysd_model_registry.sql")).toContain("ai_model_deployments");
  });
});
