/**
 * جمع بيانات التدريب — تقدُّمٌ ومراجعة (v0.9.11، المرحلة 5A).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   الحدّ سياسةٌ يملكها الخادم، والاعتماد قرارٌ يتّخذه إنسان.
 *
 * فالتسهيل هنا في **العدّ والتنقّل** لا في الحكم: لا اعتمادَ جماعيّ، ولا
 * مشاركةً تلقائية، ولا إنشاءَ مجموعةٍ عند بلوغ عدد.
 *
 * ── والأعداد لا تقرأ ──
 *
 * الملخّص لا يطلب `content` أصلًا، والمعرّفات تدخل `Set` وتخرج عددًا.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { buildTrainingSummary } from "@/lib/training/summary";
import { TRAINING_READINESS_POLICY } from "@/lib/training/readiness";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const SUMMARY_SRC = readSrc("lib/training/summary.ts");
const SUMMARY_ROUTE = readSrc("app/api/admin/training-summary/route.ts");
const VIEW = readSrc("components/admin/training-review-view.tsx");
const PAGE = readSrc("app/admin/training/page.tsx");
const SHARE_ACTION = readSrc("components/chat/training-share-action.tsx");
const SHARE_LIB = readSrc("lib/training/share.ts");
const CANDIDATE = readSrc("lib/training/candidate.ts");
const DECISION = readSrc("lib/training/decision.ts");
const DATASET = readSrc("lib/training/dataset.ts");

const NOW = Date.parse("2026-08-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

interface Row {
  status: string;
  decided_at: string | null;
  conversation_id: string;
  user_id: string;
}

function memoryDb(rows: Row[] | null) {
  const selects: string[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols?: string) => {
          if (typeof cols === "string") selects.push(`${table}:${cols}`);
          return chain;
        },
        eq: () => chain,
        limit: () =>
          Promise.resolve(rows === null ? { data: null, error: { code: "x" } } : { data: rows, error: null }),
      });
      return chain;
    },
  };
  return { client, selects };
}

const approved = (n: number, over: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    status: "approved",
    decided_at: daysAgo(1),
    conversation_id: `conv-${i}`,
    user_id: `user-${i}`,
    ...over,
  }));

const summary = (rows: Row[] | null) => {
  const db = memoryDb(rows);
  return {
    db,
    run: () =>
      buildTrainingSummary({
        getAdminClient: (() => db.client) as never,
        now: () => NOW,
      }),
  };
};

/* ═══════════ (١) التقدّم نحو الحدّ ═══════════ */

describe("★ (١) التقدّم — والحدّ من السياسة", () => {
  it("★ ★ ★ واحدةٌ معتمَدة ⇒ ١ / ١٠٠ والمتبقّي ٩٩", async () => {
    const r = await summary(approved(1)).run();
    expect(r).not.toBeNull();
    expect(r!.approved).toBe(1);
    expect(r!.minimumSamples).toBe(100);
    expect(r!.remaining).toBe(99);
    expect(r!.thresholdReached).toBe(false);
  });

  it("★ ★ وتسعٌ وتسعون ⇒ المتبقّي واحد", async () => {
    const r = await summary(approved(99)).run();
    expect(r!.remaining).toBe(1);
    expect(r!.thresholdReached).toBe(false);
  });

  it("★ ★ ومئةٌ ⇒ بلغ الحدّ، والمتبقّي صفر", async () => {
    const r = await summary(approved(100)).run();
    expect(r!.remaining).toBe(0);
    expect(r!.thresholdReached).toBe(true);
  });

  it("★ ★ ومئةٌ وواحدة ⇒ يبقى بالغًا، ولا متبقّي سالب", async () => {
    const r = await summary(approved(101)).run();
    expect(r!.remaining).toBe(0);
    expect(r!.thresholdReached).toBe(true);
  });

  it("★ ★ ★ والحدّ يُستورَد من السياسة — لا يُكتب هنا", () => {
    /**
     * ولو كُتب رقمٌ في الملخّص لصار للنظام حدّان: واحدٌ يمنع التنفيذ وآخر
     * يُعرض للمشرف. ويومَ يتغيّر أحدهما يقرأ المشرف تقدُّمًا لا يوافق ما
     * يمنعه الحارس.
     */
    const src = stripComments(SUMMARY_SRC);
    expect(src).toMatch(/import \{ TRAINING_READINESS_POLICY \} from "\.\/readiness"/);
    expect(src).toMatch(/TRAINING_READINESS_POLICY\.minimumSamples/);
    expect(src).not.toMatch(/=\s*100\b|minimumSamples:\s*\d/);
  });

  it("★ ★ ★ ولا يُكتب في المتصفّح", () => {
    /**
     * فالحدّ سياسةٌ يملكها الخادم. وحسابُه في المتصفّح يجعله رقمًا يبدّله
     * من يفتح الأدوات فيرى تقدُّمًا لا وجود له.
     */
    const ui = stripComments(VIEW);
    /**
     * ★ والقياس على **الحدّ** لا على كل مئة.
     *
     * فشريط التقدّم يستعمل `Math.min(100, …)` و`* 100` لأنه نسبةٌ مئوية —
     * وذلك ثابتُ حسابٍ لا حدُّ سياسة. والمُختبَر ألّا يُقارَن العدد برقمٍ
     * مكتوبٍ هنا، وأن يأتي الحدّ من الخادم.
     */
    expect(ui).not.toMatch(/minimumSamples\s*[:=]\s*\d/);
    expect(ui).not.toMatch(/(approved|remaining)\s*[<>=]+\s*\d/);
    expect(ui).toMatch(/progress\.thresholdReached/);
    expect(ui).toMatch(/progress\.minimumSamples/);
    expect(ui).toMatch(/progress\.remaining/);
    expect(stripComments(PAGE)).toMatch(/buildTrainingSummary\(\)/);
  });
});

/* ═══════════ (٢) العدّ ═══════════ */

describe("★ (٢) الأعداد — بكلّ حالة", () => {
  it("★ ★ كلُّ حالةٍ تُعدّ في خانتها", async () => {
    const rows: Row[] = [
      ...approved(3),
      { status: "pending", decided_at: null, conversation_id: "c", user_id: "u" },
      { status: "rejected_quality", decided_at: daysAgo(2), conversation_id: "c", user_id: "u" },
      { status: "rejected_privacy", decided_at: daysAgo(2), conversation_id: "c", user_id: "u" },
      { status: "revoked", decided_at: null, conversation_id: "c", user_id: "u" },
    ];
    const r = await summary(rows).run();
    expect(r).toMatchObject({
      total: 7, approved: 3, pending: 1,
      rejectedQuality: 1, rejectedPrivacy: 1, revoked: 1,
    });
  });

  it("★ ★ ★ ويُقاس الأسبوع بوقت **القرار** لا بوقت الإنشاء", async () => {
    /**
     * فالسؤال «كم اعتُمد هذا الأسبوع؟» سؤالٌ عن عمل المراجعة، لا عن متى
     * شارك الناس. وعيّنةٌ شُوركت قبل شهرٍ واعتُمدت أمس عملُ أمس.
     */
    const rows: Row[] = [
      { status: "approved", decided_at: daysAgo(1), conversation_id: "a", user_id: "u1" },
      { status: "approved", decided_at: daysAgo(10), conversation_id: "b", user_id: "u2" },
      { status: "approved", decided_at: daysAgo(40), conversation_id: "c", user_id: "u3" },
      { status: "approved", decided_at: null, conversation_id: "d", user_id: "u4" },
    ];
    const r = await summary(rows).run();
    expect(r!.approvedLast7Days).toBe(1);
    expect(r!.approvedLast30Days).toBe(2);
    expect(stripComments(SUMMARY_SRC)).toMatch(/row\.decided_at/);
  });

  it("★ وعطلُ القراءة يُعيد `null` لا أصفارًا", async () => {
    /** فأصفارٌ عن عطلٍ تُقرأ «لم يشارك أحد» — وذلك كذب */
    expect(await summary(null).run()).toBeNull();
  });
});

/* ═══════════ (٣) التنوّع ═══════════ */

describe("★ (٣) التنوّع — تنبيهٌ لا حكم", () => {
  it("★ ★ محادثاتٌ قليلة تحمل معتمَدًا كثيرًا ⇒ تنبيه", async () => {
    /**
     * فمئةُ عيّنةٍ من محادثتين ليست مئةَ عيّنةٍ في المعنى الذي يهمّ.
     */
    const rows = approved(30).map((r, i) => ({ ...r, conversation_id: `conv-${i % 3}` }));
    const s = await summary(rows).run();
    expect(s!.distinctConversations).toBe(3);
    expect(s!.warnings).toContain("concentrated_conversations");
  });

  it("★ ★ ومساهمٌ واحد ⇒ تنبيه", async () => {
    const rows = approved(12).map((r) => ({ ...r, user_id: "solo" }));
    const s = await summary(rows).run();
    expect(s!.distinctContributors).toBe(1);
    expect(s!.warnings).toContain("single_contributor");
  });

  it("★ ★ وتنوّعٌ كافٍ ⇒ لا تنبيه", async () => {
    const s = await summary(approved(30)).run();
    expect(s!.warnings).toEqual([]);
  });

  it("★ ★ ★ والتنبيه لا يرفض عيّنةً ولا يحجبها", async () => {
    /**
     * فالرفض حكمٌ يحتاج قراءةً، وهذه أعدادٌ لا تقرأ. ولو رفضت لَحذفت عملَ
     * إنسانٍ بناءً على تشابهِ معرّفات.
     */
    const rows = approved(30).map((r) => ({ ...r, conversation_id: "one", user_id: "solo" }));
    const s = await summary(rows).run();
    expect(s!.approved).toBe(30);
    expect(s!.warnings.length).toBeGreaterThan(0);
    const src = stripComments(SUMMARY_SRC);
    expect(src).not.toMatch(/\.update\(|\.delete\(|\.insert\(/);
  });

  it("★ ★ ★ ولا استنتاجَ لصفةٍ حسّاسة", () => {
    /**
     * لا جنسية، ولا دين، ولا صحّة، ولا سياسة، ولا لغة — فالمشروع لا يملك
     * إشارةَ لغةٍ موثوقة أصلًا، واختراعُ واحدةٍ استنتاجٌ عن الناس.
     */
    const src = stripComments(SUMMARY_SRC);
    for (const bad of ["language", "locale", "nationality", "gender", "religion",
                       "health", "politic", "ethnic", "age"]) {
      expect(src).not.toMatch(new RegExp(bad, "i"));
    }
  });
});

/* ═══════════ (٤) الخصوصية ═══════════ */

describe("★ (٤) ★ الأعداد لا تقرأ", () => {
  it("★ ★ ★ الاستعلام لا يطلب نصًّا أصلًا", async () => {
    /** فما لا يُطلب لا يُقرأ، وما لا يُقرأ لا يُسرَّب */
    const s = summary(approved(2));
    await s.run();
    const sel = s.db.selects.find((x) => x.startsWith("training_candidates:"))!;
    expect(sel).toBe("training_candidates:status, decided_at, conversation_id, user_id");
    expect(sel).not.toContain("content");
    expect(sel).not.toContain("fingerprint");
  });

  it("★ ★ ★ والمعرّفات تُعدّ ولا تُعاد", async () => {
    const r = await summary(approved(3)).run();
    const json = JSON.stringify(r);
    expect(json).not.toContain("user-0");
    expect(json).not.toContain("conv-0");
    expect(r!.distinctContributors).toBe(3);
  });

  it("★ ★ والجواب أعدادٌ فقط", () => {
    /**
     * وتُستثنى ترويسة `Content-Type`: هي وصفُ نوعِ الجواب لا محتوى عيّنة،
     * وحارسٌ يمنعها يمنع كتابة جوابٍ صحيح.
     */
    const s = stripComments(SUMMARY_ROUTE).replace(/"Content-Type"[^,]*,/g, "");
    for (const leak of ["userId", "user_id", "conversation_id", "content", "fingerprint", "userText"]) {
      expect(s).not.toMatch(new RegExp(leak, "i"));
    }
    expect(s).toMatch(/getAdminContext/);
    expect(s).toMatch(/unauthorized\(\)/);
    expect(s).toMatch(/forbidden\(\)/);
  });

  it("★ ★ و`GET` وحده — ولا `POST` يعتمد أو يُنشئ", () => {
    const s = stripComments(SUMMARY_ROUTE);
    expect(s).toMatch(/export async function GET/);
    expect(s).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it("★ ★ ولا هوّيةَ في قائمة المرشّحين", () => {
    const page = stripComments(PAGE);
    const cols = page.match(/const LIST_COLUMNS =[\s\S]*?;/)?.[0] ?? "";
    expect(cols).not.toMatch(/user_id|\*/);
    const ui = stripComments(VIEW);
    expect(ui).not.toMatch(/userId|user_id|email/i);
  });

  it("★ ★ ولا تسجيلَ لمحتوى", () => {
    for (const src of [SUMMARY_SRC, SUMMARY_ROUTE]) {
      /**
       * ★ ولا اسمَ حقلٍ بعينه — بل كلُّ ما يُعرّف.
       *
       * كشفَت هذه الفجوةَ طفرةٌ: سطرٌ يسجّل `conversations=…` مرّ، لأن
       * حارسي كان يمنع `conversation_id` وحدها. والفرق حرفان، والمُسرَّب
       * واحد.
       */
      for (const m of stripComments(src).match(/console\.\w+\([\s\S]*?\);/g) ?? []) {
        expect(m).not.toMatch(/content|userText|sample|conversation|user|contributor|fingerprint/i);
      }
    }
  });
});

/* ═══════════ (٥) طابور المراجعة ═══════════ */

describe("★ (٥) الطابور — تنقّلٌ لا حكم", () => {
  it("★ ★ الأقدم أوّلًا — بترتيبٍ صريح", () => {
    const page = stripComments(PAGE);
    expect(page).toMatch(/\.eq\("status", "pending"\)[\s\S]{0,80}\.order\("created_at", \{ ascending: true \}\)/);
  });

  it("★ ★ ★ والانتقال يفتح التالية للقراءة — ولا يقرّر", () => {
    /**
     * فالتسهيل في التنقّل لا في الحكم. و`openNext` تفتح، والقرار يبقى
     * ضغطةً على زرّ في كل مرّة.
     */
    const ui = stripComments(VIEW);
    const fn = ui.slice(ui.indexOf("const openNext"), ui.indexOf("const openNext") + 400);
    expect(fn).toMatch(/void open\(next\.id\)/);
    expect(fn).not.toMatch(/decide\(|approve|reject/);
  });

  it("★ ★ ★ ولا اعتمادَ جماعيّ", () => {
    /**
     * فكلّ اعتمادٍ قرارٌ على عيّنةٍ قُرئت. و«اعتمد الكل» يجعل مئةَ قرارٍ
     * ضغطةً واحدة على ما لم يُقرأ.
     */
    const ui = VIEW;
    for (const bad of [/approveAll/i, /bulk/i, /selectAll/i, /data-training-approve-all/]) {
      expect(ui).not.toMatch(bad);
    }
    expect(stripComments(DECISION)).not.toMatch(/\.in\("id"|approveMany|bulkDecide/);
  });

  it("★ ★ ★ والاختصار بمُعدِّل لا بحرفٍ واحد", () => {
    /**
     * فحرفٌ مفرد يعتمد عيّنةً بضغطةٍ عابرة. وقرارُ إدخال كلامِ إنسانٍ إلى
     * بنك تدريب لا يُتَّخذ سهوًا.
     */
    const ui = stripComments(VIEW);
    expect(ui).toMatch(/if \(!\(e\.ctrlKey \|\| e\.metaKey\)\) return;/);
    /** والاعتماد يشترط أن تكون قابلةً للاعتماد أصلًا */
    expect(ui).toMatch(/key === "enter" && panel\.approvable/);
  });

  it("★ ★ ولا يُجلب محتوى عيّناتٍ كثيرة مسبقًا", () => {
    /**
     * فالمعاينة واحدةٌ في كل مرّة عبر مسار المراجعة المحميّ. وجلبُ عشرين
     * نصًّا إلى المتصفّح لأجل السرعة يجعل عشرين عيّنةً مكشوفةً لواحدةٍ
     * تُقرأ.
     */
    const ui = stripComments(VIEW);
    expect(ui).not.toMatch(/Promise\.all\([\s\S]{0,120}review/);
    expect(ui).toMatch(/\/api\/admin\/training-candidates\/\$\{id\}\/review/);
    const page = stripComments(PAGE);
    expect(page).not.toMatch(/\/review/);
  });
});

/* ═══════════ (٦) عقد الخصوصية ═══════════ */

describe("★ (٦) ★ عقد الخصوصية — كما هو", () => {
  it("★ ★ ★ ولا مشاركةَ تلقائية", () => {
    /**
     * فمحادثةٌ حيّة ليست بيانات تدريبٍ لأن الإذن مفتوح. ويبقى المطلوب:
     * إذنٌ سارٍ + فعلٌ صريح + بوّابات + مراجعة + اعتماد.
     */
    const ui = stripComments(SHARE_ACTION);
    /** لا فتحَ تلقائيًّا للحوار، ولا إرسالَ عند التركيب */
    expect(ui).not.toMatch(/useEffect\([\s\S]{0,200}(open\(\)|confirm\(\))/);
    expect(ui).toMatch(/onClick=\{\(\) => void open\(\)\}/);
    expect(ui).toMatch(/data-training-share-confirm/);
  });

  it("★ ★ ★ ولا التقاطَ من مسار المحادثة", () => {
    const chat = readSrc("app/api/chat/route.ts");
    expect(chat).not.toMatch(/lib\/training|createTrainingCandidate|shareConversation/);
  });

  it("★ ★ ★ ولا اعتمادَ تلقائيّ", () => {
    /** فالخصوصية لا تُمنح `passed` بفحصٍ آليّ — تُمنح حين يقرأ إنسان */
    const cand = stripComments(CANDIDATE);
    expect(cand).toMatch(/privacy_status: privacy\.status/);
    expect(cand).not.toMatch(/privacy_status: "passed"/);
    expect(stripComments(DECISION)).toMatch(/privacy_status: "passed"/);
  });

  it("★ ★ ★ ولا إنشاءَ مجموعةٍ تلقائيًّا عند بلوغ الحدّ", () => {
    /**
     * فبلوغُ عددٍ ليس قرارًا. والقرار للمشرف: أيّ عيّنات، ومتى، وبأيّ
     * إصدار — واللوحة تقول ذلك صراحةً.
     */
    const src = stripComments(SUMMARY_SRC);
    expect(src).not.toMatch(/createDatasetDraft|freezeDatasetRelease|createDatasetArtifact/);
    expect(stripComments(SUMMARY_ROUTE)).not.toMatch(/createDataset|freeze/);
    expect(VIEW).toMatch(/progressReachedNote/);
  });

  it("★ ★ ★ ولا تمسّ هذه الرقعة مجموعةً مجمَّدة ولا مهمّة", () => {
    for (const src of [SUMMARY_SRC, SUMMARY_ROUTE]) {
      const s = stripComments(src);
      expect(s).not.toMatch(/training_dataset_releases|training_dataset_items|training_jobs|training_dataset_artifacts/);
    }
    /** والمجمَّد محروسٌ في القاعدة على كل حال */
    expect(readSrc("supabase/migrations/0042_ysd_training_dataset_releases.sql"))
      .toMatch(/item set is immutable/);
  });

  it("★ ★ والنصّ لا يَعِد بجودة", () => {
    /**
     * «١٠٠ عيّنة = نموذجٌ جاهز» دعوى لا يسندها شيء. والمكتوب أنها الحدّ
     * التشغيليّ لفتح اختبار.
     */
    const i18n = readSrc("lib/i18n.tsx");
    expect(i18n).toMatch(/الحد التشغيلي الأدنى لفتح مرحلة اختبار التدريب/);
    expect(i18n).toMatch(/وليست ضمانًا لجودة النموذج/);
    expect(i18n).toMatch(/not a guarantee of model quality/);
  });
});

/* ═══════════ (٧) الحدود ═══════════ */

describe("★ (٧) الحدود — لا ترحيلة ولا تدريب", () => {
  it("★ ★ ولا ترحيلةَ جديدة — الأعداد كلّها قائمة", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    /**
     * ★ الثابت: لا تكرار في الترقيم، والترحيلات المعنيّة قائمة.
     *
     * وكان الحارس يملك «أحدث رقم» — فيسقط مع كل ترحيلٍ جديد لا لأن شيئًا
     * انكسر بل لأن المشروع تقدّم. وملكيةُ الأحدث تنتقل إلى أحدث مجموعة.
     */
    const nums = files.map((f) => Number(f.slice(0, 4)));
    expect(nums).toContain(45);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("★ ★ ولا عتادَ ولا مزوّدَ ولا تدريب", () => {
    for (const src of [SUMMARY_SRC, SUMMARY_ROUTE, VIEW]) {
      const s = stripComments(src);
      expect(s).not.toMatch(/runpod|\bgpu\b|fine_?tune|LoRA|train_job|weights/i);
      expect(s).not.toMatch(/fetch\(\s*["'`]https?:/);
    }
  });

  it("★ ★ ولا يقرأ الملخّص أثرًا ولا JSONL", () => {
    expect(stripComments(SUMMARY_SRC)).not.toMatch(/storage|jsonl|artifact/i);
  });

  it("★ ★ ومنطقُ المشاركة كما هو — لقطةٌ لا اشتراك", () => {
    /**
     * فلا عَلَمٌ دائم يقول «شوركت المحادثة كلّها». وإعادةُ المشاركة تفحص
     * ما استجدّ، وتقول «لا أجزاء جديدة» حين لا يستجدّ شيء.
     */
    const share = stripComments(SHARE_LIB);
    expect(share).not.toMatch(/shared_at|is_shared|auto_share|share_enabled/);
    expect(readSrc("lib/i18n.tsx")).toMatch(/لا توجد أجزاء جديدة لإضافتها/);
  });
});
