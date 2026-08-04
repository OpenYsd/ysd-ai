/**
 * إزالة جزء العنوان الموروث من تدفّق OAuth (v0.8.0).
 *
 * العطل المرصود حيًّا: بعد رفض حساب Google جديد يصير شريط العنوان
 *   /login?reason=oauth_invite_required#error=server_error&error_code=…
 * أي أن الرابط الذي بنيناه نظيف، والوسخ في الجزء بعد `#`.
 *
 * **ولهذا نجا من كل فحص خادمي أجريناه**: الجزء لا يُرسَل إلى الخادم إطلاقًا،
 * فلا يظهر في ترويسة ولا سجلّ ولا استجابة. كان كل قياس نقيسه صادقًا وناقصًا
 * في آنٍ واحد. الإثبات النهائي متصفّحي (e2e/v08-oauth-fragment.spec.ts)، وهذه
 * الوحدات تثبّت الطرفين اللذين يتركّب منهما الإصلاح.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_REASON_MESSAGE,
  OAUTH_CLEAN_FRAGMENT,
  OAUTH_REASONS,
  loginRedirectPath,
} from "../lib/auth/oauth-error";
import { stripFragment } from "../components/auth/strip-url-fragment";

/** سجلّ نداءات replaceState — يقيس ما وقع فعلًا لا ما نُوي */
function fakeHistory() {
  const calls: string[] = [];
  return {
    calls,
    replaceState: (_d: unknown, _u: string, url: string) => {
      calls.push(url);
    },
  };
}

describe("★ حاجز التوريث — جزء صريح في وجهة التحويل", () => {
  /**
   * RFC 7231 §7.1.2: وجهةٌ بلا جزء **ترث** جزء الوارد. فغياب الجزء هنا ليس
   * حيادًا بل تسريبٌ صامت.
   */
  it("★ كل وجهات العودة تحمل جزءًا صريحًا", () => {
    for (const reason of OAUTH_REASONS) {
      expect(loginRedirectPath(reason), `الرمز ${reason}`).toContain(`#${OAUTH_CLEAN_FRAGMENT}`);
    }
  });

  it("★ الرابط كاملًا كما يُنتظر — reason ثم الجزء", () => {
    expect(loginRedirectPath("oauth_invite_required")).toBe(
      "/login?reason=oauth_invite_required#oauth-clean",
    );
  });

  it("★ الجزء بلا دلالة — لا يحمل سببًا ولا حالة ولا نصًّا", () => {
    expect(OAUTH_CLEAN_FRAGMENT).toBe("oauth-clean");
    expect(OAUTH_CLEAN_FRAGMENT).not.toMatch(/=|&|error|reason|state/i);
  });

  /** الرمز ما زال يُصفّى على المجموعة المغلقة — الجزء لم يفتح بابًا خلفيًا */
  it("★ رمز مجهول يبقى oauth_failed ولا يتسرّب إلى الرابط", () => {
    const injected = "Database error saving new user";
    const url = loginRedirectPath(injected);
    expect(url).toBe("/login?reason=oauth_failed#oauth-clean");
    expect(url).not.toContain("Database");
  });

  it("★ لا معامل غير reason في أي وجهة", () => {
    for (const reason of OAUTH_REASONS) {
      const [, query = ""] = loginRedirectPath(reason).split("?");
      const [search] = query.split("#");
      expect([...new URLSearchParams(search).keys()]).toEqual(["reason"]);
    }
  });
});

describe("★ المسح — stripFragment", () => {
  it("★ يمسح الجزء ويُبقي المسار والاستعلام", () => {
    const h = fakeHistory();
    const done = stripFragment(
      { pathname: "/login", search: "?reason=oauth_invite_required", hash: "#oauth-clean" },
      h,
    );
    expect(done).toBe(true);
    expect(h.calls).toEqual(["/login?reason=oauth_invite_required"]);
  });

  /**
   * الحالة الحقيقية المرصودة: الجزء الخام موروثًا من GoTrue. يُمحى كاملًا دون
   * أن يُقرأ منه شيء.
   */
  it("★ يمسح جزءًا خامًّا من المزوّد بلا تسريب", () => {
    const h = fakeHistory();
    stripFragment(
      {
        pathname: "/login",
        search: "?reason=oauth_invite_required",
        hash: "#error=server_error&error_code=unexpected_failure&error_description=Database%20error%20saving%20new%20user&state=abc123",
      },
      h,
    );
    expect(h.calls).toHaveLength(1);
    const [url] = h.calls;
    expect(url).toBe("/login?reason=oauth_invite_required");
    for (const leak of ["error", "Database", "SQLSTATE", "state=", "provider_error", "#"]) {
      expect(url, `تسرّب ${leak}`).not.toContain(leak);
    }
  });

  it("★ بلا جزء ⇒ لا نداء إطلاقًا (لا يُلمس السجلّ بلا سبب)", () => {
    const h = fakeHistory();
    expect(stripFragment({ pathname: "/login", search: "?reason=x", hash: "" }, h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("★ بلا استعلام ⇒ المسار وحده", () => {
    const h = fakeHistory();
    stripFragment({ pathname: "/login", search: "", hash: "#oauth-clean" }, h);
    expect(h.calls).toEqual(["/login"]);
  });
});

describe("★ المكوّن — العقد البنيوي", () => {
  const SRC = fs.readFileSync(path.resolve("components/auth/strip-url-fragment.tsx"), "utf8");
  const code = SRC.split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

  /**
   * pushState يضيف مدخلًا في السجلّ، فيعيد زرّ الرجوع المستخدمَ إلى العنوان
   * المتّسخ نفسه — إصلاحٌ يُبطله زرٌّ واحد.
   */
  it("★ replaceState لا pushState", () => {
    expect(code).toContain("replaceState");
    expect(code).not.toContain("pushState");
  });

  it("★ لا يُقرأ محتوى الجزء ولا يُطبع ولا يُسجَّل", () => {
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/URLSearchParams\(\s*\w*\.?hash/);
    expect(code).not.toMatch(/hash\.(slice|substring|split|replace|match)/);
    expect(code).not.toMatch(/decodeURI/);
  });

  it("★ الصفحة تركّبه", () => {
    const page = fs.readFileSync(path.resolve("app/(auth)/login/page.tsx"), "utf8");
    expect(page).toContain("StripUrlFragment");
    expect(page).toMatch(/<StripUrlFragment\s*\/>/);
  });
});

describe("★ الرسالة العربية لم تتغيّر", () => {
  it("★ نصّ رفض الدعوة كما اعتُمد حرفيًا", () => {
    expect(AUTH_REASON_MESSAGE.oauth_invite_required).toBe(
      "هذا الحساب غير مسجل أو لا يملك دعوة صالحة. استخدم حسابًا مسجلًا أو اطلب دعوة.",
    );
  });

  it("★ لا رسالة تحمل تفصيلًا تقنيًا", () => {
    for (const [reason, message] of Object.entries(AUTH_REASON_MESSAGE)) {
      for (const bad of ["Database", "SQLSTATE", "handle_new_user", "server_error", "#"]) {
        expect(message, `${reason} يحمل ${bad}`).not.toContain(bad);
      }
    }
  });
});
