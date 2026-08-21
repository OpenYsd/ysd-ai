/**
 * ضوابط البيانات وإصدار الوثائق (v0.9.16، المرحلة 6E).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   حذفٌ يقول «تمّ» ولم يتمّ أسوأ من حذفٍ يفشل، وقبولُ شروطٍ يُعيد إذنًا
 *   سُحب خيانةٌ لقرارٍ اتّخذه صاحبه.
 *
 * فالمسار القديم كان يُطلق ستّ عمليات حذف ولا يقرأ نتيجة واحدة، ثم يردّ
 * `ok: true` دائمًا. ومن فشل حذفُه كلّه يمضي مطمئنًّا إلى شيءٍ لم يقع.
 *
 * وقبولُ الشروط والإذن بالتدريب نظامان منفصلان — ولا يُثبت الفصلَ تعليقٌ
 * بل اختبارٌ يمرّ على المسار ويقيس ما لمسه.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { buildContentSecurityPolicy } from "@/lib/csp";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider, type Locale } from "@/lib/i18n";
import { ThemeProvider } from "@/components/theme";
import { ShellProvider } from "@/components/shell/shell-context";
import { DataControls } from "@/components/settings/data-controls";
import { SupportView } from "@/components/support/support-view";
import {
  normalizeSupportTopic,
  readSupportContact,
  SUPPORT_TOPICS,
} from "@/lib/public-support";
import {
  LEGAL_BUNDLE_VERSION,
  LEGAL_PREVIOUS_VERSION,
  LEGAL_VERSION_MIGRATION,
} from "@/lib/legal";
import { PURGE_CATEGORIES, PURGE_RETAINED, purgeUserData } from "@/lib/account/purge";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
/** ويُسقط الاستيراد: مسارُ وحدةٍ ليس نصًّا معروضًا */
const stripImports = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(import|export)\b.*from\s/.test(l) && !/^\s*import\s/.test(l)).join("\n");

const PURGE_ROUTE = readSrc("app/api/account/purge-data/route.ts");
const PURGE_LIB = readSrc("lib/account/purge.ts");
const REVOKE_LIB = readSrc("lib/account/revoke-training.ts");
const CONSENT_ROUTE = readSrc("app/api/training-consent/route.ts");
const CONSENT_API = readSrc("app/api/consent/route.ts");
const MIGRATION = readSrc(`supabase/migrations/${LEGAL_VERSION_MIGRATION}`);
const CONTROLS = readSrc("components/settings/data-controls.tsx");

afterEach(cleanup);

/* ═══════════ (١) الحذف يفشل مغلقًا ═══════════ */

/**
 * قاعدةٌ وهمية: كل عملية تنجح إلا ما يُطلب إفشالُه بالاسم.
 * والعدّ بعد الحذف يعود صفرًا — كما يعود في قاعدةٍ حقيقية.
 */
type Op = { table: string; kind: string; filters: [string, unknown][] };

function fakeDb(opts: { failOn?: string; remaining?: number; storageFails?: boolean } = {}) {
  const touched: string[] = [];
  /** ★ كلُّ عمليةٍ تُسجَّل بنوعها وبما قُيّدت به — لا باسم جدولها وحده */
  const ops: Op[] = [];
  const err = (t: string) => (opts.failOn === t ? { code: "XX000" } : null);

  const client = {
    from(table: string) {
      touched.push(table);
      const op: Op = { table, kind: "read", filters: [] };
      ops.push(op);
      const q: Record<string, unknown> = {};
      let isCount = false;
      Object.assign(q, {
        select: (_c: string, o?: { head?: boolean }) => {
          isCount = o?.head === true;
          if (o?.head === true) op.kind = "count";
          return q;
        },
        update: () => {
          op.kind = "update";
          return q;
        },
        delete: () => {
          op.kind = "delete";
          return q;
        },
        eq: (col: string, val: unknown) => {
          op.filters.push([col, val]);
          return q;
        },
        in: () => q,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            isCount
              ? { count: opts.remaining ?? 0, error: err(table) }
              : table === "files"
                ? { data: [{ storage_path: "u/1/f/a.pdf" }], error: err(table) }
                : { data: [], error: err(table) },
          ).then(resolve),
      });
      return q;
    },
    storage: {
      from: () => ({
        remove: async () => ({ error: opts.storageFails ? { message: "x" } : null }),
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, touched, ops };
}

const training = { consentRevoked: true, revokedCandidates: 0 };
vi.mock("@/lib/account/revoke-training", () => ({
  revokeTrainingForUser: vi.fn(async () => training),
}));

describe("★ (١) الحذف — يفشل مغلقًا", () => {
  beforeEach(() => {
    training.consentRevoked = true;
    training.revokedCandidates = 0;
  });

  it("★ ★ ★ المسار السليم يمرّ ويُبلّغ", async () => {
    const { client } = fakeDb();
    const r = await purgeUserData(client, "u1");
    expect(r.ok).toBe(true);
    expect(r.trainingConsentRevoked).toBe(true);
  });

  for (const step of ["rag_jobs", "file_chunks", "files", "conversations", "projects"]) {
    it(`★ ★ ★ تعثّرُ «${step}» ⇒ لا يُقال «تمّ»`, async () => {
      /**
       * ★ العطل الذي كان.
       *
       * ستُّ عمليات بلا قراءةِ نتيجةٍ واحدة، ثم `ok: true` دائمًا. ومن فشل
       * حذفُه يمضي مطمئنًّا إلى شيءٍ لم يقع — وهو أسوأ من رسالة فشل.
       */
      const { client } = fakeDb({ failOn: step });
      const r = await purgeUserData(client, "u1");
      expect(r.ok).toBe(false);
      expect(r.failedAt).toBeDefined();
    });
  }

  it("★ ★ ★ وبقاءُ صفٍّ بعد الحذف ⇒ لا يُقال «تمّ»", () => {
    /** لا يكفي أن تُقبل الأوامر، بل أن يبقى صفرٌ */
    expect(stripComments(PURGE_LIB)).toMatch(/if \(remaining > 0\) return fail\("verification"\)/);
  });

  it("★ ★ ★ وتعثّرُ التخزين يُعدّ ولا يُبتلع", async () => {
    const { client } = fakeDb({ storageFails: true });
    const r = await purgeUserData(client, "u1");
    expect(r.ok).toBe(true);
    expect(r.storageRemainder).toBeGreaterThan(0);
  });

  it("★ ★ ★ وإعادةُ الحذف على حسابٍ محويّ آمنة", async () => {
    /** لا شيء ليُحذف، فيمرّ كلُّ أمرٍ بلا أثر ويبقى التحقّق صفرًا */
    const { client } = fakeDb();
    const first = await purgeUserData(client, "u1");
    const second = await purgeUserData(client, "u1");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

/* ═══════════ (٢) الحذف يسحب إذن التدريب ═══════════ */

describe("★ (٢) الحذف يسحب إذن التدريب — بنفس التسلسل", () => {
  it("★ ★ ★ يُستدعى التسلسل المشترك لا نسخةٌ ثانية منه", async () => {
    const mod = await import("@/lib/account/revoke-training");
    const spy = vi.mocked(mod.revokeTrainingForUser);
    spy.mockClear();
    const { client } = fakeDb();
    await purgeUserData(client, "u1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe("u1");
  });

  it("★ ★ ★ وقبل أي حذف — لا بعده", async () => {
    /** الإذن هو البوّابة التي تُغلق المستقبل؛ وإغلاقُها بعد الكنس يترك ثغرة */
    const body = stripComments(PURGE_LIB);
    expect(body.indexOf("revokeTrainingForUser")).toBeLessThan(body.indexOf('from("rag_jobs")'));
  });

  it("★ ★ ★ والتسلسل واحدٌ يشترك فيه مساران", () => {
    expect(stripComments(CONSENT_ROUTE)).toMatch(/revokeTrainingForUser\(supabase, ctx\.userId\)/);
    expect(stripComments(PURGE_LIB)).toMatch(/revokeTrainingForUser\(db, userId\)/);
    /** ولا نسخةَ ثانية من الكنسة في أيٍّ منهما */
    for (const src of [CONSENT_ROUTE, PURGE_LIB]) {
      expect(stripComments(src)).not.toMatch(/purgeArtifactsForUser|revokeUserCandidates/);
    }
  });

  it("★ ★ ★ والترتيب داخل التسلسل: إذنٌ ثم كنسٌ ثم محو", () => {
    const body = stripComments(REVOKE_LIB);
    expect(body.indexOf("setTrainingConsent")).toBeLessThan(body.indexOf("revokeUserCandidates"));
    expect(body.indexOf("revokeUserCandidates")).toBeLessThan(
      body.indexOf("purgeArtifactsForUser"),
    );
  });

  it("★ ★ ★ ولا يمتدّ الحذف إلى بيانات غيره", async () => {
    /**
     * ★ الحارس ينفّذ المسار ويقرأ ما قُيّدت به كلُّ عملية.
     *
     * فحذفٌ يفقد `.eq("user_id", …)` يبقى نصُّه سليمًا ويقرأ اسمَ الجدول
     * نفسه — ويمحو جداول المستخدمين كلَّهم. والمقيس هنا ليس أن القيد
     * **مكتوب** بل أنه **مُطبَّق** على كل كتابةٍ وكل تحقّق.
     */
    const { client, ops } = fakeDb();
    await purgeUserData(client, "u1");

    const writes = ops.filter((o) => o.kind !== "read");
    expect(writes.length).toBeGreaterThanOrEqual(6);
    for (const op of writes) {
      const scope = op.filters.find(([c]) => c === "user_id");
      expect(scope, `${op.kind} على «${op.table}» بلا قيد مالك`).toBeDefined();
      expect(scope![1]).toBe("u1");
    }
    /** وقراءةُ مسارات التخزين كذلك — فهي التي تُبنى منها أوامر المحو */
    for (const op of ops.filter((o) => o.table === "files")) {
      expect(op.filters.some(([c, v]) => c === "user_id" && v === "u1")).toBe(true);
    }
  });

  it("★ ★ ★ ولا يُنشئ ولا يعتمد شيئًا", () => {
    /** الحذف فعلُ إزالة — ولا يجوز أن يخلق مرشّحًا ولا يعتمد واحدًا */
    for (const src of [PURGE_LIB, REVOKE_LIB, PURGE_ROUTE]) {
      const body = stripComments(src);
      expect(body).not.toMatch(/createTrainingCandidate|decideTrainingCandidate|approve/i);
      expect(body).not.toMatch(/createDatasetArtifact|createDatasetDraft|freezeDatasetRelease/);
    }
  });
});

/* ═══════════ (٣) أمن المسار ═══════════ */

describe("★ (٣) المسار — هوّيةٌ من الجلسة وحدها", () => {
  it("★ ★ ★ لا `user_id` من الجسم ولا من الاستعلام", () => {
    /** ولو قُبل لَصار المسار بابًا لمحو بيانات غيرك بمعرّفٍ مخمّن */
    const body = stripComments(PURGE_ROUTE);
    expect(body).toMatch(/auth\.getUser\(\)/);
    expect(body).toMatch(/purgeUserData\(supabase, user\.id\)/);
    expect(body).not.toMatch(/body\.user_id|searchParams\.get\("user|parsed\.data\.userId/);
    expect(body).toMatch(/z\.object\(\{ confirm: z\.literal\("DELETE"\) \}\)/);
  });

  it("★ ★ ★ و`POST` لا `GET` — ولا فعلَ مدمّرٍ خلف زيارةِ رابط", () => {
    const body = stripComments(PURGE_ROUTE);
    expect(body).toMatch(/export async function POST/);
    expect(body).not.toMatch(/export async function GET/);
  });

  it("★ ★ ★ وفحصُ الأصل دفاعٌ ثانٍ خلف SameSite", () => {
    const body = stripComments(PURGE_ROUTE);
    expect(body).toMatch(/headers\.get\("origin"\)/);
    expect(body).toMatch(/new URL\(origin\)\.host === host/);
    expect(body).toMatch(/403/);
  });

  it("★ ★ ★ ولا اسم جدولٍ ولا مسار تخزينٍ يصل المتصفّح", () => {
    const body = stripComments(PURGE_ROUTE);
    /** الرمز يُسجَّل ولا يُعرض */
    expect(body).toMatch(/console\.error\(`\[purge\] incomplete step=/);
    /**
     * ★ الحارس على ما **يُعرض** لا على ما يُكتب.
     *
     * فمسارُ الاستيراد `"@/lib/supabase/server"` نصٌّ في الملفّ لا يبلغ
     * المتصفّح، وحارسٌ يقرؤه يشتكي من اسمٍ لا يراه أحد. والمقيس هنا:
     * ما قد يُرسَل في جسم الردّ.
     */
    const shown = stripImports(body).match(/"[^"\n]{20,}"/g) ?? [];
    for (const s of shown) {
      expect(s).not.toMatch(/supabase|postgres|storage_path|select |delete from|rag_jobs|file_chunks/i);
    }
  });
});

/* ═══════════ (٤) واجهة الضوابط ═══════════ */

function mount(locale: Locale = "ar") {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>
        <ShellProvider>
          <DataControls />
        </ShellProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const text = () => document.body.textContent ?? "";
const openDialog = () => {
  fireEvent.click(document.querySelector("[data-open-purge]") as HTMLElement);
};

describe("★ (٤) الواجهة — بابان قبل فعلٍ لا رجعة فيه", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal("location", { assign: vi.fn(), href: "" } as unknown as Location);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("★ ★ ★ الإجراءان معروضان ومسمّيان بدقّة", () => {
    mount();
    expect(text()).toContain("حذف بياناتي");
    expect(text()).toContain("طلب حذف الحساب بالكامل");
    /** ولا يُسمّى «حذف الحساب» — لأن حساب الدخول لا يُحذف بهذا الإجراء */
    expect(document.querySelector("[data-open-purge]")!.textContent).not.toContain("حذف الحساب");
  });

  it("★ ★ ★ وحذفُ الحساب يقود إلى الدعم لا إلى فعلٍ هنا", () => {
    mount();
    const link = document.querySelector("[data-request-account-deletion]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/support?topic=account-deletion");
    /** ولا بريدَ ولا معرّفَ في العنوان */
    expect(link.getAttribute("href")).not.toMatch(/@|user|id=|email/);
  });

  it("★ ★ ★ والشرح يطابق ما ينفّذه المسار فعلًا", () => {
    /**
     * ★ قائمةُ ما يُحذف ليست زينة.
     *
     * فمن قرأ «تُحذف ملفاتك» ثم بقيت، أو قرأ صمتًا عن إذن التدريب ثم بقي
     * ساريًا — كلاهما وعدٌ لم يُوفَ.
     */
    mount();
    openDialog();
    const shown = text();
    expect(shown).toContain("المحادثات والرسائل");
    expect(shown).toContain("المشاريع");
    expect(shown).toContain("الملفات المرفوعة");
    expect(shown).toContain("يُسحب إذن المساهمة");
    /** وما يبقى يُقال */
    expect(shown).toContain("حساب تسجيل الدخول نفسه لا يُحذف");
    expect(shown).toContain("عدّادات الاستهلاك تبقى");
    expect(PURGE_CATEGORIES.length).toBe(4);
    expect(PURGE_RETAINED).toContain("signInAccount");
  });

  it("★ ★ ★ ولا ادّعاءَ محوٍ من كل نسخة احتياطية", () => {
    mount();
    openDialog();
    expect(text()).toContain("لا يمكن التراجع عن حذف هذه البيانات من داخل YSD");
    for (const claim of ["نسخة احتياطية", "إلى الأبد", "من كل مكان", "forever"]) {
      expect(text(), claim).not.toContain(claim);
    }
  });

  it("★ ★ ★ والتأكيد يحتاج كتابة العبارة", async () => {
    mount();
    openDialog();
    const confirm = document.querySelector("[data-purge-confirm]") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = document.querySelector("[data-purge-confirm-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "احذف" } });
    });
    expect((document.querySelector("[data-purge-confirm]") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("العبارة غير مطابقة");

    await act(async () => {
      fireEvent.change(input, { target: { value: "حذف بياناتي" } });
    });
    expect((document.querySelector("[data-purge-confirm]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("★ ★ ★ والعبارة بلغة الواجهة", () => {
    /** مطالبةُ قارئ العربية بكتابة `DELETE MY DATA` حاجزٌ لغويّ لا تأكيد */
    mount("en");
    openDialog();
    expect(text()).toContain("DELETE MY DATA");
    expect(text()).not.toMatch(/[؀-ۿ]/);
  });

  it("★ ★ ★ ولا فراغَ يُقبل تأكيدًا", async () => {
    mount();
    openDialog();
    const input = document.querySelector("[data-purge-confirm-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "   " } });
    });
    expect((document.querySelector("[data-purge-confirm]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("★ ★ ★ ولا إرسالَ مكرّر", async () => {
    mount();
    openDialog();
    const input = document.querySelector("[data-purge-confirm-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "حذف بياناتي" } });
    });
    const btn = document.querySelector("[data-purge-confirm]") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(calls.length).toBe(1);
  });

  it("★ ★ ★ والطلب يحمل التأكيد وحده — لا هوّية", async () => {
    mount();
    openDialog();
    const input = document.querySelector("[data-purge-confirm-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "حذف بياناتي" } });
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-purge-confirm]") as HTMLElement);
    });
    const call = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(call[0]).toBe("/api/account/purge-data");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(String(call[1].body))).toEqual({ confirm: "DELETE" });
  });

  it("★ ★ ★ والفشل يُقال ولا يُدّعى نجاح", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 503 })),
    );
    mount();
    openDialog();
    const input = document.querySelector("[data-purge-confirm-input]") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "حذف بياناتي" } });
    });
    await act(async () => {
      fireEvent.click(document.querySelector("[data-purge-confirm]") as HTMLElement);
    });
    expect(text()).toContain("لم نعتبر العملية مكتملة");
  });

  it("★ ★ ★ والحوار حوارٌ فعلًا", () => {
    mount();
    openDialog();
    const dialog = document.querySelector("[data-purge-dialog]")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("[data-purge-dialog]")).toBeNull();
  });
});

/* ═══════════ (٥) إصدار الوثائق ═══════════ */

describe("★ (٥) الحزمة القانونية", () => {
  it("★ ★ ★ الإصدار الجديد غير القديم", () => {
    expect(LEGAL_BUNDLE_VERSION).toBe("2026-08-21");
    expect(LEGAL_PREVIOUS_VERSION).toBe("2026-07-15");
    expect(LEGAL_BUNDLE_VERSION).not.toBe(LEGAL_PREVIOUS_VERSION);
  });

  it("★ ★ ★ والمعروض يطابق ما يفرضه الترحيل — فلا انحراف", () => {
    /**
     * ★ كانت النسخة مكتوبةً في ثلاثة مواضع.
     *
     * فيسهل أن يُبدَّل أحدها ويبقى الباقي يعرض تاريخًا مضى — ووثيقةٌ تعرض
     * نسخةً والقاعدة تفرض غيرها تجعل القبول موقّعًا على غير ما قُرئ.
     */
    for (const doc of ["app/(auth)/privacy/page.tsx", "app/(auth)/terms/page.tsx"]) {
      const src = readSrc(doc);
      expect(src, doc).toMatch(/LEGAL_BUNDLE_VERSION/);
      expect(src, doc).not.toMatch(/النسخة: 20\d\d-\d\d-\d\d/);
    }
    expect(MIGRATION).toContain(`'"${LEGAL_BUNDLE_VERSION}"'::jsonb`);
    expect(MIGRATION).toContain(`'"${LEGAL_PREVIOUS_VERSION}"'::jsonb`);
  });

  it("★ ★ ★ والترحيل قارن-ثمّ-اضبط — يُعاد بلا أثر", () => {
    expect(MIGRATION).toMatch(/where key = 'terms_version'/);
    expect(MIGRATION).toMatch(/and value = '"2026-07-15"'::jsonb/);
    expect(MIGRATION).toMatch(/update public\.platform_settings/);
  });

  it("★ ★ ★ ولا يمسّ الترحيل موافقةً ولا تدريبًا ولا إعدادًا آخر", () => {
    /**
     * ★ الموافقة فعلٌ صريح من صاحبها.
     *
     * وكتابتُها نيابةً عنه تجعل الوثيقة موقّعةً بلا موقّع — وهو ما يمنعه
     * هذا الحارس نصًّا لا نيّة.
     */
    const sql = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/user_consents/);
    expect(sql).not.toMatch(/training_/);
    expect(sql).not.toMatch(/allow_registration|require_invite|maintenance_mode|usage_limits/);
    expect(sql).not.toMatch(/create table|alter table|drop /i);
    /** ولا يلمس إعدادًا غير هذا */
    const updates = sql.match(/update public\.platform_settings[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(1);
  });

  it("★ ★ ★ ولا قبولَ تلقائيّ لأحد", () => {
    /** القبول يحتاج فعلًا صريحًا — والمسار يكتب للمستخدم الحالي وحده */
    const api = stripComments(CONSENT_API);
    expect(api).toMatch(/user_id: ctx\.userId/);
    expect(api).not.toMatch(/from\("profiles"\)[\s\S]{0,120}select/);
    expect(api).toMatch(/export async function POST/);
    expect(api).not.toMatch(/export async function GET/);
    /** والنسخة من الخادم لا من العميل */
    expect(api).toMatch(/eq\("key", "terms_version"\)/);
    expect(api).not.toMatch(/body[\s\S]{0,40}version/);
  });

  it("★ ★ ★ ورقم الترحيل فريد", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    const nums = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(nums).size).toBe(nums.length);
    expect(files).toContain(LEGAL_VERSION_MIGRATION);
  });
});

/* ═══════════ (٦) الفصل بين القبول والتدريب ═══════════ */

describe("★ (٦) قبولُ الشروط ليس إذنًا بالتدريب", () => {
  it("★ ★ ★ مسار القبول لا يمسّ التدريب بحرف", () => {
    /**
     * ★ الفصل مطلق.
     *
     * ومن سحب إذنه ثم قَبِل شروطًا جديدة لم يُعِد إذنه — قَبِل وثيقةً. وخلطُ
     * الاثنين يجعل القبول بابًا خلفيًّا يُعيد ما سُحب.
     */
    const api = stripComments(CONSENT_API);
    expect(api).not.toMatch(/training/i);
    expect(api).toMatch(/user_consents/);

    const form = stripComments(readSrc("components/auth/accept-terms-form.tsx"));
    expect(form).not.toMatch(/training-consent|setTrainingConsent|training_consents/);
    /** ولا ينادي إلا مسار الموافقة */
    const fetches = form.match(/fetch\("([^"]+)"/g) ?? [];
    expect(fetches).toEqual(['fetch("/api/consent"']);
  });

  it("★ ★ ★ ولا يُنشئ مرشّحًا ولا يستعيد أثرًا", () => {
    const api = stripComments(CONSENT_API);
    for (const forbidden of [
      "createTrainingCandidate",
      "training_candidates",
      "training_dataset_artifacts",
      "purgeArtifactsForUser",
      "revokeUserCandidates",
    ]) {
      expect(api, forbidden).not.toContain(forbidden);
    }
  });

  it("★ ★ ★ وبوّابة القبول تقرأ `user_consents` وحدها", () => {
    const gate = stripComments(readSrc("lib/auth/consent.ts"));
    expect(gate).toMatch(/user_consents/);
    expect(gate).toMatch(/terms_version/);
    expect(gate).not.toMatch(/training/i);
  });
});

/* ═══════════ (٧) موضوع الدعم ═══════════ */

describe("★ (٧) موضوع حذف الحساب", () => {
  it("★ ★ ★ مقبولٌ في القائمة المغلقة", () => {
    expect(SUPPORT_TOPICS).toContain("account-deletion");
    expect(normalizeSupportTopic("account-deletion")).toBe("account-deletion");
    expect(normalizeSupportTopic("ACCOUNT-DELETION")).toBe("account-deletion");
  });

  it("★ ★ ★ وما سواه يُهمَل بلا انعكاس", () => {
    for (const bad of [
      "delete-account",
      "<script>alert(1)</script>",
      "account-deletion; drop",
      "",
      null,
      42,
    ]) {
      expect(normalizeSupportTopic(bad), String(bad)).toBeNull();
    }
  });

  it("★ ★ ★ وصفحةُ الدعم تعرض نصًّا من القاموس لا ما وصلها", () => {
    render(
      <I18nProvider initialLocale="ar">
        <SupportView contact={readSupportContact("")} topic="account-deletion" />
      </I18nProvider>,
    );
    const banner = document.querySelector('[data-support-topic="account-deletion"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("طلب حذف الحساب بالكامل");
    expect(banner!.textContent).toContain("لا تُرسل كلمة مرورك");
  });

  it("★ ★ وبالإنجليزية", () => {
    render(
      <I18nProvider initialLocale="en">
        <SupportView contact={readSupportContact("")} topic="account-deletion" />
      </I18nProvider>,
    );
    const banner = document.querySelector('[data-support-topic="account-deletion"]')!;
    expect(banner.textContent).toContain("Requesting full account deletion");
    expect(banner.textContent).not.toMatch(/[؀-ۿ]/);
  });
});

/* ═══════════ (٨) ما لم تمسّه هذه المرحلة ═══════════ */

describe("★ (٨) الحدود القائمة", () => {
  it("★ ★ ★ لا حذفَ لحساب المصادقة ولا مفتاح خدمةٍ في المتصفّح", () => {
    for (const src of [PURGE_ROUTE, PURGE_LIB, REVOKE_LIB, CONTROLS]) {
      const body = stripComments(src);
      expect(body).not.toMatch(/auth\.admin|deleteUser|SERVICE_ROLE/);
      expect(body).not.toMatch(/from\("auth\.users"\)|auth\.users/);
    }
  });

  it("★ ★ ★ وسياسةُ الأمن والحدود والتدريب كما هي", () => {
    /**
     * ★ الحارس يتبع السياسة حيث انتقلت (المرحلة 6F).
     *
     * كانت تُبنى في `next.config.mjs`، وصارت في `lib/csp.ts` لأن `headers()`
     * تُبنى مرّةً عند البناء فلا تحمل `nonce` يتغيّر مع كل طلب.
     *
     * والثابت المحروس هو هو، بل أقوى: يُبنى الناتج ويُقاس — لا يُنقَّب عن
     * سطرٍ في مصدرٍ قد يصفُ ما لا يفعله.
     */
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/default-src \*/);
    expect(policy).toMatch(/script-src [^;]*'nonce-N'/);
    expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(stripComments(readSrc("next.config.mjs"))).toMatch(/poweredByHeader:\s*false/);
    expect(stripComments(readSrc("app/api/files/upload/route.ts"))).toMatch(
      /BUCKET_UPLOAD, 10, 60\)/,
    );
    expect(stripComments(readSrc("lib/training/readiness.ts"))).toMatch(/minimumSamples:\s*100/);
    expect(stripComments(readSrc("lib/usage/aggregate.ts"))).toMatch(
      /count:\s*"exact",\s*head:\s*true/,
    );
  });
});
