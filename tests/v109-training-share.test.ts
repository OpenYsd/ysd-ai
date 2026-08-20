/**
 * مشاركة محادثةٍ صراحةً مع بنك تحسين YSD (v0.9.5، المرحلة 2A).
 *
 * ── المبدأ الذي يحرسه هذا الملفّ ──
 *
 *   الإذن ليس مشاركة، ولا عيّنة بأثر رجعيّ.
 *
 * فتشغيلُ الخيار في الإعدادات لا يُدخل شيئًا. ولا يدخل شيء إلا بفعلٍ ثانٍ
 * يقصده صاحبه في محادثةٍ بعينها. وحتى حينئذٍ: ما قيل قبل الإذن يبقى خارجه،
 * لأن المستخدم يملك أن يأذن لما هو آتٍ ولا يملك أن يُنشئ إذنًا في الماضي.
 *
 * ── والاقتران يسكت عند الالتباس ──
 *
 * لا يُقرن سؤالٌ بسؤال، ولا يُخمَّن قرين. وما لا يُعرف يقينًا يُترك.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import { TRAINING_CONSENT_POLICY_VERSION, readTrainingConsent } from "@/lib/training/consent";
import { createTrainingCandidate } from "@/lib/training/candidate";
import { buildEligiblePairs, shareConversationForTraining } from "@/lib/training/share";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

/** الست حروف التي تُكتب في المصدر: \u0000 — مبنيّةٌ بلا شرطةٍ حرفية
 *  كي لا يتسلّل بايتٌ صفريّ إلى ملفّ الاختبار نفسه. */
const ESCAPED_NUL = String.fromCharCode(92) + "u0000";

const SHARE_SRC = readSrc("lib/training/share.ts");
const ROUTE_SRC = readSrc("app/api/conversations/[id]/training-share/route.ts");
const CHAT_ROUTE = readSrc("app/api/chat/route.ts");

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const CONV = "bbbbbbbb-0000-4000-8000-000000000001";

const GRANTED = "2026-08-20T00:00:00Z";
const BEFORE = "2026-08-19T12:00:00Z";
const AFTER = "2026-08-20T09:00:00Z";
const LATER = "2026-08-20T10:00:00Z";

/**
 * ★ معرّفاتٌ ترتيبها الأبجديّ هو ترتيب المحادثة.
 *
 * لأن الترتيب في الإنتاج `created_at` ثم `id`، والفاصل الثاني يحسم عند
 * التساوي. ولو جُعلت المعرّفات هنا اعتباطية لَقاس المثالُ ترتيبًا يخالف
 * ما تراه القاعدة، ومرّ أو سقط لسببٍ لا علاقة له بالمُختبَر.
 */

const Q = "كيف أضبط مهلة الاتصال في هذا النظام بشكل صحيح؟";
const A = "تُضبط المهلة من إعدادات الخادم، ويُفضَّل أن تكون أقصر من مهلة العميل.";

interface Msg {
  id: string;
  conversation_id?: string;
  role: string;
  content?: string;
  created_at: string | null;
  deleted_at?: string | null;
  metadata?: unknown;
}

const msg = (id: string, role: string, created_at: string | null, over: Partial<Msg> = {}): Msg => ({
  id,
  conversation_id: CONV,
  role,
  content: role === "user" ? Q : A,
  created_at,
  deleted_at: null,
  metadata: {},
  ...over,
});

const activeConsentRow = [
  {
    enabled: true,
    policy_version: TRAINING_CONSENT_POLICY_VERSION,
    granted_at: GRANTED,
    revoked_at: null,
  },
];

/**
 * عميلٌ في الذاكرة يخدم **المسارين**: قراءة المشاركة للهيكل، وقراءة الخدمة
 * للنصّ. ويفرّق بينهما بما تفعله السلسلة فعلًا — `in` مقابل `order`.
 */
function memoryDb(over: {
  consent?: Record<string, unknown>[];
  ownedConversation?: boolean;
  messages?: Msg[];
  insertErrors?: (({ code: string } | null))[];
  messagesError?: boolean;
} = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const selects: string[] = [];
  let insertCall = 0;

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let usedIn = false;
      let inIds: string[] = [];
      Object.assign(chain, {
        select: (cols?: string) => {
          if (typeof cols === "string") selects.push(`${table}:${cols}`);
          return chain;
        },
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        in: (_c: string, ids: string[]) => {
          usedIn = true;
          inIds = ids;
          return chain;
        },
        limit: () => {
          if (table === "training_consents") {
            return Promise.resolve({ data: over.consent ?? activeConsentRow, error: null });
          }
          if (table === "conversations") {
            const owned = over.ownedConversation !== false;
            return Promise.resolve({
              data: owned ? [{ id: CONV, user_id: USER, deleted_at: null }] : [],
              error: null,
            });
          }
          if (table === "messages") {
            if (over.messagesError) return Promise.resolve({ data: null, error: { code: "42501" } });
            const all = over.messages ?? [];
            // قراءة الخدمة: رسالتان بالمعرّف · قراءة المشاركة: الكل، الأحدث أولًا
            if (usedIn) {
              return Promise.resolve({ data: all.filter((m) => inIds.includes(m.id)), error: null });
            }
            const live = all.filter((m) => (m.deleted_at ?? null) === null);
            const sorted = [...live].sort((x, y) => {
              const c = String(y.created_at ?? "").localeCompare(String(x.created_at ?? ""));
              return c !== 0 ? c : y.id.localeCompare(x.id);
            });
            return Promise.resolve({ data: sorted, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          const err = over.insertErrors?.[insertCall] ?? null;
          insertCall += 1;
          return {
            select: () => ({
              limit: () =>
                Promise.resolve(
                  err
                    ? { data: null, error: err }
                    : { data: [{ id: `dddddddd-0000-4000-8000-00000000000${inserts.length}` }], error: null },
                ),
            }),
          };
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            in: () => u,
            select: () => Promise.resolve({ data: [], error: null }),
          });
          return u;
        },
      });
      return chain;
    },
  };
  return { client, inserts, updates, selects };
}

/**
 * مشاركةٌ حقيقية من طرفٍ إلى طرف: الخدمة الفعلية فوق قاعدةٍ في الذاكرة.
 *
 * والخدمة تُحقن بالقاعدة نفسها — فهي تطلب عميلها بنفسها، ولو تُركت لطلبت
 * عميل الإنتاج. وذلك يجعل المثال يقيس شيئًا آخر.
 */
const candidateOn = (db: ReturnType<typeof memoryDb>) =>
  ((input: Parameters<typeof createTrainingCandidate>[0]) =>
    createTrainingCandidate(input, {
      getAdminClient: (() => db.client) as never,
      readConsent: readTrainingConsent,
    })) as typeof createTrainingCandidate;

const share = (db: ReturnType<typeof memoryDb>, userId = USER, convId = CONV) =>
  shareConversationForTraining(userId, convId, {
    getAdminClient: (() => db.client) as never,
    readConsent: readTrainingConsent,
    createCandidate: candidateOn(db),
  });

/* ═══════════ (١) الاقتران ═══════════ */

describe("★ (١) الاقتران — حتميّ، ويسكت عند الالتباس", () => {
  it("★ زوجٌ بسيط يُقرن", () => {
    const pairs = buildEligiblePairs([msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userMessageId).toBe("m2u");
    expect(pairs[0]!.assistantMessageId).toBe("m3a");
  });

  it("★ ★ ومستخدمان متتاليان لا يُقرنان — وهذه حالةٌ تقع فعلًا", () => {
    /**
     * إيقافُ التوليد يحفظ رسالة المستخدم ولا يحفظ ردًّا إطلاقًا
     * (`assistant_saved=false`)، ثم يكتب صاحبها رسالةً أخرى. فمن يقرأ
     * «كل رسالتين متتاليتين زوج» يُلصق سؤالًا بسؤال ويعلّمه للنموذج.
     */
    const pairs = buildEligiblePairs([
      msg("m2u", "user", AFTER),
      msg("m4u", "user", LATER),
      msg("m5a", "assistant", LATER),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.userMessageId).toBe("m4u");
  });

  it("★ ★ وردٌّ بلا سابقٍ مستخدم يُترك، لا يُقرن بردّ", () => {
    // قد تبدأ الشريحة المقصوصة بردّ، وقد يقع ردّان لسببٍ لم نتوقّعه
    expect(buildEligiblePairs([msg("m1a", "assistant", AFTER)])).toHaveLength(0);
    const two = buildEligiblePairs([
      msg("m2u", "user", AFTER),
      msg("m3a", "assistant", AFTER),
      msg("m5a", "assistant", LATER),
    ]);
    expect(two).toHaveLength(1);
    expect(two[0]!.assistantMessageId).toBe("m3a");
  });

  it("★ ودورٌ ثالث لا يصنع زوجًا", () => {
    expect(
      buildEligiblePairs([msg("m2s", "system", AFTER), msg("m3a", "assistant", LATER)]),
    ).toHaveLength(0);
  });

  it("★ ★ والترتيب كلّيّ — `created_at` ثم `id`", () => {
    /**
     * طابعان متساويان يجعلان الترتيب رأيًا لا حقيقة. والفاصل الثابت يجعله
     * واحدًا في كل قراءة — وهو ما يقرأه `share.ts` من القاعدة بترتيبين لا
     * بواحد.
     */
    expect(stripComments(SHARE_SRC)).toMatch(
      /\.order\("created_at",[\s\S]{0,40}\.order\("id",/,
    );
    const pairs = buildEligiblePairs([
      msg("m2u", "user", AFTER),
      msg("m3a", "assistant", AFTER),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it("★ ★ ولا تخمين: كل زوجٍ مبنيّ على جوارٍ مباشر", () => {
    const src = stripComments(SHARE_SRC);
    expect(src).toMatch(/ordered\[i - 1\]/);
    expect(src).toMatch(/current\.role !== "assistant"/);
    expect(src).toMatch(/previous\.role !== "user"/);
  });
});

/* ═══════════ (٢) الإذن ═══════════ */

describe("★ (٢) الإذن — قبل أن يُقرأ كلامُ أحد", () => {
  it("★ ★ بلا موافقة ⇒ رفض، وصفر قراءةٍ للرسائل", async () => {
    const db = memoryDb({ consent: [], messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)] });
    expect(await share(db)).toEqual({ ok: false, reason: "consent_required" });
    expect(db.selects.filter((s) => s.startsWith("messages:"))).toHaveLength(0);
    expect(db.selects.filter((s) => s.startsWith("conversations:"))).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ وموافقةٌ ملغاة أو لنسخةٍ قديمة ⇒ رفض", async () => {
    for (const consent of [
      [{ enabled: true, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: AFTER }],
      [{ enabled: true, policy_version: "2020-01-01.v0", granted_at: GRANTED, revoked_at: null }],
      [{ enabled: false, policy_version: TRAINING_CONSENT_POLICY_VERSION, granted_at: GRANTED, revoked_at: null }],
    ]) {
      const db = memoryDb({ consent, messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)] });
      expect(await share(db)).toEqual({ ok: false, reason: "consent_required" });
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ والضغط لا يُفعّل موافقةً — صفر كتابةٍ على `training_consents`", async () => {
    const db = memoryDb({ consent: [], messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)] });
    await share(db);
    expect(db.updates).toHaveLength(0);
    expect(stripComments(SHARE_SRC)).not.toMatch(/setTrainingConsent/);
    expect(stripComments(ROUTE_SRC)).not.toMatch(/setTrainingConsent/);
  });
});

/* ═══════════ (٣) الملكية ═══════════ */

describe("★ (٣) الملكية — لا تكفي معرفة المعرّف", () => {
  it("★ ★ محادثةُ شخصٍ آخر ⇒ رفض بلا قراءة رسائل", async () => {
    const db = memoryDb({
      ownedConversation: false,
      messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)],
    });
    expect(await share(db, OTHER)).toEqual({ ok: false, reason: "conversation_not_found" });
    expect(db.selects.filter((s) => s.startsWith("messages:"))).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ والملكية تُقاس خادميًّا بشرطٍ صريح", () => {
    const src = stripComments(SHARE_SRC);
    expect(src).toMatch(/\.eq\("user_id", userId\)/);
    expect(src).toMatch(/\.is\("deleted_at", null\)/);
  });

  it("★ ★ ورسالةٌ محذوفة لا تدخل زوجًا", async () => {
    const db = memoryDb({
      messages: [
        msg("m2u", "user", AFTER),
        msg("m3a", "assistant", LATER, { deleted_at: LATER }),
        msg("m4u", "user", LATER),
        msg("m5a", "assistant", LATER),
      ],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toBe(1);
    expect(db.inserts[0]!.user_message_id).toBe("m4u");
  });
});

/* ═══════════ (٤) الحدّ الزمنيّ ═══════════ */

describe("★ (٤) لا عيّنة بأثر رجعيّ", () => {
  it("★ ★ محادثةٌ مختلطة: القديم يُتخطّى والجديد وحده يدخل", async () => {
    /**
     * وهذا هو الاختبار الذي يصف الحالة الواقعية: محادثةٌ بدأت قبل أن يأذن
     * صاحبها، ثم استُؤنفت بعد أن أذن. القياس على الرسالتين لا على المحادثة —
     * ولو قِيس على `conversations.created_at` لَسقط الزوجان معًا.
     */
    const db = memoryDb({
      messages: [
        msg("m2u", "user", BEFORE),
        msg("m3a", "assistant", BEFORE),
        msg("m4u", "user", AFTER),
        msg("m5a", "assistant", LATER),
      ],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(1);
      expect(r.beforeConsent).toBe(1);
      expect(r.examined).toBe(2);
    }
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.user_message_id).toBe("m4u");
    expect(db.inserts[0]!.assistant_message_id).toBe("m5a");
  });

  it("★ ★ ومحادثةٌ كلّها قبل الإذن ⇒ صفر إدخال", async () => {
    const db = memoryDb({
      messages: [msg("m2u", "user", BEFORE), msg("m3a", "assistant", BEFORE)],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(0);
      expect(r.beforeConsent).toBe(1);
    }
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ والحارس في الخدمة يعمل ولو سقط فرزُ الطبقة", async () => {
    /**
     * الفرز في `share.ts` توفيرٌ لا حراسة. فنستدعي الخدمة مباشرةً بزوجٍ
     * سابقٍ للإذن — كما يفعل مستدعٍ يُكتب غدًا ولا يقرأ هذا الملفّ.
     */
    const db = memoryDb({ messages: [msg("m2u", "user", BEFORE), msg("m3a", "assistant", BEFORE)] });
    const r = await createTrainingCandidate(
      { userId: USER, conversationId: CONV, userMessageId: "m2u", assistantMessageId: "m3a" },
      { getAdminClient: (() => db.client) as never, readConsent: readTrainingConsent },
    );
    expect(r).toEqual({ ok: false, reason: "before_consent" });
    expect(db.inserts).toHaveLength(0);
  });
});

/* ═══════════ (٥) بوّابات الجودة والخصوصية ═══════════ */

describe("★ (٥) البوّابات — كما بُنيت، لا تُلتَفّ", () => {
  const one = (assistantOver: Partial<Msg>) =>
    memoryDb({ messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER, assistantOver)] });

  it("★ ★ ردٌّ فارغ أو قصير ⇒ رفض جودة", async () => {
    for (const content of ["", "   ", "نعم"]) {
      const db = one({ content });
      const r = await share(db);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.created).toBe(0);
        expect(r.rejectedQuality).toBe(1);
      }
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ وردٌّ موسومٌ ناقصًا أو معطوبًا ⇒ رفض — والوسم من القاعدة", async () => {
    for (const status of ["incomplete_provider", "incomplete_timeout", "incomplete_guard"]) {
      const db = one({ metadata: { completion: { status, reason: "stream_interrupted" } } });
      const r = await share(db);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rejectedQuality).toBe(1);
      expect(db.inserts).toHaveLength(0);
    }
  });

  it("★ ★ وما تُوقنه الخصوصية يُرفض", async () => {
    const db = one({ content: `${A} تواصل معي على someone@example.com من فضلك.` });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(0);
      expect(r.rejectedPrivacy).toBe(1);
    }
    expect(db.inserts).toHaveLength(0);
  });

  it("★ ★ والنظيف يدخل `needs_review` لا `passed` — ولا اعتماد تلقائيّ", async () => {
    const db = memoryDb({ messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)] });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toBe(1);
    expect(db.inserts[0]!.status).toBe("pending");
    expect(db.inserts[0]!.privacy_status).toBe("needs_review");
    expect(db.inserts[0]!.source).toBe("user_opt_in");
  });
});

/* ═══════════ (٦) التكرار والتزامن ═══════════ */

describe("★ (٦) المشاركة مرّتين — نتيجةٌ لا عطل", () => {
  it("★ ★ إعادة الضغط ⇒ `created=0` و`duplicates=N`", async () => {
    const db = memoryDb({
      messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)],
      insertErrors: [{ code: "23505" }],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(0);
      expect(r.duplicates).toBe(1);
      expect(r.failed).toBe(0);
    }
  });

  it("★ ★ والتكرار يُميَّز عن العطل — لا يُبتلعان معًا", async () => {
    const db = memoryDb({
      messages: [
        msg("m2u", "user", AFTER),
        msg("m3a", "assistant", AFTER),
        msg("m4u", "user", LATER),
        msg("m5a", "assistant", LATER),
      ],
      insertErrors: [{ code: "23505" }, { code: "42501" }],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.duplicates).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.created).toBe(0);
    }
  });

  it("★ ★ وضغطتان متزامنتان لا تُنتجان صفَّين — الحارس في الفهرس", async () => {
    /**
     * لا فحصَ ثم إدراج في التطبيق: بينهما نافذةٌ يمرّ منها طلبان معًا.
     * والفرادة في القاعدة تجعل الثاني يرتدّ `23505` مهما تقارب التوقيت.
     */
    const rows: Record<string, unknown>[] = [];
    const build = () =>
      memoryDb({
        messages: [msg("m2u", "user", AFTER), msg("m3a", "assistant", LATER)],
        insertErrors: rows.length === 0 ? [] : [{ code: "23505" }],
      });
    const first = build();
    const r1 = await share(first);
    rows.push(...first.inserts);
    const second = build();
    const r2 = await share(second);

    expect(r1.ok && r1.created).toBe(1);
    expect(r2.ok && r2.duplicates).toBe(1);
    expect(r2.ok && r2.created).toBe(0);
    // بصمةٌ واحدة لزوجٍ واحد — وهي ما يحرسه الفهرس الفريد
    expect(second.inserts[0]!.content_fingerprint).toBe(first.inserts[0]!.content_fingerprint);
  });

  it("★ والفهرس الفريد قائمٌ في الترحيلة", () => {
    const m = readSrc("supabase/migrations/0040_ysd_training_bank.sql");
    expect(m).toMatch(/create unique index[\s\S]*content_fingerprint/);
  });
});

/* ═══════════ (٧) الفشل الجزئيّ ═══════════ */

describe("★ (٧) الفشل — ملخّصٌ صادق لا كذبةٌ نظيفة", () => {
  it("★ ★ رفضُ عيّنةٍ لا يُسقط الباقي", async () => {
    const db = memoryDb({
      messages: [
        msg("m2u", "user", AFTER),
        msg("m3a", "assistant", AFTER, { content: "لا" }),
        msg("m4u", "user", LATER),
        msg("m5a", "assistant", LATER),
      ],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created).toBe(1);
      expect(r.rejectedQuality).toBe(1);
      expect(r.examined).toBe(2);
    }
  });

  it("★ ★ وعطلُ القاعدة في القراءة عطلٌ صريح لا نجاحٌ فارغ", async () => {
    const db = memoryDb({ messagesError: true, messages: [] });
    expect(await share(db)).toEqual({ ok: false, reason: "database_error" });
  });

  it("★ ★ والعدّادات تجمع كل ما فُحص", async () => {
    const db = memoryDb({
      messages: [
        msg("m0u", "user", BEFORE),
        msg("m1a", "assistant", BEFORE),
        msg("m2u", "user", AFTER),
        msg("m3a", "assistant", AFTER, { content: "لا" }),
        msg("m4u", "user", LATER),
        msg("m5a", "assistant", LATER),
      ],
    });
    const r = await share(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        r.created + r.duplicates + r.beforeConsent + r.rejectedQuality + r.rejectedPrivacy + r.failed,
      ).toBe(r.examined);
      expect(r.examined).toBe(3);
    }
  });
});

/* ═══════════ (٨) الإلغاء ═══════════ */

describe("★ (٨) الإلغاء — يبقى كاملًا", () => {
  it("★ ★ سحبُ الإذن أثناء الجولة يوقفها ويكنس ما أُنشئ فيها", async () => {
    /**
     * كنسةُ الإلغاء في مسار الإعدادات جرت قبل هذه الإدخالات فلا تشملها.
     * وتركُها يخالف ما وُعد به صاحبها: أن الإطفاء يُبطل كل ما لم يخرج.
     */
    const revokeCandidates = vi.fn(async () => ({ ok: true as const, revoked: 1 }));
    const createCandidate = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, created: true, candidateId: "x", privacyStatus: "needs_review" })
      .mockResolvedValueOnce({ ok: false, reason: "consent_missing" });

    const db = memoryDb({
      messages: [
        msg("m2u", "user", AFTER),
        msg("m3a", "assistant", AFTER),
        msg("m4u", "user", LATER),
        msg("m5a", "assistant", LATER),
      ],
    });
    const r = await shareConversationForTraining(USER, CONV, {
      getAdminClient: (() => db.client) as never,
      readConsent: readTrainingConsent,
      createCandidate: createCandidate as never,
      revokeCandidates: revokeCandidates as never,
    });
    expect(r).toEqual({ ok: false, reason: "consent_required" });
    expect(revokeCandidates).toHaveBeenCalledWith(USER);
  });

  it("★ ★ ولا حالة `exported` — فالإبطال يطال كل ما في البنك", () => {
    const m = readSrc("supabase/migrations/0040_ysd_training_bank.sql");
    expect(m).not.toMatch(/'exported'/);
    const candidate = readSrc("lib/training/candidate.ts");
    expect(candidate).toMatch(/\.in\("status", \["pending", "approved"\]\)/);
  });
});

/* ═══════════ (٩) الواجهة الخلفية ═══════════ */

describe("★ (٩) المسار — لا يقبل من العميل شيئًا", () => {
  const src = stripComments(ROUTE_SRC);

  it("★ ★ `POST` وحده — ولا `GET` يُنشئ صفوفًا", () => {
    expect(src).toMatch(/export async function POST/);
    expect(src).not.toMatch(/export async function (GET|PUT|DELETE|PATCH)/);
  });

  it("★ ★ والهوّية من الجلسة لا من الجسم", () => {
    expect(src).toMatch(/getRequestContext/);
    expect(src).toMatch(/ctx\.userId/);
    expect(src).not.toMatch(/body\.userId|parsed\.data\.userId/);
  });

  it("★ ★ ولا يُقرأ جسمٌ إطلاقًا — فلا حقل يملكه العميل", () => {
    /**
     * ولا `messageIds` ولا `status` ولا `privacy_status`. الأزواج يستنتجها
     * الخادم، والحقول يملكها الخادم. وواجهةٌ تقبل شيئًا تُفتح من الخارج ولو
     * لم يستعملها أحد اليوم.
     */
    expect(src).not.toMatch(/req\.json\(\)/);
    expect(src).not.toMatch(/z\.object|safeParse\(await/);
    for (const f of [
      "messageIds", "userMessageId", "assistantMessageId",
      "privacy_status", "quality_status", "granted_at", "content_fingerprint",
    ]) {
      expect(src).not.toMatch(new RegExp(f));
    }
    // ولا حقل `status` يأتي من الطلب — الوحيد المسموح هو `res.status` المقروء
    for (const m of src.match(/status/g) ?? []) expect(m).toBe("status");
    expect(src).not.toMatch(/body\.status|data\.status|status:\s*(parsed|body)/);
  });

  it("★ ★ وبلا جلسة ⇒ 401، وبلا موافقة ⇒ 403 برمزٍ لا يسرّب", () => {
    expect(src).toMatch(/if \(!ctx\) return json\([\s\S]{0,60}401\)/);
    expect(src).toMatch(/training_consent_required/);
    expect(src).toMatch(/403/);
  });

  it("★ ★ والجواب أعدادٌ لا محتوى", () => {
    /**
     * ويُقاس على كتلة النجاح وحدها — فهي ما يصل المتصفّح عند المشاركة.
     * وقياسُ الملفّ كلّه كان سيصطدم بـ`ctx.userId` المشروع في السطر الذي
     * يقرأ الهوّية من الجلسة، فيقول «تسريب» عمّا هو عكسه تمامًا.
     */
    const success = src.slice(src.lastIndexOf("return json("));
    for (const leak of ["content", "fingerprint", "candidateId", "userId", "conversationId", "granted"]) {
      expect(success).not.toMatch(new RegExp(leak, "i"));
    }
    expect(success).toMatch(/created: result\.created/);
    expect(success).toMatch(/beforeConsent: result\.beforeConsent/);
  });

  it("★ ★ والسجلّ أعدادٌ كذلك — لا نصّ ولا هوّية", () => {
    const log = src.match(/console\.log\([\s\S]*?\);/)?.[0] ?? "";
    expect(log).toMatch(/examined=/);
    expect(log).not.toMatch(/content|\bQ\b|userId|ctx\.|conversationId|\$\{id\}/);
  });
});

/* ═══════════ (١٠) الحدود ═══════════ */

describe("★ (١٠) الحدود — لا التقاط تلقائيّ", () => {
  it("★ ★ مسار المحادثة لا يعرف البنك", () => {
    expect(CHAT_ROUTE).not.toMatch(/lib\/training/);
    expect(CHAT_ROUTE).not.toMatch(/createTrainingCandidate|shareConversationForTraining/);
  });

  it("★ ★ ولا خطّاف بعد البثّ ولا مستمعٌ في الخلفية", () => {
    const src = stripComments(SHARE_SRC);
    expect(src).not.toMatch(/setInterval|setTimeout|subscribe|channel\(/);
  });

  it("★ ★ وهي لقطة لا اشتراك — لا عمود يجعل المحادثة «مشتركة»", () => {
    const m = readSrc("supabase/migrations/0040_ysd_training_bank.sql");
    const h = readSrc("supabase/migrations/0041_ysd_training_bank_hardening.sql");
    for (const sql of [m, h]) {
      expect(sql).not.toMatch(/shared_conversations|auto_share|share_enabled/);
    }
  });

  it("★ ★ ولا ترحيلة جديدة — 0040 و0041 تكفيان", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(Math.max(...files.map((f) => Number(f.slice(0, 4))))).toBe(41);
  });

  it("★ ★ ولا تصدير ولا اعتماد ولا تدريب في هذه الطبقة", () => {
    for (const src of [SHARE_SRC, ROUTE_SRC]) {
      expect(src).not.toMatch(/export_|dataset|fine_?tune|LoRA|train_job|weights/i);
    }
  });

  it("★ ★ ولا بايت صفريّ خامّ في مصدرٍ يُراجَع", () => {
    /**
     * ── عيبٌ سابقٌ لهذه الرقعة، وُجد أثناءها ──
     *
     * فاصلُ مادّة البصمة بايتٌ صفريّ — وهو الصواب: المسافة تجعل
     * («س ص»، «ع») و(«س»، «ص ع») مادّةً واحدة فتلتبس بصمتاهما. لكنه كان
     * يُكتب في المصدر **خامًّا**، فكان git يقرأ الملفّ ثنائيًّا ويعرض
     * «Bin 11081 -> 15179 bytes» بدل فروقٍ تُقرأ.
     *
     * وملفٌّ لا يُرى فيه الفرق لا يُراجَع. وهذا ملفّ البوّابة التي يمرّ
     * منها كلامُ الناس — أسوأ ملفٍّ في المستودع يُخفى فرقه.
     *
     * والتهريب يُنتج البايت نفسه، فالبصمات المحسوبة قبله وبعده متطابقة.
     */
    const raw = readFileSync("lib/training/candidate.ts");
    expect(raw.includes(0)).toBe(false);
    const src = readSrc("lib/training/candidate.ts");
    expect(src).toContain("(userText)}" + ESCAPED_NUL + "${normalizeForFingerprint(assistantText)}");
  });

  it("★ ولا نصَّ في طبقة المشاركة — الهيكل وحده", () => {
    const src = stripComments(SHARE_SRC);
    expect(src).toMatch(/\.select\("id, role, created_at"\)/);
    expect(src).not.toMatch(/select\([^)]*content/);
  });
});
