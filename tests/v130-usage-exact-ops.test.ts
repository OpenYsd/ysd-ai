/**
 * الاستهلاك الدقيق والجاهزية التشغيلية (v0.9.18، المرحلة 6G).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   رقمٌ ناقصٌ يُعرض كأنه تامّ هو العطل الذي أُغلق على مرحلتين. و6C استبدلت
 *   القصَّ الصامت بقصٍّ **مُعلَن** («+»)، وهذه المرحلة تُلغي القصّ نفسه.
 *
 *   وما يجب حراستُه ليس أن الدالّة تُستدعى، بل أن **لا صفَّ يُجلب** للمجاميع:
 *   جلبُ الصفوف هو ما كان يُقصّ، وعودتُه تُعيد العطل بأي اسم.
 *
 * ── والتفويض يُقاس في القاعدة لا هنا ──
 *
 *   `scripts/v130-pg-usage-totals.mjs` يُقمّص الأدوار الحقيقية ويسأل. وما
 *   هنا يحرس ما تراه TypeScript: أن مسار المستخدم لا يمرّر معرّفًا أصلًا.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { aggregateUsageEvents, countUsageEvents, USAGE_RPC, USAGE_SCAN } from "@/lib/usage/aggregate";
import { checkTrainingInvariants } from "@/lib/ops/training-invariants";
import { buildContentSecurityPolicy } from "@/lib/csp";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*|--)/.test(l)).join("\n");

const MIGRATION = readSrc("supabase/migrations/0047_usage_totals_rpc.sql");
const AGGREGATE = readSrc("lib/usage/aggregate.ts");
const RUNBOOK = readSrc("docs/OPERATIONS.md");
const HEALTH_PUBLIC = readSrc("app/api/health/route.ts");
const LIVE = readSrc("app/api/live/route.ts");
const CHECKS = readSrc("lib/health/checks.ts");
const DELETE_ROUTE = readSrc("app/api/account/delete-account/route.ts");

/* ═══════════ (١) الدقّة — بلا سقف ═══════════ */

/**
 * قاعدةٌ وهمية تُميّز مسارين: دالّةُ المجاميع، ومسحُ الصفوف.
 *
 * و`rpcFails` يُطفئ الأولى كي يُقاس التراجع — وهو الوضع الذي تعيشه الشيفرة
 * بين نشرها وتطبيق الترحيل.
 */
function fakeDb(total: number, tokensPerEvent = 1, opts: { rpcFails?: boolean; scanFails?: boolean } = {}) {
  const rangeCalls: [number, number][] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const client: Record<string, unknown> = {
    from() {
      const q: Record<string, unknown> = {};
      let isHead = false;
      Object.assign(q, {
        select: (_c: string, o?: { head?: boolean }) => {
          isHead = o?.head === true;
          return q;
        },
        eq: () => q,
        neq: () => q,
        not: () => q,
        gte: () => q,
        lt: () => q,
        order: () => q,
        range: (from: number, to: number) => {
          rangeCalls.push([from, to]);
          if (opts.scanFails) return Promise.resolve({ data: null, error: { message: "x" } });
          const size = Math.min(to - from + 1, USAGE_SCAN.PAGE_SIZE);
          const available = Math.max(0, Math.min(total - from, size));
          return Promise.resolve({
            data: Array.from({ length: available }, () => ({
              model_id: "m",
              input_tokens: tokensPerEvent,
              output_tokens: 0,
            })),
            error: null,
          });
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(isHead ? { count: total, error: null } : { data: [], error: null }).then(resolve),
      });
      return q;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (opts.rpcFails) return Promise.resolve({ data: null, error: { message: "missing" } });
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
    },
  };
  return { client: client as unknown as SupabaseClient, rangeCalls, rpcCalls };
}

describe("★ (١) الاستهلاك — دقيقٌ بلا سقف", () => {
  /** ★ الأحجام التي كان العطل يختبئ خلفها — وآخرُها ما لم يُبلَغ قطّ */
  const CASES = [0, 999, 1000, 1001, 30_000, 30_001, 100_000];

  for (const total of CASES) {
    it(`★ ★ ★ ${total} حدثًا ⇒ عددٌ ومجموعٌ دقيقان بلا «+»`, async () => {
      const { client } = fakeDb(total, 7);
      const agg = await aggregateUsageEvents(client, { userId: "u1", since: "2026-08-01" });
      expect(agg.events).toBe(total);
      expect(agg.tokens).toBe(total * 7);
      expect(agg.inputTokens).toBe(total * 7);
      expect(agg.outputTokens).toBe(0);
      expect(agg.truncated, "لا «+» على المسار الدقيق").toBe(false);
      expect(agg.unavailable).toBe(false);
    });
  }

  it("★ ★ ★ ولا صفَّ واحدٌ يُجلب للمجاميع", async () => {
    /**
     * ★ هذا هو الحارس الحقيقيّ.
     *
     * جلبُ الصفوف هو ما كان يُقصّ. وعودتُه — بأي اسمٍ وبأي سقف — تُعيد
     * العطل. فيُقاس أن `range()` لم تُستدعَ قطّ.
     */
    const { client, rangeCalls, rpcCalls } = fakeDb(100_000, 3);
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.tokens).toBe(300_000);
    expect(rangeCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(1);
  });

  it("★ ★ ★ والعددُ عدٌّ خادميّ لا طولُ مصفوفة", () => {
    const body = stripComments(AGGREGATE);
    expect(body).toMatch(/count:\s*"exact"/);
    expect(body).toMatch(/head:\s*true/);
    /** وأي عودةٍ إلى `rows.length` تُعيد العطل الأصليّ */
    expect(body).not.toMatch(/events\s*[:=]\s*\w*rows\.length/);
  });

  it("★ ★ ★ و`bigint` يُفحص قبل أن يُصدَّق", async () => {
    /**
     * ★ ما تجاوز `MAX_SAFE_INTEGER` يفقد دقّته صامتًا.
     *
     * بعيدٌ عمليًّا، و«بعيد» ليس «مستحيل». ورقمٌ كاذبٌ لا يُكتشف أسوأ من
     * رقمٍ غائب — فيسقط إلى التراجع المُعلَن لا إلى قيمةٍ مشوّهة.
     */
    const { client } = fakeDb(1, 1);
    (client as unknown as { rpc: unknown }).rpc = () =>
      Promise.resolve({
        data: [{ event_count: 1, input_tokens: Number.MAX_SAFE_INTEGER + 2, output_tokens: 0, total_tokens: 1 }],
        error: null,
      });
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.tokens).not.toBe(Number.MAX_SAFE_INTEGER + 2);
  });
});

/* ═══════════ (٢) التفويض — لا معرّف من المتصفّح ═══════════ */

describe("★ (٢) التفويض — مسارُ المستخدم بلا معرّف", () => {
  it("★ ★ ★ `usage_totals_self` لا تُمرَّر معرّفًا أصلًا", async () => {
    /** أمانٌ بالبنية: لا وسيطَ يُدسّ فيه معرّف ضحية لأنه غير موجود */
    const { client, rpcCalls } = fakeDb(10);
    await aggregateUsageEvents(client, { since: "2026-08-01" }, { scope: "self" });
    expect(rpcCalls[0]!.fn).toBe(USAGE_RPC.self);
    expect(Object.keys(rpcCalls[0]!.args)).not.toContain("p_user_id");
  });

  it("★ ★ ★ وأسطحُ المستخدم تستعمل `self` لا `any`", () => {
    for (const p of ["app/(app)/usage/page.tsx", "app/(app)/account/page.tsx"]) {
      const body = stripComments(readSrc(p));
      expect(body, p).toMatch(/scope:\s*"self"/);
      /** ولا تمرّر `userId` — فحتّى لو أخطأ أحدٌ لاحقًا، الدالّة تتجاهله */
      expect(body, p).not.toMatch(/aggregateUsageEvents\([^)]*userId/s);
    }
  });

  it("★ ★ ★ والدالّتان `security invoker` — لا `definer`", () => {
    /**
     * ★ أهمُّ ثابتٍ في الترحيل.
     *
     * `definer` تتخطّى RLS، فيصير `p_user_id` من المتصفّح بابًا إلى استهلاك
     * غيرك. و`invoker` تجعل التفويض من السياسات المدقَّقة القائمة.
     */
    /**
     * ★ يُعدّ سطرُ التصريح لا ذكرُ العبارة.
     *
     * `comment on function` يشرح الاختيار بنفس الكلمتين، فعدُّ الظهور يخلط
     * الشرح بالتصريح — وهو الحارس الذي يقرأ شرحه بدل شيفرته.
     */
    const declarations = MIGRATION.split("\n").filter((l) => /^security invoker$/.test(l.trim()));
    expect(declarations).toHaveLength(2);
    expect(MIGRATION.split("\n").filter((l) => /^security definer$/.test(l.trim()))).toHaveLength(0);
    /** والترحيل يحرس نفسه: يرفع استثناءً لو صارت `definer` يومًا */
    expect(MIGRATION).toMatch(/must be SECURITY INVOKER/);
  });

  it("★ ★ ★ و`search_path` مثبَّت", () => {
    const body = stripComments(MIGRATION);
    expect((body.match(/set search_path = public, pg_temp/g) ?? []).length).toBe(2);
  });

  it("★ ★ ★ والمجهول لا يُنفّذ — ويُنزع باسمه لا بـ`public` وحده", () => {
    /**
     * ★ فخٌّ كشفه تحقّقُ الترحيل نفسه.
     *
     * منصّةُ Supabase تمنح `anon` تنفيذَ الدوالّ الجديدة **صراحةً**، فنزعُ
     * `public` وحده يتركه قائمًا. ولا يظهر ذلك إلا بسؤال القاعدة.
     */
    const body = stripComments(MIGRATION);
    expect(body).toMatch(/revoke all on function[\s\S]*?from public, anon/);
    expect(body).toMatch(/grant execute on function[\s\S]*?to authenticated, service_role/);
    expect(body).not.toMatch(/grant execute[^;]*to[^;]*\banon\b/);
    expect(MIGRATION).toMatch(/anon must not execute/);
  });

  it("★ ★ ★ ولا مفتاحَ خدمةٍ في مسار المتصفّح", () => {
    expect(stripComments(AGGREGATE)).toMatch(/import "server-only"/);
    expect(stripComments(readSrc("lib/ops/training-invariants.ts"))).toMatch(/import "server-only"/);
  });
});

/* ═══════════ (٣) التراجع — مُعلَنٌ لا كاذب ═══════════ */

describe("★ (٣) التراجع حين تغيب الدالّة", () => {
  it("★ ★ ★ يُعلَن «حدًّا أدنى» ولا يُعرض كأنه دقيق", async () => {
    /**
     * ★ التوازن الذي تحرسه هذه الحالة.
     *
     * الشيفرة قد تُنشر قبل الترحيل. والسقوطُ إلى «—» يُفقد مستخدمًا رقمًا
     * كان يراه؛ والسقوطُ إلى رقمٍ مقصوصٍ بلا علامة يُعيد العطل الأصليّ.
     * فالثالثة: سلوكُ 6C المُعلَن — رقمٌ ومعه «+».
     */
    const beyond = (USAGE_SCAN.MAX_PAGES + 5) * USAGE_SCAN.PAGE_SIZE;
    const { client } = fakeDb(beyond, 1, { rpcFails: true });
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.events, "العدد يبقى دقيقًا").toBe(beyond);
    expect(agg.truncated, "ويُعلَن مقصوصًا").toBe(true);
    expect(agg.unavailable).toBe(false);
    expect(agg.tokens).toBe(USAGE_SCAN.MAX_PAGES * USAGE_SCAN.PAGE_SIZE);
  });

  it("★ ★ ★ وتحت السقف يبقى دقيقًا بلا «+»", async () => {
    const { client } = fakeDb(2500, 2, { rpcFails: true });
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.tokens).toBe(5000);
    expect(agg.truncated).toBe(false);
  });

  it("★ ★ ★ وإن سقط المسح كذلك ⇒ لا رقمَ إطلاقًا", async () => {
    const { client } = fakeDb(2500, 2, { rpcFails: true, scanFails: true });
    const agg = await aggregateUsageEvents(client, { userId: "u1" });
    expect(agg.unavailable).toBe(true);
    expect(agg.tokens).toBe(0);
    expect(agg.events).toBe(2500);
  });

  it("★ ★ ★ والواجهة تفرّق بين «—» و«+» و الرقم", () => {
    const view = readSrc("components/usage/usage-view.tsx");
    expect(view).toMatch(/tokensUnavailable/);
    expect(view).toMatch(/tokensApproximate/);
    expect(view).toMatch(/"—"/);
    /** ولا يُرسم شريطٌ بطول صفرٍ يقول «لم تستهلك شيئًا» */
    expect(view).toMatch(/!unavailable && limit > 0/);
  });
});

/* ═══════════ (٤) الصحة والجاهزية ═══════════ */

describe("★ (٤) الصحة — حياةٌ بلا تبعيات، وجاهزيةٌ بلا إفشاء", () => {
  it("★ ★ ★ `/api/live` لا يلمس تبعيةً", () => {
    /**
     * ★ لو لمسها لأعادت المنصّة تشغيل خادمٍ سليم عند انقطاعٍ خارجيّ عابر —
     * وإعادةُ التشغيل لا تُصلح خدمةً خارجية، بل تقطع الخدمة بلا سبب.
     */
    const body = stripComments(LIVE);
    expect(body).not.toMatch(/createClient|supabase|fetch\(|openrouter|groq/i);
    expect(body).toMatch(/status: "ok"/);
  });

  it("★ ★ ★ وفحصُ المنصّة مربوطٌ بالحياة لا بالجاهزية", () => {
    const railway = JSON.parse(readSrc("railway.json")) as { deploy?: { healthcheckPath?: string } };
    expect(railway.deploy?.healthcheckPath).toBe("/api/live");
  });

  it("★ ★ ★ والجسمُ العامّ عدّادان لا خريطةُ تبعيات", () => {
    /**
     * ★ المسار عامّ بلا مصادقة.
     *
     * وكشفُ حالة كل تبعية يعطي من يريد الضغط خريطةً بأضعف حلقة وتوقيتَها.
     */
    const body = stripComments(HEALTH_PUBLIC);
    expect(body).toMatch(/checks:\s*\{\s*passing,\s*failing\s*\}/);
    expect(body).not.toMatch(/checks:\s*result\.checks/);
  });

  it("★ ★ ★ ولا يُفصح مسارٌ عامّ عن قاعدةٍ ولا مزوّدٍ ولا مفتاح", () => {
    for (const src of [HEALTH_PUBLIC, LIVE]) {
      const body = stripComments(src);
      expect(body).not.toMatch(/SUPABASE|DATABASE_URL|SERVICE_ROLE|OPENROUTER_API_KEY|GROQ/i);
      expect(body).not.toMatch(/error\.message|err\.stack|\.stack\b/);
    }
  });

  it("★ ★ ★ ولا نداءَ توليدٍ مدفوع في أي فحص", () => {
    /**
     * ★ توليدُ رمزٍ واحدٍ للمراقبة حركةٌ مدفوعة تعمل إلى الأبد.
     *
     * وصحّةُ المزوّد تُقرأ من تِلِمترية الطلبات الحقيقية لا من طلبٍ مُصطنع.
     */
    const body = stripComments(CHECKS);
    expect(body).not.toMatch(/chat\/completions|messages\.create|generateText|createCompletion/);
    /** ويُفحص وجودُ المفتاح لا صلاحيتُه بنداء */
    expect(body).toMatch(/orItem\?\.present/);
  });
});

/* ═══════════ (٥) ثوابتُ التدريب — تُعدّ ولا تُصلَح ═══════════ */

function invariantDb(counts: Record<string, number | "error">) {
  let call = 0;
  const order = ["resurrected", "ungated"];
  return {
    from() {
      const key = order[call] ?? "resurrected";
      call += 1;
      const value = counts[key];
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        neq: () => q,
        not: () => q,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            value === "error" ? { count: null, error: { message: "x" } } : { count: value ?? 0, error: null },
          ).then(resolve),
      });
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("★ (٥) ثوابتُ التدريب — تشخيصٌ لا إصلاح", () => {
  it("★ ★ ★ سليمٌ ⇒ لا كسرَ ولا تعذّر", async () => {
    const r = await checkTrainingInvariants(invariantDb({ resurrected: 0, ungated: 0 }));
    expect(r.breaches).toEqual([]);
    expect(r.unavailable).toBe(false);
  });

  it("★ ★ ★ ومرشّحٌ سُحب ثم اعتُمد ⇒ كسرٌ يُبلَّغ", async () => {
    const r = await checkTrainingInvariants(invariantDb({ resurrected: 3, ungated: 0 }));
    expect(r.breaches).toEqual([{ name: "candidate_revoked_became_approved", count: 3 }]);
  });

  it("★ ★ ★ ومعتمَدٌ بلا بوّابة ⇒ كسرٌ يُبلَّغ", async () => {
    const r = await checkTrainingInvariants(invariantDb({ resurrected: 0, ungated: 2 }));
    expect(r.breaches).toEqual([{ name: "candidate_approved_without_gates", count: 2 }]);
  });

  it("★ ★ ★ وتعذّرُ القراءة ليس شهادةَ سلامة", async () => {
    /**
     * ★ صفرٌ يعني «فُحص فلم يُوجد كسر»، والتعذّر يعني «لم يُفحص».
     *
     * والخلطُ بينهما يجعل عطلًا في القراءة يبدو طمأنينة.
     */
    const r = await checkTrainingInvariants(invariantDb({ resurrected: "error", ungated: 0 }));
    expect(r.unavailable).toBe(true);
  });

  it("★ ★ ★ ولا يكتب شيئًا ولا يُصلح", () => {
    const body = stripComments(readSrc("lib/ops/training-invariants.ts"));
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.delete\(|\.upsert\(|\.rpc\(/);
    /** ولا عمليةَ خلفية */
    expect(body).not.toMatch(/setInterval|setTimeout|cron|schedule/i);
  });

  it("★ ★ ★ وهو خارج الشجرة المجمَّدة", () => {
    const files = readdirSync("lib/training");
    expect(files).not.toContain("training-invariants.ts");
    /** والعتبة كما هي */
    expect(stripComments(readSrc("lib/training/readiness.ts"))).toMatch(/minimumSamples:\s*100/);
  });
});

/* ═══════════ (٦) قابليةُ التنبيه والخصوصية ═══════════ */

describe("★ (٦) التنبيه — أبعادٌ آمنة، وحدثٌ باسمٍ ثابت", () => {
  it("★ ★ ★ حذفٌ لم يكتمل يخرج حدثًا منظَّمًا لا سطرَ نصّ", () => {
    const body = stripComments(DELETE_ROUTE);
    expect(body).toMatch(/logger\.error\(\{/);
    expect(body).toMatch(/event: "account_delete_incomplete"/);
    expect(body).toMatch(/correlation:/);
    /** ولا console.error يبتلعه سجلٌّ غير منظَّم */
    expect(body).not.toMatch(/console\.error/);
  });

  it("★ ★ ★ ولا هويّةَ في الحدث", () => {
    /**
     * ★ سجلٌّ يحمل هويّةً يصير هو نفسه تسريبًا يوم يُصدَّر إلى خدمةٍ خارجية.
     */
    const body = stripComments(DELETE_ROUTE);
    const logCall = /logger\.error\(\{[\s\S]*?\}\);/.exec(body)?.[0] ?? "";
    expect(logCall).not.toMatch(/user\.id|email|storage_path|user_id/);
  });

  it("★ ★ ★ والمُسجِّل يقبل حقولًا معيَّنة فقط", () => {
    const body = stripComments(readSrc("lib/logger.ts"));
    expect(body).toMatch(/redactLogValue/);
    expect(body).not.toMatch(/message\?:\s*string|content\?:\s*string|prompt\?:/);
  });
});

/* ═══════════ (٧) الدليل — لا يَعِد بما لم يُثبت ═══════════ */

describe("★ (٧) دليلُ التشغيل — صدقُه هو قيمته", () => {
  it("★ ★ ★ موجودٌ ويغطّي ما طُلب", () => {
    for (const section of [
      "البنية", "نقاط الفحص", "التراجع", "إجراءُ الترحيل",
      "حذفُ حسابٍ لم يكتمل", "تجميدُ التدريب", "النسخ الاحتياطي",
      "جاهزيةُ الاستعادة", "قائمةُ الحادثة", "التنبيه",
    ]) {
      expect(RUNBOOK, section).toContain(section);
    }
  });

  it("★ ★ ★ ولا يدّعي نسخًا ولا استعادةً مُثبتة", () => {
    /**
     * ★ هذا هو الحارس الأهمّ في القسم.
     *
     * دليلٌ يقول «مُؤمَّن» وهو ليس كذلك يُطمئن وقتَ الحاجة إلى اليقظة —
     * ويُكتشف كذبُه يوم لا ينفع الاكتشاف.
     */
    expect(RUNBOOK).toMatch(/غير مُتحقَّق/);
    expect(RUNBOOK).toMatch(/NOT TESTED/);
    expect(RUNBOOK).not.toMatch(/نسخٌ احتياطيّ يوميّ مُفعَّل|التعافي مُجرَّب|backups are enabled/i);
  });

  it("★ ★ ★ ويفصل بين وجودِ الآليّة وثبوتِ وصولها", () => {
    /**
     * ★ تغيّر الواقع فتغيّر الحارس — وهذا صوابٌ لا تساهل.
     *
     * صارت في المرحلة 6H مراقبةٌ منفَّذة، فادّعاءُ «لا تنبيهَ اليوم» كذبٌ
     * في الاتجاه المقابل. والثابت المحروس أدقُّ: أن الوثيقة تفصل بين
     * **الآليّة** (منفَّذة) و**وصولِ التنبيه** (غير مُتحقَّق) — فمن قرأها
     * لا يظنّ أن أحدًا سيُخبره وهو لم يُخبَر أحدٌ بعد.
     */
    expect(RUNBOOK).toMatch(/production-health\.yml/);
    expect(RUNBOOK).toMatch(/وصولُ التنبيه — \*\*غير مُتحقَّق\*\*/);
    expect(RUNBOOK).toMatch(/ما زال ناقصًا/);
  });

  it("★ ★ ★ ويذكّر بتجميد التدريب وبألّا تُرمَّم الحالات", () => {
    expect(RUNBOOK).toMatch(/لا تُعدّل عدّادًا كي يبدو متّسقًا/);
    expect(RUNBOOK).toMatch(/لا تُشغّل GPU/);
    expect(RUNBOOK).toMatch(/الحالات الراهنة صحيحةٌ ولا تُرمَّم/);
  });

  it("★ ★ ★ ويفرّق بين تراجع الشيفرة وتراجع القاعدة", () => {
    expect(RUNBOOK).toMatch(/تراجعُ الشيفرة ليس تراجعَ القاعدة/);
  });

  it("★ ★ ★ ولا يحمل سرًّا ولا بريدًا شخصيًّا", () => {
    expect(RUNBOOK).not.toMatch(/eyJhbGciOi|sk-[a-z0-9]{10}|SERVICE_ROLE_KEY\s*=/);
    const emails = RUNBOOK.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
    for (const e of emails) expect(e).toMatch(/ysd\.ai\.support@gmail\.com/);
  });
});

/* ═══════════ (٨) ما لم تمسّه هذه المرحلة ═══════════ */

describe("★ (٨) الحدود القائمة", () => {
  it("★ ★ ★ الترحيل ضيّقٌ ولا يمسّ بيانات", () => {
    const body = stripComments(MIGRATION);
    expect(body).not.toMatch(/insert into|update |delete from|drop table|alter table/i);
    /** ولا فهرسَ جديد: `idx_usage_user_period` القائم يكفي — وأُثبت بـEXPLAIN */
    expect(body).not.toMatch(/create index/i);
  });

  it("★ ★ ★ و0046 كما هو", () => {
    const mig = readSrc("supabase/migrations/0046_legal_bundle_2026_08_21.sql");
    expect(mig).toContain(`'"2026-08-21"'::jsonb`);
    expect(mig).toContain("key = 'terms_version'");
  });

  it("★ ★ ★ وترقيمُ الترحيلات فريدٌ و0047 قائم", () => {
    const versions = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, f.indexOf("_")));
    const legacyNums = versions.filter((v) => v.length === 4).map(Number);
    expect(legacyNums).toContain(46);
    expect(legacyNums).toContain(47);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("★ ★ ★ وترتيبُ حذف الحساب لم يُمَسّ — الهوية آخرًا", () => {
    const body = stripComments(readSrc("lib/account/delete-account.ts"));
    expect(body.indexOf("purgeUserData")).toBeLessThan(body.indexOf("admin.deleteUser"));
    expect(body).toMatch(/storageRemainder > 0/);
  });

  it("★ ★ ★ وسياسةُ المحتوى لم تُرخَ للمراقبة", () => {
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    expect(policy).toMatch(/script-src [^;]*'nonce-N'/);
    expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it("★ ★ ★ ولا استهلاكَ مُلفّق يُكتب من الشيفرة", () => {
    /**
     * ★ إدراجُ أحداثٍ للاختبار في الإنتاج يُفسد الحدود والفوترة معًا.
     */
    const body = stripComments(AGGREGATE);
    expect(body).not.toMatch(/\.insert\(|\.upsert\(/);
  });
});

/* ═══════════ (٩) عدُّ الأحداث وحده ═══════════ */

describe("★ (٩) العدّ", () => {
  it("★ ★ العدّ رحلةٌ واحدة بلا صفوف", async () => {
    const { client, rangeCalls } = fakeDb(5000);
    const n = await countUsageEvents(client, { userId: "u1" });
    expect(n).toBe(5000);
    expect(rangeCalls).toHaveLength(0);
  });

  it("★ ★ وتعثّرُ العدّ يعطي صفرًا لا قمامة", async () => {
    const client = {
      from: () => {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          gte: () => q,
          lt: () => q,
          then: (r: (v: unknown) => unknown) =>
            Promise.resolve({ count: null, error: { message: "x" } }).then(r),
        });
        return q;
      },
    } as unknown as SupabaseClient;
    expect(await countUsageEvents(client, { userId: "u1" })).toBe(0);
  });
});
