/**
 * تصليب ما قبل التجربة العامّة (v0.9.14، المرحلة 6C).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   رقمٌ ناقص يُعرض كأنه تامّ أسوأ من رقمٍ غائب، واسمٌ يدّعي ملكيةً يُسقط
 *   معه كلَّ ما هو صحيح.
 *
 * فسقفُ صفوف PostgREST كان يقصّ الاستهلاك عند ألفٍ **بلا خطأ**، فيرى صاحبُ
 * الباقة الأكبر رقمًا يبدو صحيحًا وليس كذلك. وأخطرُ ما فيه أنه لا يظهر إلا
 * عند من تجاوز الألف — أي لا يظهر في أي فحصٍ يدويّ.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { buildContentSecurityPolicy } from "@/lib/csp";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  aggregateUsageEvents,
  countUsageEvents,
  USAGE_SCAN,
} from "@/lib/usage/aggregate";
import { MODEL_NOTE_KEYS, modelNoteKey, YSD_ALPHA_MODEL_ID_PUBLIC } from "@/lib/ai/model-notes";
import { YSD_FREE_MODEL_ID } from "@/lib/ai/free-models";
import { YSD_ALPHA_MODEL_ID } from "@/lib/ai/ysd";
import { TIER_DOWNGRADE_MESSAGE } from "@/lib/ai/model-policy";
import { normalizeSupportTopic, SUPPORT_TOPICS } from "@/lib/public-support";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const I18N = readSrc("lib/i18n.tsx");
const CHAT_VIEW = readSrc("components/chat/chat-view.tsx");
const NEXT_CONFIG = readSrc("next.config.mjs");
const AGGREGATE = readSrc("lib/usage/aggregate.ts");

/* ═══════════ (١) تجميع الاستهلاك فوق الألف ═══════════ */

/**
 * قاعدةٌ وهمية تحاكي **سقف الصفوف** بأمانة.
 *
 * لا تُعيد أكثر من `PAGE_SIZE` صفًّا مهما طُلب — وهو بالضبط ما يفعله
 * PostgREST بلا خطأ. ولو حاكينا قاعدةً بلا سقف لَما أثبت الاختبار شيئًا.
 */
function fakeDb(total: number, tokensPerEvent = 10, model = "ysd/free", rpcFails = false) {
  const rangeCalls: [number, number][] = [];
  let headCount = 0;

  const client = {
    from() {
      const q: Record<string, unknown> = {};
      let isHead = false;
      Object.assign(q, {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          isHead = opts?.head === true;
          return q;
        },
        eq: () => q,
        gte: () => q,
        lt: () => q,
        order: () => q,
        range: (from: number, to: number) => {
          rangeCalls.push([from, to]);
          const size = Math.min(to - from + 1, USAGE_SCAN.PAGE_SIZE);
          const available = Math.max(0, Math.min(total - from, size));
          const data = Array.from({ length: available }, () => ({
            model_id: model,
            input_tokens: tokensPerEvent,
            output_tokens: 0,
          }));
          return Promise.resolve({ data, error: null });
        },
        then: (resolve: (v: unknown) => unknown) => {
          headCount += 1;
          return Promise.resolve(
            isHead ? { count: total, error: null } : { data: [], error: null },
          ).then(resolve);
        },
      });
      return q;
    },
  };
  /**
   * ★ ودالّةُ القاعدة تُحاكى بمجاميعَ دقيقة (المرحلة 6G).
   *
   * انتقل الجمع إلى `usage_totals_*`، فصار هذا الوهميّ يردّ ما تردّه: عددًا
   * ومجاميعَ بلا سقف. والمسحُ لم يعد يُستدعى إلا لتفصيل «لكل نموذج».
   */
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  (client as Record<string, unknown>).rpc = (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (rpcFails) return Promise.resolve({ data: null, error: { message: "unavailable" } });
    return Promise.resolve({
      data: [
        {
          event_count: total,
          input_tokens: total * tokensPerEvent,
          output_tokens: 0,
          total_tokens: total * tokensPerEvent,
        },
      ],
      error: null,
    });
  };

  return {
    client: client as unknown as SupabaseClient,
    rangeCalls,
    rpcCalls,
    heads: () => headCount,
  };
}

describe("★ (١) الاستهلاك — دقيقٌ في القاعدة", () => {
  /**
   * ★ الحالات التي كان العطل يختبئ خلفها.
   *
   * `999` كانت تمرّ، و`1000` بالصدفة، و`1001` أوّل كذبة. وبعد 6G صار
   * المجموع من دالّة القاعدة، فالحدّ الأعلى ذهب — ويبقى الحارس على الحالات
   * نفسها لأنها التي كشفت العطل أوّلًا.
   */
  const cases = [0, 200, 999, 1000, 1001, 2000, 10_000, 30_001, 100_000];

  for (const total of cases) {
    it(`★ ★ ★ ${total} حدثًا ⇒ العدد والمجموع دقيقان`, async () => {
      const { client } = fakeDb(total, 7);
      const agg = await aggregateUsageEvents(client, { userId: "u1", since: "2026-08-01" });
      expect(agg.events, "count").toBe(total);
      expect(agg.tokens, "tokens").toBe(total * 7);
      expect(agg.unavailable).toBe(false);
    });
  }

  it("★ ★ ★ والمجموع يأتي من دالّة القاعدة لا من مسح صفوف", async () => {
    /**
     * ★ الفرق الذي تُغلقه هذه المرحلة.
     *
     * جمعٌ في التطبيق يعني جلبَ كل صفّ — وهو ما كان يُقصّ. والحارس يتأكّد
     * أن **لا رحلةَ صفوفٍ واحدة** تقع في مسار المجاميع.
     */
    const { client, rangeCalls, rpcCalls } = fakeDb(100_000, 3);
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.tokens).toBe(300_000);
    expect(rangeCalls, "لا صفوف تُجلب للمجاميع").toHaveLength(0);
    expect(rpcCalls).toHaveLength(1);
  });

  it("★ ★ ★ ومسارُ المستخدم لا يمرّر معرّفًا أصلًا", async () => {
    /**
     * ★ أمانٌ بالبنية لا بالفحص.
     *
     * `usage_totals_self` تشتقّ الهوية من `auth.uid()` داخل القاعدة. فلا
     * وسيطَ يُدسّ فيه معرّف ضحية — لأنه غير موجود.
     */
    const { client, rpcCalls } = fakeDb(10);
    await aggregateUsageEvents(client, { since: "2026-08-01" }, { scope: "self" });
    expect(rpcCalls[0]!.fn).toBe("usage_totals_self");
    expect(Object.keys(rpcCalls[0]!.args)).not.toContain("p_user_id");
  });

  it("★ ★ ★ ومسارُ الإدارة يمرّره — و RLS هو من يحسم", async () => {
    const { client, rpcCalls } = fakeDb(10);
    await aggregateUsageEvents(client, { userId: "victim" }, { scope: "any" });
    expect(rpcCalls[0]!.fn).toBe("usage_totals_for");
    expect(rpcCalls[0]!.args.p_user_id).toBe("victim");
  });

  it("★ ★ ★ وتعذّرُ الدالّة يُعلَن ولا يُلفَّق", async () => {
    /**
     * ★ التوازن الذي استقرّ عليه الأمر.
     *
     * ثلاثةُ سلوكياتٍ ممكنة حين تغيب الدالّة، واثنان منها خطأ:
     *
     *   • مجموعٌ مقصوصٌ بلا علامة ⇒ العطل الأصليّ يعود.
     *   • «—» دائمًا ⇒ مستخدمٌ كان يرى رقمًا يفقده لأننا نشرنا قبل الترحيل.
     *   • مجموعٌ **معلَنٌ** حدًّا أدنى («+») ⇒ سلوك 6C الذي سبق أن شُحن.
     *
     * فالثالث. والعدد دقيقٌ في كل حال.
     */
    const { client } = fakeDb(5000, 9, "m", true);
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.events, "العدد يبقى دقيقًا").toBe(5000);
    expect(agg.unavailable, "ورقمٌ موجودٌ لا «—»").toBe(false);
    expect(agg.tokens).toBe(45_000);
    expect(agg.truncated, "وتحت السقف فهو دقيقٌ بلا «+»").toBe(false);
  });

  it("★ ★ ★ والواجهة تفرّق بين الرقم و«+» و«—»", () => {
    /**
     * ★ ثلاث حالاتٍ لا اثنتان.
     *
     * «+» لم تذهب: هي لغةُ التراجع المُعلَن حين تغيب الدالّة. وما أُضيف هو
     * «—» لحالةٍ ثالثة — تعذّرٌ تامّ لا رقمَ فيه أصلًا. وخلطُ الثلاث في
     * علامةٍ واحدة يجعل إحداها تكذب.
     */
    const view = readSrc("components/usage/usage-view.tsx");
    expect(view).toMatch(/tokensUnavailable/);
    expect(view).toMatch(/tokensApproximate/);
    expect(view).toMatch(/"—"/);
    expect(view).toMatch(/approximate \? "\+" : ""/);
  });

  it("★ ★ ★ وتفصيلُ «لكل نموذج» يحمل عَلَمَ قصٍّ خاصًّا به", async () => {
    /**
     * ★ عَلَمان لا واحد.
     *
     * المجاميع دقيقةٌ دائمًا؛ والتفصيل الإداريّ ما زال مسحًا محدودًا لأن
     * الدالّة لا تُرجع `model_id`. وعَلَمٌ واحد يصف الاثنين يجعل دقيقًا
     * يبدو مقصوصًا — أو الأسوأ، مقصوصًا يبدو دقيقًا.
     */
    const beyond = (USAGE_SCAN.MAX_PAGES + 5) * USAGE_SCAN.PAGE_SIZE;
    const { client } = fakeDb(beyond, 1);
    const agg = await aggregateUsageEvents(client, { userId: "u1" }, { withModels: true });
    expect(agg.unavailable, "المجاميع دقيقة").toBe(false);
    expect(agg.tokens, "ولا تُقصّ").toBe(beyond);
    expect(agg.modelsTruncated, "والتفصيل وحده مقصوص").toBe(true);
  });

  it("★ ★ والعدّ وحده رحلةٌ واحدة", async () => {
    const { client, rangeCalls } = fakeDb(5000);
    const n = await countUsageEvents(client, { userId: "u1" });
    expect(n).toBe(5000);
    expect(rangeCalls).toHaveLength(0);
  });

  it("★ ★ ★ والتفصيل بالنموذج يُجمع كاملًا", async () => {
    const { client } = fakeDb(2500, 4, "ysd/free");
    const agg = await aggregateUsageEvents(client, {}, { withModels: true });
    expect(agg.byModel.get("ysd/free")).toEqual({ requests: 2500, tokens: 10_000 });
  });
});

describe("★ (١′) كل سطحٍ يعرض استهلاكًا يمرّ بالمجمِّع", () => {
  it("★ ★ ★ ولا يبقى جمعٌ من صفوفٍ تُجلب", () => {
    /**
     * ★ العطل كان في خمسة مواضع لا واحد.
     *
     * وإصلاحُ الصفحة التي رآها أحدٌ وحدها يترك الأربعةَ الباقية تكذب بهدوء.
     */
    const surfaces = [
      "app/(app)/usage/page.tsx",
      "app/(app)/account/page.tsx",
      "app/api/admin/users/[id]/route.ts",
      "app/admin/page.tsx",
      "app/api/admin/models/route.ts",
    ];
    for (const f of surfaces) {
      const body = stripComments(readSrc(f));
      expect(body, f).toMatch(/aggregateUsageEvents|countUsageEvents/);
      /** ولا نمطُ «اجلب الصفوف ثم اجمعها» */
      expect(body, f).not.toMatch(
        /from\("usage_events"\)[\s\S]{0,160}\.select\("(model_id, )?input_tokens/,
      );
      expect(body, f).not.toMatch(/usageRows\.(data\s*\?\?\s*\[\])?\.?reduce/);
    }
  });
});

/* ═══════════ (٢) تموضع YSD ═══════════ */

describe("★ (٢) YSD Free و Alpha — أسماءٌ لا تدّعي ملكية", () => {
  it("★ ★ ★ لا «YSD مجاني» ولا «نموذج YSD» في أي اسمٍ معروض", () => {
    /**
     * ★ الاسم يُقرأ ادّعاءً.
     *
     * «YSD مجاني» و«نموذج YSD (ألفا)» يقولان للقارئ إن الأوزان لـYSD. وما
     * تملكه YSD كثيرٌ وحقيقيّ — التشغيل والتوجيه والاسترجاع والأمان — وما
     * لا تملكه نموذجٌ دُرِّب من الصفر.
     */
    for (const f of ["lib/ai/openrouter.ts", "lib/ai/ysd.ts"]) {
      const body = stripComments(readSrc(f));
      expect(body, f).not.toMatch(/displayName(Ar|En):\s*"YSD مجاني"/);
      expect(body, f).not.toMatch(/displayName(Ar|En):\s*"نموذج YSD/);
      expect(body, f).not.toMatch(/displayName(Ar|En):\s*"YSD Model/);
    }
    expect(stripComments(readSrc("lib/ai/openrouter.ts"))).toMatch(
      /displayNameAr:\s*"YSD Free"/,
    );
    expect(stripComments(readSrc("lib/ai/ysd.ts"))).toMatch(/displayNameAr:\s*"YSD Alpha"/);
  });

  it("★ ★ ★ ورسالة التخفيض لا تحمل التسمية القديمة", () => {
    expect(TIER_DOWNGRADE_MESSAGE).not.toContain("YSD مجاني");
    expect(TIER_DOWNGRADE_MESSAGE).toContain("YSD Free");
  });

  it("★ ★ ★ والشرح يقول إن الأوزان مفتوحة ولا يدّعي تدريبًا", () => {
    const values = [...I18N.matchAll(/\b(?:ar|en):\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
    const notes = values.filter((v) => /مفتوحة|open models|open-weight/i.test(v));
    expect(notes.length).toBeGreaterThanOrEqual(3);

    const noteKeys = ["modelNoteFree", "modelNoteAlpha"];
    for (const key of noteKeys) {
      const block = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`, "s");
      expect(I18N, key).toMatch(block);
    }
    for (const claim of [
      "درّبنا",
      "نموذجنا",
      "من الصفر",
      "from scratch",
      "foundation model",
      "our own model",
      "proprietary",
    ]) {
      const block = I18N.slice(I18N.indexOf("modelNoteFree"), I18N.indexOf("reportProblem"));
      expect(block.toLowerCase(), claim).not.toContain(claim.toLowerCase());
    }
  });

  it("★ ★ ★ والمعرّف المكشوف يطابق المعرّف الخادميّ", () => {
    /** نسخةٌ مكشوفة محروسة — لأن `lib/ai/ysd.ts` خادميّ ولا يُستورَد في عميل */
    expect(YSD_ALPHA_MODEL_ID_PUBLIC).toBe(YSD_ALPHA_MODEL_ID);
    expect(modelNoteKey(YSD_FREE_MODEL_ID)).toBe("modelNoteFree");
    expect(modelNoteKey(YSD_ALPHA_MODEL_ID)).toBe("modelNoteAlpha");
    expect(modelNoteKey("some/other")).toBeNull();
    expect(Object.keys(MODEL_NOTE_KEYS)).toHaveLength(2);
  });

  it("★ ★ ★ والقائمة تعرض الشرح تحت الاسم", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/modelNoteKey\(m\.id\)/);
    expect(ui).toMatch(/data-model-note/);
  });

  it("★ ★ ★ ولم يتغيّر توجيهٌ ولا سلسلةُ احتياط", () => {
    /**
     * ★ المرحلة صياغةٌ لا سلوك.
     *
     * المعرّف المنطقيّ والسلسلة وحلّ المزوّد كما هي — وإلا صار «تصحيحُ
     * تسمية» تغييرَ مسارٍ بلا اختبارٍ يخصّه.
     */
    expect(YSD_FREE_MODEL_ID).toBe("ysd/free");
    expect(YSD_ALPHA_MODEL_ID).toBe("ysd/model-alpha");
    const free = readSrc("lib/ai/free-models.ts");
    expect(free).toMatch(/google\/gemma-4-31b-it:free/);
    expect(free).toMatch(/nvidia\/nemotron-3-super-120b-a12b:free/);
    expect(free).toMatch(/openai\/gpt-oss-20b:free/);
  });
});

/* ═══════════ (٣) الإبلاغ عن مشكلة ═══════════ */

describe("★ (٣) بلاغٌ يصل إنسانًا — بلا تسريب", () => {
  it("★ ★ ★ الزرّ موجودٌ ويقود إلى الدعم", () => {
    const ui = stripComments(CHAT_VIEW);
    expect(ui).toMatch(/data-report-problem/);
    expect(ui).toMatch(/href="\/support\?topic=bad-answer"/);
    expect(ui).toMatch(/t\("reportProblem"\)/);
    expect(ui).toMatch(/aria-label=\{t\("reportProblem"\)\}/);
  });

  it("★ ★ ★ ولا إبهامَ لا يُخزَّن", () => {
    /**
     * ★ زرُّ تقييمٍ لا يحفظ شيئًا يُوهم صاحبه أنه أبلغ فيصمت — ولا يُبلَّغ
     * أحد. ولا جدولَ تقييمٍ في هذه المرحلة، فلا زرَّ يدّعيه.
     */
    const ui = stripComments(CHAT_VIEW);
    expect(ui).not.toMatch(/ThumbsUp|ThumbsDown|thumbs/i);
    expect(ui).not.toMatch(/data-feedback-rating/);
  });

  it("★ ★ ★ ولا يحمل الرابط شيئًا من المحادثة", () => {
    /**
     * ★ ما يُوضع في عنوانٍ يُسجَّل في وكلاء وسجلّاتِ خوادم لا نملكها.
     */
    const ui = stripComments(CHAT_VIEW);
    const links = [...ui.matchAll(/href="\/support[^"]*"/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).not.toMatch(/\$\{/);
      expect(link).not.toMatch(/m\.id|conversationId|messageId|modelId|userId|m\.content/);
      expect(link).not.toMatch(/content=|message=|conversation=|user=|model=/);
    }
  });

  it("★ ★ ★ والموضوع رمزٌ من مجموعةٍ مغلقة لا نصٌّ يُعكَس", () => {
    /** نمت القائمة في 6E بموضوع حذف الحساب — والثابت أنها **مغلقة** */
    expect(SUPPORT_TOPICS).toContain("bad-answer");
    expect(SUPPORT_TOPICS.length).toBeLessThanOrEqual(4);
    expect(normalizeSupportTopic("bad-answer")).toBe("bad-answer");
    expect(normalizeSupportTopic("BAD-ANSWER")).toBe("bad-answer");
    for (const bad of [
      "",
      "unknown",
      "<script>alert(1)</script>",
      "bad-answer; drop",
      undefined,
      null,
      42,
      ["bad-answer"],
    ]) {
      expect(normalizeSupportTopic(bad), String(bad)).toBeNull();
    }
  });

  it("★ ★ ★ ولا عنوان دعمٍ مكتوبٍ في الشيفرة", () => {
    for (const f of ["components/chat/chat-view.tsx", "components/support/support-view.tsx"]) {
      const body = stripComments(readSrc(f));
      expect(body, f).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });
});

/* ═══════════ (٤) ترويسات الأمن ═══════════ */

describe("★ (٤) سياسة أمن المحتوى", () => {
  /**
   * ★ الحارس يبني السياسة ويقرؤها — لا يقرأ الشيفرة التي تبنيها.
   *
   * انتقلت في المرحلة 6F من `next.config` إلى `lib/csp.ts` والوسيط، لأن
   * `headers()` تُبنى مرّةً عند البناء فلا تحمل `nonce` يتغيّر مع كل طلب.
   *
   * ولم يعد الحارس يُنقّب عن كتلةٍ نصّية: يستدعي الباني ويقيس **الناتج**.
   * فتعبيرٌ يُطابق مصدرًا يمرّ ولو كان الناتج غير ما يصفه، والناتجُ هو ما
   * يبلغ المتصفّح.
   */
  const prod = () => buildContentSecurityPolicy("TEST_NONCE", { isDev: false });
  const dev = () => buildContentSecurityPolicy("TEST_NONCE", { isDev: true });
  const directive = (policy: string, name: string) =>
    policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("★ ★ ★ التوجيهات عالية القيمة موجودة", () => {
    /**
     * ★ أهمُّ ما في السياسة ليس `script-src`.
     *
     * `base-uri` يمنع وسمًا مزروعًا يعيد توجيه كل رابطٍ نسبيّ في الصفحة،
     * و`object-src` يمنع مُشغّلًا قديمًا، و`frame-ancestors` يمنع سرقة
     * النقر، و`form-action` يمنع تحويل نموذجٍ إلى مضيفٍ غريب.
     */
    const block = prod();
    expect(block).toMatch(/default-src 'self'/);
    expect(block).toMatch(/base-uri 'self'/);
    expect(block).toMatch(/object-src 'none'/);
    expect(block).toMatch(/frame-ancestors 'none'/);
    expect(block).toMatch(/form-action 'self'/);
    expect(block).toMatch(/connect-src 'self'/);
    expect(block).toMatch(/img-src 'self'/);
    expect(block).toMatch(/font-src 'self'/);
    expect(block).toMatch(/style-src 'self'/);
  });

  it("★ ★ ★ ولا حرفٌ عامّ يفتح كل شيء", () => {
    for (const block of [prod(), dev()]) {
      expect(directive(block, "default-src")).not.toMatch(/\*/);
      expect(directive(block, "script-src")).not.toMatch(/\*/);
      /** ونطاقُ المزوّد `*.supabase.co` مقصود — والمفتوح `https:` ليس */
      expect(directive(block, "connect-src")).not.toMatch(/\shttps:\s|\shttps:$/);
      expect(block).not.toMatch(/'unsafe-hashes'/);
    }
  });

  it("★ ★ ★ و`unsafe-eval` للتطوير وحده", () => {
    /** البناء الإنتاجيّ لا يحتاجه — ومنحُه «احتياطًا» ثغرة */
    expect(dev()).toContain("'unsafe-eval'");
    expect(prod()).not.toContain("'unsafe-eval'");
  });

  it("★ ★ ★ ومصادر Supabase محصورةٌ بالمزوّد", () => {
    const block = prod();
    expect(block).toContain("https://*.supabase.co");
    expect(block).toContain("wss://*.supabase.co");
    /** لا نطاقٌ مفتوح مكانها */
    expect(directive(block, "connect-src")).not.toMatch(/\shttps:\s|\shttps:$/);
  });

  it("★ ★ ★ والخطوط من مصدرها المعلوم", () => {
    const block = prod();
    expect(block).toMatch(/style-src[^;"]*https:\/\/fonts\.googleapis\.com/);
    expect(block).toMatch(/font-src[^;"]*https:\/\/fonts\.gstatic\.com/);
  });

  it("★ ★ ★ والترويسات القائمة لم تسقط", () => {
    expect(NEXT_CONFIG).toMatch(/"X-Frame-Options", value: "DENY"/);
    expect(NEXT_CONFIG).toMatch(/"X-Content-Type-Options", value: "nosniff"/);
    expect(NEXT_CONFIG).toMatch(/"Referrer-Policy"/);
    expect(NEXT_CONFIG).toMatch(/"Permissions-Policy"/);
  });

  it("★ ★ ★ ولا إفصاحَ عن الإطار", () => {
    expect(NEXT_CONFIG).toMatch(/poweredByHeader:\s*false/);
  });

  it("★ ★ ★ وHSTS بلا `preload`", () => {
    /**
     * ★ الإدراج المسبق لا يُتراجَع عنه بسهولة ويشترط نطاقًا مملوكًا.
     * والنطاق الحالي فرعٌ على منصّة النشر — فالادّعاء لا يصحّ.
     */
    expect(NEXT_CONFIG).toMatch(/Strict-Transport-Security/);
    /**
     * ★ ويُقاس **قيمة الترويسة** لا الملفّ.
     *
     * الشرح أعلاه يذكر `preload` صراحةً ليقول لماذا لا يُستعمل — وحارسٌ
     * يقرأ التعليق يمنع الشرح نفسه.
     */
    const hsts = /value:\s*"(max-age[^"]*)"/.exec(NEXT_CONFIG);
    expect(hsts, "HSTS value not found").not.toBeNull();
    expect(hsts![1]).toBe("max-age=31536000; includeSubDomains");
    expect(hsts![1]).not.toContain("preload");
  });
});

/* ═══════════ (٥) حدود المعدّل ═══════════ */

describe("★ (٥) الحدود — موزّعة لا في ذاكرة عملية", () => {
  it("★ ★ ★ الرفع والتجهيز والاسترجاع تمرّ بالقاعدة", () => {
    const surfaces: [string, RegExp][] = [
      ["app/api/files/upload/route.ts", /BUCKET_UPLOAD/],
      ["app/api/files/[id]/rag/route.ts", /BUCKET_RAG_RUN/],
      ["app/api/files/[id]/process/route.ts", /BUCKET_RAG_PROCESS/],
    ];
    for (const [f, bucket] of surfaces) {
      const body = stripComments(readSrc(f));
      expect(body, f).toMatch(/consumeRateLimit/);
      expect(body, f).toMatch(bucket);
      /** ولا عودةَ إلى عدّاد الذاكرة */
      expect(body, f).not.toMatch(/from "@\/lib\/rate-limit"/);
    }
  });

  it("★ ★ ★ والقيم لم تُضعَف", () => {
    /**
     * ★ نقلُ العدّاد ليس تخفيفَ الحدّ.
     *
     * تغيير المكان مع رفع الرقم يُخفي توسيعًا داخل إصلاح.
     */
    expect(readSrc("app/api/files/upload/route.ts")).toMatch(/BUCKET_UPLOAD, 10, 60\)/);
    expect(readSrc("app/api/files/[id]/rag/route.ts")).toMatch(/BUCKET_RAG_RUN, 10, 60\)/);
    expect(readSrc("app/api/files/[id]/process/route.ts")).toMatch(/BUCKET_RAG_PROCESS, 15, 60\)/);
  });

  it("★ ★ ★ ومسار تفويض الجهاز لم يعد بلا حدّ", () => {
    const body = stripComments(readSrc("app/api/browser/v1/auth/device/route.ts"));
    const guard = stripComments(readSrc("lib/browser/auth-rate-limit.ts"));
    expect(body).toMatch(/enforceBrowserAuthRateLimits/);
    expect(guard).toMatch(/consumeKeyedRate/);
    expect(body).toMatch(/clientIpFrom\(req\.headers\)/);
    expect(guard).toMatch(/429/);
    expect(guard).toMatch(/Retry-After/);
    /** ولا مفتاحَ يختاره من ينادي */
    expect(body).not.toMatch(/enforceBrowserAuthRateLimits\([^)]*client_id/);
  });

  it("★ ★ ★ ودعوةُ Google لم تعد تثق بأوّل عنصرٍ في `x-forwarded-for`", () => {
    /**
     * ★ ثغرةٌ حقيقية رُصدت في هذه المرحلة.
     *
     * الترويسة تُلحَق لا تُستبدل، فيسارُها بيد العميل. وأخذُ أوّل عنصر يعني
     * دلوًا جديدًا مع كل طلبٍ يكتب فيه المهاجم رقمًا جديدًا — أي لا حدّ.
     * وقد أُصلح المسار في `/api/invite/*` سابقًا وبقي هذا.
     */
    const body = stripComments(readSrc("app/api/auth/google-invite/route.ts"));
    expect(body).toMatch(/clientIpFrom\(req\.headers\)/);
    expect(body).not.toMatch(/x-forwarded-for/);
    expect(body).toMatch(/consumeKeyedRate/);
  });

  it("★ ★ ★ ولا مسارَ عامٍّ يبقى بلا حدّ", () => {
    const publicWriters = [
      "app/api/browser/v1/auth/device/route.ts",
      "app/api/auth/google-invite/route.ts",
      "app/api/invite/claim/route.ts",
      "app/api/invite/verify/route.ts",
    ];
    for (const f of publicWriters) {
      const body = stripComments(readSrc(f));
      expect(body, f).toMatch(/consumeKeyedRate|consumeInviteRate|enforceBrowserAuthRateLimits/);
    }
  });

  it("★ ★ ★ والسرُّ مصدرُه واحد", () => {
    /** اشتقاقان للسرّ يفترقان يوم يُدوَّر أحدهما، فينفتح الحدّ صامتًا */
    const keyed = readSrc("lib/rate-limit-keyed.ts");
    expect(keyed).toMatch(/process\.env\.RATE_LIMIT_HMAC_SECRET/);
    expect(readSrc("lib/auth/invite-guard.ts")).not.toMatch(/createHmac/);
  });
});

/* ═══════════ (٦) ما لم تمسّه هذه المرحلة ═══════════ */

describe("★ (٦) التدريب مجمَّد", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("★ ★ ★ سياسة الجاهزية ومكدّس التشغيل وخطّة التنفيذ كما هي", () => {
    expect(readSrc("lib/training/readiness.ts")).toMatch(/minimumSamples:\s*100/);
    expect(readSrc("lib/training/runtime-stack.ts")).toMatch(/verified:\s*false/);
    expect(readSrc("lib/training/execution-plan.ts")).toMatch(/executable:\s*false/);
  });

  it("★ ★ ★ ولا ترحيلةَ في هذه المرحلة", () => {
    /**
     * الحدّ الموزّع للمسارات العامّة كان قائمًا سلفًا (`0030`) — وما نقص
     * اسمٌ يقول إنه ليس للدعوة وحدها. فلا مخطّطَ جديد.
     */
    const keyed = readSrc("lib/rate-limit-keyed.ts");
    expect(keyed).toMatch(/consume_invite_rate_limit/);
    expect(readSrc("supabase/migrations/0030_distributed_invite_rate_limits.sql")).toMatch(
      /create or replace function public\.consume_invite_rate_limit/,
    );
  });

  it("★ ★ ★ ولا نظامَ دفعٍ أُضيف", () => {
    for (const f of ["components/chat/chat-view.tsx", "components/usage/usage-view.tsx"]) {
      expect(stripComments(readSrc(f)), f).not.toMatch(/stripe|checkout|billing|iap/i);
    }
  });
});
