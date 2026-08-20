/**
 * إعادة التحقّق وقرار المراجعة (v0.9.5، المرحلة 2B).
 *
 * ── المبدأ الذي يحرسه هذا الملفّ ──
 *
 *   الحقول المخزَّنة في المرشّح أثرُ حكمٍ مضى، لا حكمٌ صالح.
 *
 * فالمرشّح **مرجعٌ لا نسخة**: بين مشاركته وأيّ قرارٍ عليه يستطيع صاحبه أن
 * يعدّل رسالته أو يحذفها أو يسحب إذنه. ومن يقرأ الصفَّ ويقرّر به يقرّر
 * على ماضٍ.
 *
 * والبصمة هي الشاهد: تُحسب من النصّ الحاليّ بالتطبيع والفاصل والخوارزمية
 * نفسها، فاختلافُها يقول إن هذا ليس ما وافق عليه صاحبه.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { TRAINING_CONSENT_POLICY_VERSION, readTrainingConsent } from "@/lib/training/consent";
import { computeContentFingerprint } from "@/lib/training/fingerprint";
import { redactForReview, screenPrivacy } from "@/lib/training/privacy";
import { revalidateTrainingCandidate } from "@/lib/training/revalidate";
import { decideTrainingCandidate } from "@/lib/training/decision";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const REVALIDATE_SRC = readSrc("lib/training/revalidate.ts");
const DECISION_SRC = readSrc("lib/training/decision.ts");
const REVIEW_ROUTE = readSrc("app/api/admin/training-candidates/[id]/review/route.ts");
const DECISION_ROUTE = readSrc("app/api/admin/training-candidates/[id]/decision/route.ts");
const MIGRATION = readSrc("supabase/migrations/0040_ysd_training_bank.sql");

const CAND = "eeeeeeee-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const CONV = "bbbbbbbb-0000-4000-8000-000000000001";
const UMSG = "cccccccc-0000-4000-8000-000000000001";
const AMSG = "cccccccc-0000-4000-8000-000000000002";

const GRANTED = "2026-08-20T00:00:00Z";
const AFTER = "2026-08-20T09:00:00Z";
const LATER = "2026-08-20T09:00:05Z";
const BEFORE = "2026-08-19T12:00:00Z";

const Q = "كيف أضبط مهلة الاتصال في هذا النظام بشكل صحيح؟";
const A = "تُضبط المهلة من إعدادات الخادم، ويُفضَّل أن تكون أقصر من مهلة العميل.";

const activeConsent = [
  { enabled: true, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: null },
];

interface Over {
  candidate?: Record<string, unknown>[] | null;
  consent?: Record<string, unknown>[];
  conversation?: Record<string, unknown>[];
  userText?: string;
  assistantText?: string;
  userDeleted?: boolean;
  assistantDeleted?: boolean;
  userMissing?: boolean;
  assistantMissing?: boolean;
  userRole?: string;
  assistantRole?: string;
  userCreated?: string | null;
  assistantCreated?: string | null;
  assistantMetadata?: unknown;
  storedFingerprint?: string;
  status?: string;
  updateRows?: Record<string, unknown>[];
  updateError?: { code: string } | null;
  candidateError?: boolean;
}

function memoryDb(over: Over = {}) {
  const updates: Record<string, unknown>[] = [];
  const filters: Record<string, unknown>[] = [];

  const userText = over.userText ?? Q;
  const assistantText = over.assistantText ?? A;
  const fingerprint = over.storedFingerprint ?? computeContentFingerprint(Q, A);

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const eqs: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          eqs[col] = val;
          return chain;
        },
        is: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => {
          if (table === "training_candidates") {
            if (over.candidateError) return Promise.resolve({ data: null, error: { code: "42501" } });
            if (over.candidate === null) return Promise.resolve({ data: [], error: null });
            return Promise.resolve({
              data: over.candidate ?? [
                {
                  id: CAND,
                  user_id: USER,
                  conversation_id: CONV,
                  user_message_id: UMSG,
                  assistant_message_id: AMSG,
                  source: "user_opt_in",
                  status: over.status ?? "pending",
                  privacy_status: "needs_review",
                  quality_status: "passed",
                  content_fingerprint: fingerprint,
                  created_at: LATER,
                  decided_at: null,
                },
              ],
              error: null,
            });
          }
          if (table === "training_consents") {
            return Promise.resolve({ data: over.consent ?? activeConsent, error: null });
          }
          if (table === "conversations") {
            return Promise.resolve({
              data: over.conversation ?? [{ id: CONV, user_id: USER, deleted_at: null }],
              error: null,
            });
          }
          if (table === "messages") {
            const rows: Record<string, unknown>[] = [];
            if (!over.userMissing) {
              rows.push({
                id: UMSG, conversation_id: CONV, role: over.userRole ?? "user",
                content: userText, created_at: over.userCreated === undefined ? AFTER : over.userCreated,
                deleted_at: over.userDeleted ? LATER : null, metadata: {},
              });
            }
            if (!over.assistantMissing) {
              rows.push({
                id: AMSG, conversation_id: CONV, role: over.assistantRole ?? "assistant",
                content: assistantText,
                created_at: over.assistantCreated === undefined ? LATER : over.assistantCreated,
                deleted_at: over.assistantDeleted ? LATER : null,
                metadata: over.assistantMetadata ?? {},
              });
            }
            return Promise.resolve({ data: rows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: Record<string, unknown> = {};
          const seen: Record<string, unknown> = {};
          Object.assign(u, {
            eq: (col: string, val: unknown) => {
              seen[col] = val;
              return u;
            },
            select: () => {
              filters.push({ ...seen });
              if (over.updateError) return Promise.resolve({ data: null, error: over.updateError });
              return Promise.resolve({
                data: over.updateRows ?? [{ id: CAND, status: String(row.status), decided_at: row.decided_at }],
                error: null,
              });
            },
          });
          return u;
        },
      });
      return chain;
    },
  };
  return { client, updates, filters };
}

const revalidate = (db: ReturnType<typeof memoryDb>, opts = {}) =>
  revalidateTrainingCandidate(CAND, opts, {
    getAdminClient: (() => db.client) as never,
    readConsent: readTrainingConsent,
  });

const decide = (
  db: ReturnType<typeof memoryDb>,
  decision: "approve" | "reject_privacy" | "reject_quality",
) =>
  decideTrainingCandidate(CAND, decision, {
    getAdminClient: (() => db.client) as never,
    readConsent: readTrainingConsent,
    revalidate: ((id: string, o = {}) =>
      revalidateTrainingCandidate(id, o, {
        getAdminClient: (() => db.client) as never,
        readConsent: readTrainingConsent,
      })) as never,
  });

/* ═══════════ (١) البصمة ═══════════ */

describe("★ (١) البصمة — الشاهد على أن النصّ هو النصّ", () => {
  it("★ ★ تطبيقٌ واحد لا نسختان", () => {
    /**
     * ولو نُسخت الدالّة في موضعين لَكان أوّل تعديلٍ على أحدهما — رفعُ حرفٍ
     * أو تغييرُ فاصل — يجعل كل عيّنةٍ قائمة تبدو **مُعدَّلة**، فتُرفض
     * عيّنات سليمة بلا سبب. فالنسخ هنا عطبٌ مؤجَّل لا تكرارٌ مزعج.
     */
    const candidate = stripComments(readSrc("lib/training/candidate.ts"));
    const reval = stripComments(REVALIDATE_SRC);
    for (const src of [candidate, reval]) {
      expect(src).toMatch(/computeContentFingerprint/);
      expect(src).not.toMatch(/createHash\(/);
      expect(src).not.toMatch(/function\s+normalizeForFingerprint/);
    }
  });

  it("★ ★ ونصٌّ غير مُعدَّل ⇒ البصمة نفسها", async () => {
    const db = memoryDb();
    const r = await revalidate(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approvable).toBe(true);
  });

  it("★ ★ وتعديلُ رسالة المستخدم ⇒ `source_changed`", async () => {
    /**
     * وهذا هو العيب الذي أثبتَته المرحلة 2A: التعديل يقع **في مكانه**،
     * فيبقى المرشّح مشيرًا إلى نصٍّ غير الذي وافق عليه صاحبه.
     */
    const db = memoryDb({ userText: `${Q} وما الحدّ الأقصى؟` });
    expect(await revalidate(db)).toEqual({ ok: false, reason: "source_changed" });
  });

  it("★ ★ وتعديلُ الردّ ⇒ `source_changed`", async () => {
    const db = memoryDb({ assistantText: `${A} وهذا تعديلٌ لاحق.` });
    expect(await revalidate(db)).toEqual({ ok: false, reason: "source_changed" });
  });

  it("★ ★ ولا تُحدَّث البصمة المخزَّنة لتوافق الجديد", async () => {
    /**
     * المرشّح يمثّل ما اختاره صاحبه **في لحظة اختياره**. ومن يُحدّث البصمة
     * يجعله يمثّل شيئًا لم يُعرض عليه — ويحوّل الحارس إلى ختمٍ يوقّع على
     * أيّ نصّ يجده.
     */
    const db = memoryDb({ userText: "نصٌّ آخر تمامًا لم يوافق عليه أحد إطلاقًا" });
    await revalidate(db);
    expect(db.updates).toHaveLength(0);
    /**
     * والثابت أوسع من البصمة: إعادةُ التحقّق **قراءةٌ محضة**. فلا
     * `update` ولا `insert` ولا `upsert` في الملفّ كلّه — وحارسٌ يقيس
     * غياب الكتابة يشمل ما لم أفكّر فيه، لا البصمة وحدها.
     */
    const reval = stripComments(REVALIDATE_SRC);
    expect(reval).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  });

  it("★ ★ ومسافةٌ زائدة ليست تعديلًا — التطبيع يمتصّها", async () => {
    const db = memoryDb({ userText: `  ${Q}  `, assistantText: `${A}\n` });
    expect((await revalidate(db)).ok).toBe(true);
  });
});

/* ═══════════ (٢) المصدر ═══════════ */

describe("★ (٢) المصدر — يُقرأ الآن لا يُفترض", () => {
  it("★ ★ رسالةٌ محذوفة ناعمًا ⇒ `source_deleted`", async () => {
    for (const over of [{ userDeleted: true }, { assistantDeleted: true }]) {
      expect(await revalidate(memoryDb(over))).toEqual({ ok: false, reason: "source_deleted" });
    }
  });

  it("★ ★ ورسالةٌ مفقودة ⇒ `source_deleted`", async () => {
    for (const over of [{ userMissing: true }, { assistantMissing: true }]) {
      expect(await revalidate(memoryDb(over))).toEqual({ ok: false, reason: "source_deleted" });
    }
  });

  it("★ ★ ومحادثةٌ محذوفة أو مفقودة ⇒ `source_deleted`", async () => {
    expect(await revalidate(memoryDb({ conversation: [{ id: CONV, user_id: USER, deleted_at: LATER }] })))
      .toEqual({ ok: false, reason: "source_deleted" });
    expect(await revalidate(memoryDb({ conversation: [] })))
      .toEqual({ ok: false, reason: "source_deleted" });
  });

  it("★ ★ ومالكٌ مختلف ⇒ `not_owner`", async () => {
    const db = memoryDb({ conversation: [{ id: CONV, user_id: OTHER, deleted_at: null }] });
    expect(await revalidate(db)).toEqual({ ok: false, reason: "not_owner" });
  });

  it("★ ★ ودورٌ تغيّر ⇒ `role_mismatch`", async () => {
    for (const over of [{ userRole: "assistant" }, { assistantRole: "user" }, { assistantRole: "system" }]) {
      expect(await revalidate(memoryDb(over))).toEqual({ ok: false, reason: "role_mismatch" });
    }
  });

  it("★ ومرشّحٌ غير موجود ⇒ `not_found`", async () => {
    expect(await revalidate(memoryDb({ candidate: null }))).toEqual({ ok: false, reason: "not_found" });
  });

  it("★ وعطلُ القاعدة عطلٌ صريح لا حكمٌ صامت", async () => {
    expect(await revalidate(memoryDb({ candidateError: true })))
      .toEqual({ ok: false, reason: "database_error" });
  });
});

/* ═══════════ (٣) الإذن ═══════════ */

describe("★ (٣) الإذن — يُعاد فحصه، وقبل قراءة النصّ", () => {
  it("★ ★ إذنٌ مطفأ أو ملغى أو لنسخةٍ قديمة ⇒ رفض", async () => {
    for (const consent of [
      [{ enabled: false, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: null }],
      [{ enabled: true, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: LATER }],
      [{ enabled: true, policy_version: "2020-01-01.v0", granted_at: GRANTED, revoked_at: null }],
      [{ enabled: true, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: null, revoked_at: null }],
      [],
    ]) {
      expect(await revalidate(memoryDb({ consent }))).toEqual({ ok: false, reason: "consent_inactive" });
    }
  });

  it("★ ★ والزوج الأقدم من `granted_at` ⇒ `before_consent`", async () => {
    /**
     * وهذه تقع فعلًا بلا تعديلِ رسالة: سحبُ الإذن ثم منحُه من جديد يُجدّد
     * `granted_at`. فما شورك تحت الإذن الأوّل صار سابقًا للإذن القائم —
     * وهو كذلك حقًّا: القرار الجديد قرارٌ جديد لا استئنافٌ لقديم.
     */
    for (const over of [{ userCreated: BEFORE }, { assistantCreated: BEFORE }]) {
      expect(await revalidate(memoryDb(over))).toEqual({ ok: false, reason: "before_consent" });
    }
  });

  it("★ ★ وطابعٌ غائب ⇒ رفض — لا «ربما»", async () => {
    for (const over of [{ userCreated: null }, { assistantCreated: null }]) {
      expect(await revalidate(memoryDb(over))).toEqual({ ok: false, reason: "before_consent" });
    }
  });

  it("★ ★ والإذن يسبق قراءة النصّ في الترتيب", () => {
    const src = stripComments(REVALIDATE_SRC);
    expect(src.indexOf("readConsent")).toBeLessThan(src.indexOf('.in("id"'));
  });
});

/* ═══════════ (٤) البوّابتان ═══════════ */

describe("★ (٤) الجودة والخصوصية — تُعادان على النصّ الحاليّ", () => {
  it("★ ★ ردٌّ صار فارغًا أو قصيرًا ⇒ لا اعتماد", async () => {
    const db = memoryDb({
      assistantText: "لا",
      storedFingerprint: computeContentFingerprint(Q, "لا"),
    });
    const r = await revalidate(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.approvable).toBe(false);
      expect(r.blockers).toContain("quality_rejected");
    }
  });

  it("★ ★ وردٌّ موسومٌ ناقصًا في `metadata` ⇒ لا اعتماد", async () => {
    const db = memoryDb({
      assistantMetadata: { completion: { status: "incomplete_provider", reason: "stream_interrupted" } },
    });
    const r = await revalidate(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blockers).toContain("quality_rejected");
  });

  it("★ ★ وبريدٌ ظهر في النصّ ⇒ مانعُ خصوصيةٍ حتميّ", async () => {
    const text = `${A} راسلني على someone@example.com`;
    const db = memoryDb({ assistantText: text, storedFingerprint: computeContentFingerprint(Q, text) });
    const r = await revalidate(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.approvable).toBe(false);
      expect(r.blockers).toContain("privacy_finding");
      expect(r.privacyCodes).toContain("email");
    }
  });

  it("★ ★ والحكم من الفحص لا من الحقل المخزَّن", async () => {
    /**
     * الصفّ يقول `quality_status: "passed"` — وهو أثرُ حكمٍ وقتَ الإدخال.
     * ولو قُرئ بدل إعادة الفحص لَمرّ ردٌّ صار فارغًا بعد التعديل.
     */
    const src = stripComments(REVALIDATE_SRC);
    expect(src).toMatch(/screenQuality\(\{/);
    expect(src).toMatch(/screenPrivacy\(/);
    expect(src).not.toMatch(/candidate\.quality_status\s*===/);
    expect(src).not.toMatch(/candidate\.privacy_status\s*===/);
  });
});

/* ═══════════ (٥) التنقيح ═══════════ */

describe("★ (٥) المعاينة — تُنقّح ما لا يُحكم عليه", () => {
  it("★ ★ المفتاح يُطمس، والبريد يبقى ظاهرًا", () => {
    /**
     * المراجِع يقرأ ليحكم؛ وإخفاءُ البريد يمنعه من رؤية **لماذا** تُرفض
     * العيّنة. أما المفتاح فليس موضع حكم: وجودُه وحده يرفض، وعرضُه كاملًا
     * يضعه على شاشةٍ ثانية بلا فائدة.
     */
    const secret = redactForReview("المفتاح sk-abcdefghijklmnopqrstuvwx وانتهى");
    expect(secret.redacted).toBe(true);
    expect(secret.text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(secret.text).toContain("[محجوب]");

    const email = redactForReview("راسلني على someone@example.com");
    expect(email.redacted).toBe(false);
    expect(email.text).toContain("someone@example.com");
  });

  it("★ ★ وبطاقةٌ واعتمادٌ في عنوان يُطمسان", () => {
    expect(redactForReview("الرقم 4111 1111 1111 1111").text).not.toContain("4111 1111 1111 1111");
    expect(redactForReview("https://user:pass@host/x").text).not.toContain("user:pass@");
  });

  it("★ ★ ومطابقاتٌ متعدّدة تُطمس كلّها", () => {
    /**
     * تعبيرٌ بلا `g` يستبدل الأولى وحدها. والوحدة تبني نسخةً عامّة لكل
     * استبدال بدل تعديل الأصل — فتعبيرٌ عامّ يحمل `lastIndex` يجعل `test`
     * يتخطّى مطابقاتٍ بين النداءات.
     */
    const out = redactForReview("sk-aaaaaaaaaaaaaaaaaaaa ثم sk-bbbbbbbbbbbbbbbbbbbb").text;
    expect(out).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toContain("sk-bbbbbbbbbbbbbbbbbbbb");
  });

  it("★ ★ والفحص نفسه لا يتأثّر بالتنقيح — يبقى حتميًّا عبر النداءات", () => {
    const text = "sk-aaaaaaaaaaaaaaaaaaaa و sk-bbbbbbbbbbbbbbbbbbbb";
    expect(screenPrivacy(text).status).toBe("rejected");
    expect(screenPrivacy(text).status).toBe("rejected");
    expect(screenPrivacy(text).reasonCodes).toEqual(screenPrivacy(text).reasonCodes);
  });
});

/* ═══════════ (٦) القرار ═══════════ */

describe("★ (٦) القرار — يُعاد الفحص داخله لا عند فتح الشاشة", () => {
  it("★ ★ اعتمادُ عيّنةٍ سليمة ⇒ الحقول الثلاثة من الخادم", async () => {
    const db = memoryDb();
    const r = await decide(db, "approve");
    expect(r.ok).toBe(true);
    expect(db.updates[0]).toMatchObject({
      status: "approved",
      privacy_status: "passed",
      quality_status: "passed",
    });
    expect(typeof db.updates[0]!.decided_at).toBe("string");
  });

  it("★ ★ ومصدرٌ تغيّر بين الفتح والضغط ⇒ لا اعتماد", async () => {
    /**
     * وهذه هي الحالة التي من أجلها يُعاد الفحص هنا: الشاشة أمام المراجِع
     * وصفُ لحظةٍ مضت، وبينها وبين ضغطته دقائق يملك فيها صاحب العيّنة أن
     * يعدّل رسالته.
     */
    const db = memoryDb({ userText: `${Q} إضافةٌ بعد الفتح` });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "source_changed" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ وإذنٌ سُحب بين الفتح والضغط ⇒ لا اعتماد", async () => {
    const db = memoryDb({
      consent: [{ enabled: false, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: LATER }],
    });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "consent_inactive" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ ومانعُ خصوصيةٍ حتميّ لا يُتجاوَز بيدٍ", async () => {
    /**
     * المراجعة اليدوية تُضيف حكمًا حيث لا يملك الفحص حكمًا، ولا تنقض حكمًا
     * يملكه. ولو جاز التجاوز لَصار الفحص اقتراحًا، ولَكفى ضغطُ زرٍّ في
     * يومٍ مزدحم لإدخال بريد إنسانٍ إلى بنك تدريب.
     */
    const text = `${A} بريدي someone@example.com`;
    const db = memoryDb({ assistantText: text, storedFingerprint: computeContentFingerprint(Q, text) });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "privacy_blocked" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ وجودةٌ ساقطة تمنع الاعتماد كذلك", async () => {
    const db = memoryDb({ assistantText: "لا", storedFingerprint: computeContentFingerprint(Q, "لا") });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "quality_blocked" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ ★ والرفض متاحٌ فوق المانع — فالمراجِع يرفض عن علم", async () => {
    const text = `${A} بريدي someone@example.com`;
    const db = memoryDb({ assistantText: text, storedFingerprint: computeContentFingerprint(Q, text) });
    const r = await decide(db, "reject_privacy");
    expect(r.ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ status: "rejected_privacy", privacy_status: "rejected" });
  });

  it("★ رفضُ الجودة يكتب حالته", async () => {
    const db = memoryDb();
    const r = await decide(db, "reject_quality");
    expect(r.ok).toBe(true);
    expect(db.updates[0]).toMatchObject({ status: "rejected_quality", quality_status: "rejected" });
  });
});

/* ═══════════ (٧) التزامن ═══════════ */

describe("★ (٧) قرارٌ واحد لا قراران", () => {
  it("★ ★ الكتابة مشروطةٌ بأن الحالة ما تزال `pending`", async () => {
    /**
     * وقراءةُ الحالة ثم الكتابة كانت ستترك بينهما نافذةً يفوز فيها اثنان.
     * والشرط جزءٌ من الكتابة نفسها — `compare-and-set` بلا معاملةٍ ولا قفل.
     */
    const db = memoryDb();
    await decide(db, "approve");
    expect(db.filters[0]).toEqual({ id: CAND, status: "pending" });
  });

  it("★ ★ وصفرُ صفوفٍ مُصابة ⇒ `conflict` بلا كتابةٍ ثانية", async () => {
    const db = memoryDb({ updateRows: [] });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "conflict" });
  });

  it("★ ★ ومرشّحٌ محسومٌ سلفًا يُردّ مبكرًا", async () => {
    const db = memoryDb({ status: "approved" });
    expect(await decide(db, "approve")).toEqual({ ok: false, reason: "already_decided" });
    expect(db.updates).toHaveLength(0);
  });

  it("★ والمراجعة وحدها تقرأ المحسوم بلا اعتراض", async () => {
    const db = memoryDb({ status: "rejected_privacy" });
    expect((await revalidate(db)).ok).toBe(true);
    expect((await revalidate(db, { requirePending: true })).ok).toBe(false);
  });
});

/* ═══════════ (٨) المسارات ═══════════ */

describe("★ (٨) المساران — للمشرف وحده، ولا يقبلان حقلًا", () => {
  it("★ ★ بلا جلسة ⇒ 401 · بلا صلاحية ⇒ 403", () => {
    for (const src of [REVIEW_ROUTE, DECISION_ROUTE]) {
      const s = stripComments(src);
      expect(s).toMatch(/getAdminContext/);
      expect(s).toMatch(/unauthorized\(\)/);
      expect(s).toMatch(/forbidden\(\)/);
    }
  });

  it("★ ★ والصلاحية تُفحص قبل شكل المعرّف", () => {
    const s = stripComments(REVIEW_ROUTE);
    expect(s.indexOf("getAdminContext")).toBeLessThan(s.indexOf("idSchema.safeParse"));
  });

  it("★ ★ والقرار كلمةٌ واحدة من ثلاث — لا حقول", () => {
    const s = stripComments(DECISION_ROUTE);
    expect(s).toMatch(/z\.enum\(\["approve", "reject_privacy", "reject_quality"\]\)/);
    /** والقياس على تعريف المخطَّط وحده — لا على ما جاوره من ثوابت العرض */
    const schema = s.slice(s.indexOf("const bodySchema"), s.indexOf("});", s.indexOf("const bodySchema")));
    for (const f of [
      "status", "privacy_status", "quality_status", "decided_at",
      "user_id", "content_fingerprint", "userText", "assistantText",
    ]) {
      expect(schema).not.toMatch(new RegExp(f));
    }
    /** ولا يُقرأ من الجسم إلا `decision` */
    expect(s).not.toMatch(/parsed\.data\.(?!decision)/);
  });

  it("★ ★ والمعاينة لا تُعيد بصمةً ولا هوّية", () => {
    const s = stripComments(REVIEW_ROUTE);
    const payload = s.slice(s.lastIndexOf("return json("));
    for (const leak of ["fingerprint", "user_id", "userId", "conversation", "message_id"]) {
      expect(payload).not.toMatch(new RegExp(leak, "i"));
    }
  });

  it("★ ★ وجواب القرار بلا محتوى", () => {
    const s = stripComments(DECISION_ROUTE);
    const payload = s.slice(s.lastIndexOf("return json({ ok: true"));
    for (const leak of ["userText", "assistantText", "content", "fingerprint"]) {
      expect(payload).not.toMatch(new RegExp(leak, "i"));
    }
  });

  it("★ ★ ولا تسجيل لمحتوى العيّنة", () => {
    for (const src of [REVALIDATE_SRC, DECISION_SRC, REVIEW_ROUTE, DECISION_ROUTE]) {
      const s = stripComments(src);
      for (const m of s.match(/console\.\w+\([^)]*\)/g) ?? []) {
        expect(m).not.toMatch(/content|userText|assistantText|fingerprint|preview/i);
      }
    }
  });

  it("★ ★ والتدقيق يسجّل الفعل والمعرّف — لا النصّ", () => {
    const s = stripComments(DECISION_ROUTE);
    expect(s).toMatch(/training_candidate_approved/);
    expect(s).toMatch(/training_candidate_rejected_privacy/);
    expect(s).toMatch(/training_candidate_rejected_quality/);
    const audit = s.slice(s.indexOf("await writeAudit"), s.indexOf("return json({ ok: true"));
    for (const leak of ["userText", "assistantText", "fingerprint", "content"]) {
      expect(audit).not.toMatch(new RegExp(leak, "i"));
    }
    // والمنقّي يُسقط كل حقلٍ اسمه يحمل `content` — ومنه `content_fingerprint`
    expect(readSrc("lib/admin/guard.ts")).toMatch(/FORBIDDEN_AUDIT_KEYS[\s\S]{0,120}content/);
  });

  it("★ ★ والتدقيق لا يغيّر القرار", () => {
    const s = stripComments(DECISION_ROUTE);
    expect(s.indexOf("await decideTrainingCandidate")).toBeLessThan(s.indexOf("await writeAudit"));
    expect(s).toMatch(/try \{[\s\S]{0,400}writeAudit[\s\S]{0,300}\} catch \{/);
  });
});

/* ═══════════ (٩) الحدود ═══════════ */

describe("★ (٩) الحدود — الاعتماد ليس تدريبًا", () => {
  it("★ ★ لا تصدير ولا مجموعة ولا أوزان في هذه الطبقة", () => {
    for (const src of [REVALIDATE_SRC, DECISION_SRC, REVIEW_ROUTE, DECISION_ROUTE,
                       readSrc("app/admin/training/page.tsx")]) {
      expect(src).not.toMatch(/jsonl|dataset|fine_?tune|LoRA|weights|train_job|gpu/i);
    }
  });

  it("★ ★ ولا نسخة ثانية من النصّ — المرشّح مرجعٌ وبصمة", () => {
    expect(stripComments(REVALIDATE_SRC)).not.toMatch(/raw_content|sample_text|snapshot/);
    expect(MIGRATION).not.toMatch(/raw_content|sample_text/);
  });

  it("★ ★ والقاعدة تحرس الاعتماد ولو سقط الحارس البرمجيّ", () => {
    /**
     * دفاعٌ بطبقتين: القيد يشترط بوّابتين مفتوحتين وقرارًا مؤرَّخًا. فحتى
     * لو مرّ سطرٌ خاطئ في التطبيق، لا يوجد صفٌّ معتمَدٌ ببوّابةٍ مغلقة.
     */
    expect(MIGRATION).toMatch(
      /status <> 'approved'[\s\S]{0,160}privacy_status = 'passed'[\s\S]{0,80}quality_status = 'passed'[\s\S]{0,60}decided_at is not null/,
    );
  });

  it("★ ★ ولا ترحيلة جديدة — 0040 و0041 تكفيان", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(41);
  });

  it("★ ★ ولا يُساء استعمال `revoked` — فهي سحبُ إذنٍ لا تغيّرُ مصدر", () => {
    /**
     * الحالات المتاحة مغلقة، و`revoked` معناها في هذا المشروع أن صاحبها
     * سحب إذنه. فمرشّحٌ تغيّر مصدرُه يبقى `pending` ولا يُعتمد — ولا
     * يُلبَس حالةً تقول عن صاحبه ما لم يفعله.
     */
    const s = stripComments(DECISION_SRC);
    expect(s).not.toMatch(/"revoked"/);
    expect(s).not.toMatch(/rejected_source|source_changed_status/);
  });

  it("★ ★ وهوّية صاحب العيّنة لا تغادر الخادم أصلًا", () => {
    /**
     * ── والضمان بنيويّ لا تجميليّ ──
     *
     * لا يكفي ألّا تعرض الواجهةُ `user_id`؛ ما دام في الحمولة يظلّ في
     * الشبكة وفي ذاكرة المتصفّح ومتاحًا لأوّل تعديلٍ يعرضه سهوًا. فلا
     * يُقرأ من القاعدة أصلًا: أعمدةُ القائمة مسمّاةٌ واحدًا واحدًا، وليس
     * `user_id` فيها.
     *
     * والمراجِع يحكم على نصٍّ لا على إنسان؛ ومعرفتُه بمن كتبه تُدخل في
     * الحكم ما ليس منه.
     */
    const page = stripComments(readSrc("app/admin/training/page.tsx"));
    const columns = page.match(/const LIST_COLUMNS =[\s\S]*?;/)?.[0] ?? "";
    expect(columns).toMatch(/created_at/);
    expect(columns).not.toMatch(/user_id|\*/);

    const view = stripComments(readSrc("components/admin/training-review-view.tsx"));
    const summary = view.slice(
      view.indexOf("export interface CandidateSummary"),
      view.indexOf("}", view.indexOf("export interface CandidateSummary")),
    );
    expect(summary).toMatch(/createdAt/);
    for (const f of ["userId", "user_id", "email", "conversationId", "fingerprint"]) {
      expect(summary).not.toMatch(new RegExp(f, "i"));
    }
  });

  it("★ ★ ومسار المحادثة لا يعرف شيئًا من هذا", () => {
    const chat = readSrc("app/api/chat/route.ts");
    expect(chat).not.toMatch(/revalidateTrainingCandidate|decideTrainingCandidate|lib\/training/);
  });
});

/* ═══════════ (١٠) عقد التصدير المستقبليّ ═══════════ */

describe("★ (١٠) الباب الواحد — عقدٌ لِمَا لم يُبنَ بعد", () => {
  it("★ ★ الحارس مُصدَّرٌ باسمٍ واحد يُستدعى من كل طريق", () => {
    expect(REVALIDATE_SRC).toMatch(/export async function revalidateTrainingCandidate/);
    for (const src of [DECISION_SRC, REVIEW_ROUTE]) {
      expect(stripComments(src)).toMatch(/revalidateTrainingCandidate|d\.revalidate\(/);
    }
  });

  it("★ ★ والعقد مكتوبٌ حيث يقرؤه من يبني المصدِّر", () => {
    /**
     * وهذا الاختبار نفسه جزءٌ من العقد: من يضيف مُصدِّرًا لا يستدعي الحارس
     * سيجد هنا نصًّا يقول له لماذا — لا مجرّد إخفاقٍ غامض.
     */
    expect(REVALIDATE_SRC).toMatch(/كل تصديرٍ مستقبليّ يمرّ من هنا/);
    expect(REVALIDATE_SRC).toMatch(/حتى المرشّح \*\*المعتمَد\*\*/);
  });

  it("★ ★ والمعتمَد يُعاد التحقّق منه كأيّ مرشّح — لا استثناء لحالته", async () => {
    /**
     * فالاعتماد حكمٌ في لحظة، والمصدر يتغيّر بعده كما يتغيّر قبله. وحارسٌ
     * يُستدعى عند الاعتماد ثم يُوثَق به عند التصدير يحرس اللحظة الخطأ.
     */
    const db = memoryDb({ status: "approved", userText: `${Q} تعديلٌ بعد الاعتماد` });
    expect(await revalidate(db)).toEqual({ ok: false, reason: "source_changed" });
    const src = stripComments(REVALIDATE_SRC);
    expect(src).not.toMatch(/status === "approved"[\s\S]{0,80}return \{ ok: true/);
  });

  it("★ ولا حالة `exported` — فالإبطال يبقى كاملًا", () => {
    expect(MIGRATION).not.toMatch(/'exported'/);
  });
});
