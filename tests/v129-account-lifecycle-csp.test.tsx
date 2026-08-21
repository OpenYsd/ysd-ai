/**
 * دورةُ حياة الحساب و`nonce` سياسة المحتوى (v0.9.17، المرحلة 6F).
 *
 * ── ما يحرسه هذا الملفّ ──
 *
 *   حذفُ هويةٍ قبل محو تخزينها يترك بايتاتٍ بلا مفتاحٍ يصل إليها أحد. وهذا
 *   لا يُكتشف بالنظر: كلُّ شيءٍ يبدو ناجحًا، والصفوف ذهبت، والملفّات باقية
 *   في دلوٍ لا يعرف أحدٌ ما فيه.
 *
 *   فالترتيب هنا ليس أناقة — هو الأمان كلُّه. ويُقاس بتنفيذ المسار وقراءة
 *   ما وقع بأي ترتيب، لا بقراءة تعليقٍ يعد به.
 *
 * ── و`nonce` ثابتٌ ليس nonce ──
 *
 *   بل كلمةُ سرٍّ يقرؤها أوّلُ من يفتح «مصدر الصفحة» ثم يوقّع بها ما يشاء.
 *   فالحارس يطلب اثنين ويتأكّد أنهما افترقا.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
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
import {
  buildContentSecurityPolicy,
  generateNonce,
  CSP_HEADER,
  NONCE_HEADER,
} from "@/lib/csp";
import { deleteAccountForUser, type IdentityAdmin } from "@/lib/account/delete-account";

const readSrc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src: string) =>
  src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

const DELETE_LIB = readSrc("lib/account/delete-account.ts");
const DELETE_ROUTE = readSrc("app/api/account/delete-account/route.ts");
const MIDDLEWARE = readSrc("middleware.ts");
const NEXT_CONFIG = readSrc("next.config.mjs");
const CONTROLS = readSrc("components/settings/data-controls.tsx");

afterEach(cleanup);

/* ═══════════ (١) الترتيب — الهوية آخرًا ═══════════ */

/**
 * قاعدةٌ وهمية تُسجّل **كل** ما يقع بترتيب وقوعه.
 *
 * ولا تقيس الأسماء بل اللحظات: أيُّ خطوةٍ سبقت أيّها. فحارسٌ يقرأ أن
 * `deleteUser` مكتوبٌ بعد `remove` لا يُثبت أنه يُنفَّذ بعده.
 */
function tracedDb(opts: { storageFails?: boolean; failOn?: string } = {}) {
  const log: string[] = [];
  const err = (t: string) => (opts.failOn === t ? { code: "XX000" } : null);

  const client = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let kind = "read";
      let isCount = false;
      Object.assign(q, {
        select: (_c: string, o?: { head?: boolean }) => {
          isCount = o?.head === true;
          if (!isCount) log.push(`select:${table}`);
          return q;
        },
        update: () => {
          kind = "update";
          log.push(`update:${table}`);
          return q;
        },
        delete: () => {
          kind = "delete";
          log.push(`delete:${table}`);
          return q;
        },
        eq: () => q,
        in: () => q,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(
            isCount
              ? { count: 0, error: null }
              : table === "files" && kind === "read"
                ? { data: [{ storage_path: "u/1/f/a.pdf" }], error: err(table) }
                : { data: [], error: err(table) },
          ).then(resolve),
      });
      return q;
    },
    storage: {
      from: () => ({
        remove: async () => {
          log.push("storage:remove");
          return { error: opts.storageFails ? { message: "x" } : null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, log };
}

function tracedAdmin(log: string[], fails = false): IdentityAdmin {
  return {
    deleteUser: async (id: string) => {
      log.push(`identity:delete:${id}`);
      return { error: fails ? { message: "boom" } : null };
    },
  };
}

const training = { consentRevoked: true, revokedCandidates: 0 };
vi.mock("@/lib/account/revoke-training", () => ({
  revokeTrainingForUser: vi.fn(async () => {
    (globalThis as { __ysdLog?: string[] }).__ysdLog?.push("training:revoke");
    return training;
  }),
}));

describe("★ (١) الترتيب — الهوية تُحذف آخرًا", () => {
  it("★ ★ ★ سحبُ إذن التدريب ⇐ التخزين ⇐ الصفوف ⇐ الهوية", async () => {
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const r = await deleteAccountForUser(client, tracedAdmin(log), "u1");

    expect(r.ok).toBe(true);
    expect(r.identityDeleted).toBe(true);

    const at = (needle: string) => log.findIndex((l) => l.startsWith(needle));
    /** ★ الإذن أوّلًا — يُغلق المستقبل قبل أن يُمسّ الماضي */
    expect(at("training:revoke")).toBeGreaterThanOrEqual(0);
    expect(at("training:revoke")).toBeLessThan(at("storage:remove"));
    /** ★ والتخزين قبل الهوية — فصفوفُ الملفّات تحمل المسارات وتذهب معها */
    expect(at("storage:remove")).toBeLessThan(at("identity:delete"));
    expect(at("delete:conversations")).toBeLessThan(at("identity:delete"));
    /** ★ والهوية آخرُ ما يقع، بلا استثناء */
    expect(at("identity:delete")).toBe(log.length - 1);
  });

  it("★ ★ ★ وتعثّرُ التخزين يمنع حذف الهوية", async () => {
    /**
     * ★ العطل الذي يُمنع هنا.
     *
     * صفوفُ الملفّات حُذفت، فالمسارات الباقية لا يعرفها أحد. ولو مضينا إلى
     * حذف الهوية لصار في الدلو بايتاتٌ بلا مالكٍ ولا مفتاح — ولا رجعة.
     */
    const { client, log } = tracedDb({ storageFails: true });
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const r = await deleteAccountForUser(client, tracedAdmin(log), "u1");

    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe("storage_remainder");
    expect(r.identityDeleted).toBe(false);
    expect(log.some((l) => l.startsWith("identity:delete"))).toBe(false);
  });

  for (const step of ["rag_jobs", "file_chunks", "files", "conversations", "projects"]) {
    it(`★ ★ ★ وتعثّرُ «${step}» يمنعها كذلك`, async () => {
      const { client, log } = tracedDb({ failOn: step });
      (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
      const r = await deleteAccountForUser(client, tracedAdmin(log), "u1");
      expect(r.ok).toBe(false);
      expect(r.failedAt).toBe("purge");
      expect(log.some((l) => l.startsWith("identity:delete"))).toBe(false);
    });
  }

  it("★ ★ ★ وبلا عميل خدمةٍ لا يُقال «تمّ»", async () => {
    /** حذفٌ بلا هويةٍ محذوفة ليس حذفَ حساب — والفشل مغلق */
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const r = await deleteAccountForUser(client, null, "u1");
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe("identity_unavailable");
    expect(r.identityDeleted).toBe(false);
  });

  it("★ ★ ★ وتعثّرُ حذف الهوية نفسها لا يُقال عنه نجاح", async () => {
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const r = await deleteAccountForUser(client, tracedAdmin(log, true), "u1");
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe("identity");
    expect(r.identityDeleted).toBe(false);
  });

  it("★ ★ ★ والنجاح يستلزم ذهابَ الهوية — لا شيء أقلّ", async () => {
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const r = await deleteAccountForUser(client, tracedAdmin(log), "u1");
    expect(r.ok && r.identityDeleted).toBe(true);
    /** ولا يُرجع `ok` صحيحًا وذاك خاطئ في أي فرع */
    const body = stripComments(DELETE_LIB);
    expect(body).toMatch(/ok:\s*true,\s*identityDeleted:\s*true/);
    expect(body).not.toMatch(/ok:\s*true,\s*identityDeleted:\s*false/);
  });

  it("★ ★ ★ وإعادةُ المحاولة على حسابٍ نُظّف آمنة", async () => {
    /** لا شيء ليُحذف، فيمرّ كلُّ أمرٍ بلا أثر ويبقى التحقّق صفرًا */
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    const first = await deleteAccountForUser(client, tracedAdmin(log), "u1");
    const second = await deleteAccountForUser(client, tracedAdmin(log), "u1");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("★ ★ ★ ولا يُحذف غيرُ صاحب الجلسة", async () => {
    const { client, log } = tracedDb();
    (globalThis as { __ysdLog?: string[] }).__ysdLog = log;
    await deleteAccountForUser(client, tracedAdmin(log), "u1");
    expect(log).toContain("identity:delete:u1");
    expect(log.some((l) => l.startsWith("identity:delete") && !l.endsWith(":u1"))).toBe(false);
  });
});

/* ═══════════ (٢) المسار — هوّيةٌ من الجلسة وحدها ═══════════ */

describe("★ (٢) المسار — لا معرّف من المتصفّح", () => {
  it("★ ★ ★ الهوية من `auth.getUser` لا من الجسم", () => {
    const body = stripComments(DELETE_ROUTE);
    expect(body).toMatch(/await supabase\.auth\.getUser\(\)/);
    expect(body).toMatch(/deleteAccountForUser\(supabase, admin, user\.id\)/);
    /** ولا قراءةَ معرّفٍ من جسمٍ ولا استعلام */
    expect(body).not.toMatch(/body\.user_id|searchParams\.get\("user|parsed\.data\.userId/);
  });

  it("★ ★ ★ ومعرّفٌ في الجسم لا يُغيّر من يُحذف", async () => {
    /**
     * ★ الحارس ينفّذ المسار ويقرأ **من حُذف** — لا أن السطر مكتوب.
     *
     * كشفت طفرةٌ أن الحارس النصّي كان يمرّ حين يُوسَّع المخطّط بحقل
     * `userId`: لا شيء يقرؤه بعد، والسطرُ التالي الذي يقرؤه على بُعد سطر.
     * فصار المقيس: أُرسل معرّف ضحيةٍ في الجسم، ثم أُسأل عمّن ذهب فعلًا.
     */
    const captured: string[] = [];
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: "session-owner" } } }),
          signOut: async () => ({ error: null }),
        },
      }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({ getAdminClient: () => ({ auth: { admin: {} } }) }));
    vi.doMock("@/lib/account/delete-account", () => ({
      deleteAccountForUser: async (_db: unknown, _admin: unknown, userId: string) => {
        captured.push(userId);
        return { ok: true, identityDeleted: true, trainingConsentRevoked: true, revokedCandidates: 0 };
      },
    }));

    const { POST } = await import("@/app/api/account/delete-account/route");
    const req = new Request("https://ysd.test/api/account/delete-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE_ACCOUNT", userId: "victim", user_id: "victim" }),
    });
    const res = await POST(req as never);

    expect(res.status).toBe(200);
    /** ★ صاحبُ الجلسة هو من ذهب — لا من سمّاه الجسم */
    expect(captured).toEqual(["session-owner"]);
    expect(captured).not.toContain("victim");

    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/supabase/admin");
    vi.doUnmock("@/lib/account/delete-account");
    vi.resetModules();
  });

  it("★ ★ ★ وبلا جلسةٍ لا يُحذف شيء", async () => {
    const called: string[] = [];
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => ({ error: null }) },
      }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({ getAdminClient: () => null }));
    vi.doMock("@/lib/account/delete-account", () => ({
      deleteAccountForUser: async (_d: unknown, _a: unknown, id: string) => {
        called.push(id);
        return { ok: true, identityDeleted: true, trainingConsentRevoked: true, revokedCandidates: 0 };
      },
    }));

    const { POST } = await import("@/app/api/account/delete-account/route");
    const res = await POST(
      new Request("https://ysd.test/api/account/delete-account", {
        method: "POST",
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT", userId: "victim" }),
      }) as never,
    );

    expect(res.status).toBe(401);
    expect(called).toEqual([]);

    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/supabase/admin");
    vi.doUnmock("@/lib/account/delete-account");
    vi.resetModules();
  });

  it("★ ★ ★ وتأكيدٌ أقوى من تأكيد «حذف بياناتي»", () => {
    /**
     * ★ فعلان مختلفان في الأثر يجب أن يختلفا في الكلمة.
     *
     * فمن حفظ تأكيد الأخفّ لا يمرّ به الأثقل بلا قراءة.
     */
    const body = stripComments(DELETE_ROUTE);
    expect(body).toMatch(/z\.literal\("DELETE_ACCOUNT"\)/);
    const purge = stripComments(readSrc("app/api/account/purge-data/route.ts"));
    expect(purge).toMatch(/z\.literal\("DELETE"\)/);
    expect(purge).not.toMatch(/z\.literal\("DELETE_ACCOUNT"\)/);
  });

  it("★ ★ ★ وفحصُ الأصل قائم", () => {
    const body = stripComments(DELETE_ROUTE);
    expect(body).toMatch(/headers\.get\("origin"\)/);
    expect(body).toMatch(/new URL\(origin\)\.host === host/);
    expect(body).toMatch(/403/);
  });

  it("★ ★ ★ ولا مفتاحَ خدمةٍ يبلغ المتصفّح", () => {
    /** `lib/supabase/admin` عليها `server-only` — واستيرادُها من عميلٍ خطأُ بناء */
    expect(stripComments(readSrc("lib/supabase/admin.ts"))).toMatch(/import "server-only"/);
    expect(stripComments(DELETE_LIB)).toMatch(/import "server-only"/);
    expect(stripComments(CONTROLS)).not.toMatch(/SERVICE_ROLE|getAdminClient/);
    /** والمكوّن يخاطب مسارًا فقط */
    expect(stripComments(CONTROLS)).toMatch(/fetch\(flow\.endpoint/);
  });

  it("★ ★ ★ ولا اسم جدولٍ ولا مسار تخزينٍ يصل المتصفّح", () => {
    const body = stripComments(DELETE_ROUTE);
    /**
     * ★ الحارس يتبع الرمز حيث انتقل (المرحلة 6G).
     *
     * كان يخرج سطرَ نصٍّ بـ`console.error`، وصار حدثًا منظَّمًا باسمٍ ثابت
     * كي يصلح بُعدًا لتنبيه. والثابت المحروس هو هو: الرمز **يُسجَّل** ولا
     * **يُعرض** — واسمُ الجدول لا يبلغ المتصفّح.
     */
    expect(body).toMatch(/event: "account_delete_incomplete"/);
    expect(body).toMatch(/logger\.error\(\{/);
    const shown = body
      .split("\n")
      .filter((l) => !/^\s*(import|export)\b.*from\s/.test(l))
      .join("\n")
      .match(/"[^"\n]{20,}"/g) ?? [];
    for (const s of shown) {
      expect(s).not.toMatch(/supabase|postgres|storage_path|select |delete from|rag_jobs|file_chunks/i);
    }
  });
});

/* ═══════════ (٣) التدريب — يُسحب ولا يُرمَّم ═══════════ */

describe("★ (٣) التدريب — سحبٌ بالتسلسل المشترك", () => {
  it("★ ★ ★ يُعاد استعمال تسلسل 6E لا نسخةٌ ثانية منه", () => {
    const body = stripComments(DELETE_LIB);
    /** الحذف يستدعي `purgeUserData` وهو من يستدعي التسلسل — فلا ثالث */
    expect(body).toMatch(/purgeUserData\(db, userId\)/);
    expect(body).not.toMatch(/setTrainingConsent|revokeUserCandidates|purgeArtifactsForUser/);
  });

  it("★ ★ ★ ولا يُنشئ ولا يعتمد ولا يستعيد شيئًا", () => {
    for (const src of [DELETE_LIB, DELETE_ROUTE]) {
      const body = stripComments(src);
      expect(body).not.toMatch(/createTrainingCandidate|decideTrainingCandidate|approve/i);
      expect(body).not.toMatch(/createDatasetArtifact|createDatasetDraft|freezeDatasetRelease/);
      expect(body).not.toMatch(/status:\s*"(ready|approved|frozen|pending)"/);
      /** ولا يُعيد إذنًا سُحب */
      expect(body).not.toMatch(/enabled:\s*true|revoked_at:\s*null/);
    }
  });

  it("★ ★ ★ ولا يمسّ عتبةَ الجاهزية ولا المجموعات ولا المهامّ", () => {
    for (const src of [DELETE_LIB, DELETE_ROUTE]) {
      const body = stripComments(src);
      expect(body).not.toMatch(/minimumSamples|readiness|training_dataset|training_jobs/);
    }
    /** والعتبة نفسها كما هي */
    expect(stripComments(readSrc("lib/training/readiness.ts"))).toMatch(/minimumSamples:\s*100/);
  });

  it("★ ★ ★ والأثرُ التاريخيّ يُوصف بصدق: غيرُ صالح لا ممحوّ", () => {
    /**
     * ★ ولا يُوعَد بما لا نملك.
     *
     * ما دخل إصدارًا مجمَّدًا لا يُمحى أثرُه من السجلّ — لكنه يصير مرجعًا
     * غير صالح. وقولُ ذلك أصدق من وعدٍ بمحوٍ كاملٍ لا يقع.
     */
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    const note = container.querySelector("[data-historical-note]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toMatch(/غير صالحة/);
    expect(note!.textContent).not.toMatch(/تُمحى نهائيًا|من كل نسخة/);
  });
});

/* ═══════════ (٤) الواجهة — بابان لا يُخلط بينهما ═══════════ */

function renderControls(locale: Locale) {
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

describe("★ (٤) الواجهة — فعلان، لكلٍّ بابه", () => {
  it("★ ★ ★ زرّان منفصلان لا زرٌّ واحد", () => {
    const { container } = renderControls("ar");
    expect(container.querySelector("[data-open-purge]")).not.toBeNull();
    expect(container.querySelector("[data-open-delete-account]")).not.toBeNull();
  });

  it("★ ★ ★ و«حذف بياناتي» يقول صراحةً إن الحساب يبقى", () => {
    /**
     * ★ الحارس على الاسم **والوعد** معًا.
     *
     * فإعادةُ تسمية الأخفّ باسم الأثقل تجعل من أراد تنظيف محادثاته يظنّ
     * أنه يفقد حسابه — أو العكس، وهو أسوأ.
     */
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-purge]")!);
    const dialog = container.querySelector("[data-purge-dialog]")!;
    expect(dialog.getAttribute("data-purge-mode")).toBe("data");
    expect(dialog.textContent).toMatch(/حساب تسجيل الدخول نفسه لا يُحذف/);
    expect(dialog.textContent).not.toMatch(/لن تستطيع الدخول بعدها/);
  });

  it("★ ★ ★ و«حذف الحساب» يقول إن الدخول يذهب", () => {
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    const dialog = container.querySelector("[data-purge-dialog]")!;
    expect(dialog.getAttribute("data-purge-mode")).toBe("account");
    expect(dialog.textContent).toMatch(/لن تستطيع الدخول بعدها/);
    expect(dialog.textContent).toMatch(/لا يمكن التراجع/);
  });

  it("★ ★ ★ والعبارتان مختلفتان — لا تفتح إحداهما الأخرى", () => {
    const { container, unmount } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-purge]")!);
    const dataPhrase = container.querySelector("[data-purge-dialog] code")!.textContent;
    unmount();

    const second = renderControls("ar");
    fireEvent.click(second.container.querySelector("[data-open-delete-account]")!);
    const accountPhrase = second.container.querySelector("[data-purge-dialog] code")!.textContent;

    expect(dataPhrase).toBe("حذف بياناتي");
    expect(accountPhrase).toBe("حذف حسابي نهائيًا");
    expect(dataPhrase).not.toBe(accountPhrase);
  });

  it("★ ★ ★ والعبارة بلغة الواجهة", () => {
    /** مطالبةُ من يقرأ العربية بكتابة إنجليزيةٍ حاجزٌ لغويّ لا حاجزُ تأكيد */
    const { container } = renderControls("en");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    expect(container.querySelector("[data-purge-dialog] code")!.textContent).toBe(
      "DELETE MY ACCOUNT",
    );
  });

  it("★ ★ ★ وعبارةٌ خاطئة لا تُرسل شيئًا", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    const input = container.querySelector("[data-purge-confirm-input]")!;
    fireEvent.change(input, { target: { value: "حذف بياناتي" } });
    const btn = container.querySelector("[data-purge-confirm]") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("★ ★ ★ والعبارة الصحيحة تُرسل التأكيد الأقوى", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    fireEvent.change(container.querySelector("[data-purge-confirm-input]")!, {
      target: { value: "حذف حسابي نهائيًا" },
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-purge-confirm]")!);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/account/delete-account");
    expect(String(init.body)).toContain("DELETE_ACCOUNT");
    /** ولا معرّفَ مستخدمٍ في الجسم */
    expect(String(init.body)).not.toMatch(/user_id|userId/);
    vi.unstubAllGlobals();
  });

  it("★ ★ ★ ولا إرسالَ مكرّر", async () => {
    /**
     * ★ الحارس مرجعٌ لا حالة.
     *
     * ثلاث ضغطاتٍ في دورةٍ واحدة تقرأ `phase` كلُّها القيمة القديمة لأن
     * React لم يُعد الرسم بينها — فيمرّ ثلاثةُ طلباتِ حذف حساب.
     */
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderControls("ar");
    fireEvent.click(container.querySelector("[data-open-delete-account]")!);
    fireEvent.change(container.querySelector("[data-purge-confirm-input]")!, {
      target: { value: "حذف حسابي نهائيًا" },
    });
    const btn = container.querySelector("[data-purge-confirm]")!;
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("★ ★ ★ وبعد الحذف لا تُقصد صفحةٌ محميّة", () => {
    /**
     * ★ الهوية ذهبت — فقصدُ `/chat` تحويلٌ إلى `/login` من حسابٍ لا وجود له.
     */
    const body = stripComments(CONTROLS);
    expect(body).toMatch(/mode === "account" \? "\/" : "\/chat"/);
  });

  it("★ ★ ★ وطريقُ الدعم يبقى لمن لا يستطيع الدخول", () => {
    /** فمن فقد الوصول لا يبلغ الزرّ، وإزالةُ الطريق الآخر تتركه بلا سبيل */
    const { container } = renderControls("ar");
    const link = container.querySelector("[data-request-account-deletion]");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/support?topic=account-deletion");
  });
});

/* ═══════════ (٥) `nonce` — لكل طلبٍ واحد ═══════════ */

describe("★ (٥) سياسة المحتوى — nonce لكل طلب", () => {
  it("★ ★ ★ nonceان متتاليان يفترقان", () => {
    /** ★ ثابتٌ يُقرأ من مصدر الصفحة ثم يُوقَّع به — وهو أسوأ من لا شيء */
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) seen.add(generateNonce());
    expect(seen.size).toBe(64);
  });

  it("★ ★ ★ وفيه عشوائيةٌ كافية", () => {
    const n = generateNonce();
    /** ١٦ بايتًا في base64 = ٢٤ محرفًا */
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(n, "base64").length).toBe(16);
  });

  it("★ ★ ★ ولا يُشتقّ من وقتٍ ولا من `Math.random`", () => {
    const body = stripComments(readSrc("lib/csp.ts"));
    expect(body).toMatch(/crypto\.getRandomValues/);
    expect(body).not.toMatch(/Math\.random|Date\.now|performance\.now/);
  });

  it("★ ★ ★ والسياسة تحمل الـnonce الذي أُعطيت", () => {
    const policy = buildContentSecurityPolicy("ABC123", { isDev: false });
    expect(policy).toMatch(/script-src [^;]*'nonce-ABC123'/);
  });

  it("★ ★ ★ ولا `unsafe-inline` في `script-src` بالإنتاج", () => {
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    const script = policy.split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).toContain("'self'");
  });

  it("★ ★ ★ و`unsafe-eval` للتطوير وحده", () => {
    expect(buildContentSecurityPolicy("N", { isDev: true })).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy("N", { isDev: false })).not.toContain("'unsafe-eval'");
  });

  it("★ ★ ★ ولم تُرخَ التوجيهات عالية القيمة", () => {
    for (const isDev of [true, false]) {
      const policy = buildContentSecurityPolicy("N", { isDev });
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("base-uri 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("form-action 'self'");
    }
  });

  it("★ ★ ★ و`style-src` يُقال عنه صراحةً إنه لم يُحكَم", () => {
    /** الهدف هنا تنفيذُ الشيفرة لا التنسيق — وإيحاءُ الإحكام الكامل كذب */
    const policy = buildContentSecurityPolicy("N", { isDev: false });
    expect(policy).toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(readSrc("lib/csp.ts")).toMatch(/style-src`? يبقى|لم يُحكَم|ما زال فيه/);
  });
});

/* ═══════════ (٦) التمرير — الطلب والاستجابة يتّفقان ═══════════ */

describe("★ (٦) التمرير — الوسيط يوقّع الطلب والاستجابة معًا", () => {
  it("★ ★ ★ الـnonce يُولَّد في الوسيط لكل طلب", () => {
    const body = stripComments(MIDDLEWARE);
    expect(body).toMatch(/const nonce = generateNonce\(\)/);
    expect(body).toMatch(/const csp = buildContentSecurityPolicy\(nonce\)/);
  });

  it("★ ★ ★ ويُوضع في ترويسة **الطلب** ليقرأه Next", () => {
    /**
     * ★ هذا هو ما يجعل وسوم Next تحمل الـnonce.
     *
     * فالإطار يقرأ `content-security-policy` من الطلب ويستخرجه. وبلا هذا
     * السطر تخرج السياسة على الاستجابة والوسومُ بلا توقيع — أي صفحةٌ بيضاء
     * بلا JavaScript.
     */
    const body = stripComments(MIDDLEWARE);
    expect(body).toMatch(/requestHeaders\.set\(CSP_HEADER, csp\)/);
    expect(body).toMatch(/requestHeaders\.set\(NONCE_HEADER, nonce\)/);
    expect(CSP_HEADER).toBe("content-security-policy");
    expect(NONCE_HEADER).toBe("x-nonce");
  });

  it("★ ★ ★ وعلى الاستجابة كذلك — وبنفس القيمة", () => {
    /** وافتراقُهما يعني صفحةً يرفض المتصفّح تنفيذ سكربتاتها */
    const body = stripComments(MIDDLEWARE);
    expect(body).toMatch(/r\.headers\.set\("Content-Security-Policy", csp\)/);
    /** ولا تُبنى سياسةٌ ثانية بـnonce آخر */
    expect((body.match(/buildContentSecurityPolicy\(/g) ?? []).length).toBe(1);
  });

  it("★ ★ ★ ولا تُضبط السياسة مرّتين", () => {
    /**
     * ★ ترويستا CSP تُنفَّذان معًا، فتصير السياسة الفعلية تقاطعَهما.
     *
     * ويقرأ الفاحص `'unsafe-inline'` في إحداهما فيظنّ الحماية أضعف ممّا هي
     * — أو أقوى. وواحدةٌ أصدق من اثنتين.
     */
    expect(stripComments(NEXT_CONFIG)).not.toMatch(/Content-Security-Policy/);
    expect(stripComments(NEXT_CONFIG)).not.toMatch(/script-src|default-src/);
  });

  it("★ ★ ★ وبقيّةُ الترويسات لم تسقط", () => {
    const cfg = stripComments(NEXT_CONFIG);
    expect(cfg).toMatch(/"X-Frame-Options", value: "DENY"/);
    expect(cfg).toMatch(/"X-Content-Type-Options", value: "nosniff"/);
    expect(cfg).toMatch(/Strict-Transport-Security/);
    expect(cfg).toMatch(/poweredByHeader:\s*false/);
  });
});

/* ═══════════ (٧) المخطّط — ما يعتمد عليه الحذف ═══════════ */

describe("★ (٧) المخطّط — التعاقب مكتوبٌ في الترحيل لا مفترَض", () => {
  const MIG_0001 = readSrc("supabase/migrations/0001_init.sql");

  it("★ ★ ★ `profiles` يتعاقب من `auth.users`", () => {
    /**
     * ★ هذا هو المفصل كلُّه.
     *
     * الحذف يعتمد أن ذهاب الهوية يُذهب الملفّ الشخصي، وأن ذهابه يُذهب ما
     * تحته. ولو صار `on delete set null` لبقي كلُّ شيءٍ بلا مالك.
     */
    expect(MIG_0001).toMatch(/id uuid primary key references auth\.users\(id\) on delete cascade/);
  });

  it("★ ★ ★ والجداول المملوكة تتعاقب من `profiles`", () => {
    for (const table of ["conversations", "projects", "files"]) {
      const m = new RegExp(
        `create table ${table} \\([\\s\\S]{0,400}?user_id uuid not null references profiles\\(id\\) on delete cascade`,
      );
      expect(MIG_0001, `${table} cascade`).toMatch(m);
    }
  });

  it("★ ★ ★ والتخزين لا يتعاقب — فمحوُه صريحٌ وقبل الهوية", () => {
    /**
     * ★ أُثبت على PostgreSQL حقيقي: لا مفتاح من `storage.objects` إلى
     * الهوية (`scripts/v129-pg-account-cascade.mjs`). فالبايتات لا تذهب
     * بالتعاقب، ومحوُها يقع صراحةً — وقبل أن تذهب الصفوف الحاملة لمساراتها.
     */
    const body = stripComments(DELETE_LIB);
    expect(body).toMatch(/storageRemainder > 0/);
    expect(body.indexOf("storageRemainder")).toBeLessThan(body.indexOf("admin.deleteUser"));
  });

  it("★ ★ ★ ولم يُنشأ ترحيلٌ جديد لهذه المرحلة", () => {
    /**
     * ★ الثابت: لا ترحيلَ لتناسقِ تاريخٍ معروض — ولا تكرار في الترقيم.
     *
     * وكان الحارس يملك «أحدث رقم» فسقط مع 0047، لا لأن شيئًا انكسر بل لأن
     * المشروع تقدّم. وملكيةُ الأحدث تنتقل إلى أحدث مجموعة، والثابتُ هنا أن
     * 0046 قائمٌ وأن الترقيم فريد.
     */
    const { readdirSync, readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    const nums = files.map((f) => Number(f.slice(0, 4)));
    expect(nums).toContain(46);
    expect(new Set(nums).size).toBe(nums.length);
    /** ولا ترحيلَ يمسّ نصّ الوثيقة أو تاريخَ قسمها */
    for (const f of files) {
      if (Number(f.slice(0, 4)) <= 46) continue;
      expect(rf(`supabase/migrations/${f}`, "utf8")).not.toMatch(/terms_version|آخر تحديث/);
    }
  });
});

/* ═══════════ (٨) التاريخ القانونيّ — مُشتقٌّ لا مكتوب ═══════════ */

describe("★ (٨) التاريخ القانونيّ — مصدرٌ واحد", () => {
  it("★ ★ ★ قسمُ الإفصاح يشتقّ تاريخه من إصدار الحزمة", () => {
    /**
     * ★ تاريخان ينجرفان.
     *
     * كان القسم يقول `2026-08-20` والحزمة `2026-08-21` — فيقرأ القارئ
     * وثيقةً تقول إن قسمها أقدم من نفسها. والمصدر واحدٌ الآن.
     */
    const privacy = stripComments(readSrc("app/(auth)/privacy/page.tsx"));
    expect(privacy).toMatch(/آخر تحديث لهذا القسم: \{LEGAL_BUNDLE_VERSION\}/);
    expect(privacy).not.toMatch(/آخر تحديث لهذا القسم: 20\d\d-/);
  });

  it("★ ★ ★ ولم يُنشأ إصدارٌ قانونيّ جديد", () => {
    const legal = stripComments(readSrc("lib/legal.ts"));
    expect(legal).toMatch(/LEGAL_BUNDLE_VERSION = "2026-08-21"/);
    expect(legal).toMatch(/LEGAL_PREVIOUS_VERSION = "2026-07-15"/);
  });

  it("★ ★ ★ ولم يُمَسّ الترحيل 0046", () => {
    /** مُسجَّلٌ ومُطبَّق في البيئتين — وتعديلُه بعد التطبيق انحرافٌ صامت */
    const mig = readSrc("supabase/migrations/0046_legal_bundle_2026_08_21.sql");
    expect(mig).toContain(`'"2026-08-21"'::jsonb`);
    expect(mig).toContain("key = 'terms_version'");
    expect(mig).toContain(`value = '"2026-07-15"'::jsonb`);
  });
});
