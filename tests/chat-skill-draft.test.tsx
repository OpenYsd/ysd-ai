import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { createRequire } from "node:module";

/**
 * المرحلة 3B — «استخدام في محادثة»: المهارة تصير مسودةً مرئيّة في شريط الكتابة الحقيقي.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - مهارةٌ تصريحية ⇒ تعليماتها في الحقل بلغة الواجهة، والمعامل يُحذف من الرابط فورًا.
 *   - لا إرسال ولا محادثة: لا طلب إلى /api/chat ولا /api/conversations حتى يرسل المستخدم بنفسه.
 *   - مسودةٌ قائمة لا تُمسّ: استبدالٌ أو إضافةٌ أو إلغاءٌ بأزرارٍ صريحة.
 *   - لا تكرار: إعادة العرض، والوضع الصارم، وإعادة التحميل، والرجوع والتقدّم.
 *   - المعرّف المجهول أو المهارة المعطّلة ⇒ لا نصّ، وسببٌ معلَن.
 *   - عرض الخادم لا يعرف المهارة، والإماهة بلا خطأ.
 *
 * المكوّن الحقيقي والقاموس الحقيقي والمحلِّل الحقيقي (السجلّ المدمج)؛ يُستبدل الموجّه و`fetch` فقط.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { ChatView } from "@/components/chat/chat-view";
import { I18nProvider, type Locale } from "@/lib/i18n";
import type { SkillChatRequest } from "@/lib/skills/chat-draft";
import { resolveSkillChatRequest } from "@/lib/skills/chat-request";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const MODELS = [{ id: "ysd/free", nameAr: "YSD Free", nameEn: "YSD Free", provider: "", available: true }];
const DRAFT_KEY = "ysd-draft:new";
const CONV = "22222222-2222-4222-8222-222222222222";

const proof = builtInSkillRegistry().get("arabic-proofreader");
if (!proof) throw new Error("built-in skill missing: arabic-proofreader");
const PROOF = proof;
const OK = resolveSkillChatRequest(PROOF.id) as SkillChatRequest;

const L = {
  ar: { message: "رسالتك إلى YSD AI", send: "إرسال", added: "أُضيفت إلى المسودة تعليمات:", choice: "اختيار مكان تعليمات المهارة" },
  en: { message: "Your message to YSD AI", send: "Send", added: "Added to your draft: instructions for", choice: "Choose where the skill instructions go" },
} as const;

const chat = (locale: Locale, skillRequest: SkillChatRequest | null) => (
  <I18nProvider initialLocale={locale}>
    <ChatView
      conversationId={null}
      initialMessages={[]}
      models={MODELS}
      initialModelId="ysd/free"
      greetingName=""
      initialAttachments={[]}
      skillRequest={skillRequest}
    />
  </I18nProvider>
);

let fetchMock: ReturnType<typeof vi.fn>;
const aiCalls = () =>
  fetchMock.mock.calls.filter(([u]) => /^\/api\/(chat|conversations)\b/.test(String(u)));

function route(url: string) {
  if (url === "/api/conversations") return Promise.resolve(new Response(JSON.stringify({ conversation: { id: CONV } }), { status: 200 }));
  if (url === "/api/chat") {
    return Promise.resolve(
      new Response('data: {"type":"done"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
  }
  return Promise.resolve(new Response("{}", { status: 200 }));
}

const box = () => screen.getByRole("textbox", { name: L.ar.message }) as HTMLTextAreaElement;
/** تنبيه المهارة وحده — في ChatView منطقةٌ حيّة أخرى لحالة التوليد بدور status أيضًا */
const skillNotice = () => document.querySelector<HTMLElement>("[data-skill-draft]");
function skillStatus(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-skill-draft] [role="status"]');
  if (!el) throw new Error("skill status not rendered");
  return el;
}
const at = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => {
  window.localStorage.clear();
  at("/chat");
  fetchMock = vi.fn((u: RequestInfo | URL) => route(String(u)));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  at("/");
});

describe("مهارةٌ تصريحية ⇒ مسودةٌ مرئيّة", () => {
  it("العربية: التعليمات في الحقل، والرابط بلا معامل، والتذكير معلَن، ولا طلب", () => {
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    expect(box().value).toBe(PROOF.instructions.ar);
    expect(window.location.pathname + window.location.search).toBe("/chat");
    const status = skillStatus();
    expect(status.textContent).toContain(L.ar.added);
    expect(status.textContent).toContain(PROOF.name.ar);
    expect(document.activeElement).toBe(box());
    expect(aiCalls()).toEqual([]);
  });

  it("الإنجليزية: التعليمات الإنجليزية والتذكير الإنجليزي", () => {
    at(`/chat?skill=${PROOF.id}`);
    render(chat("en", OK));
    const ta = screen.getByRole("textbox", { name: L.en.message }) as HTMLTextAreaElement;
    expect(ta.value).toBe(PROOF.instructions.en);
    expect(skillStatus().textContent).toContain(L.en.added);
    expect(skillStatus().textContent).toContain(PROOF.name.en);
  });

  it("مسودةٌ عاديّة قابلة للتعديل والحذف — والتذكير يزول حين تفرغ", () => {
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    fireEvent.change(box(), { target: { value: `${PROOF.instructions.ar}\n\nنصّي هنا` } });
    expect(box().value.endsWith("نصّي هنا")).toBe(true);
    expect(skillStatus()).toBeTruthy();
    fireEvent.change(box(), { target: { value: "" } });
    expect(box().value).toBe("");
    expect(skillNotice()).toBeNull();
    expect(aiCalls()).toEqual([]);
  });

  it("الإرسال بيد المستخدم وحده: المحادثة تُنشأ عند الضغط، والرسالة هي المسودة كما عُدّلت", async () => {
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    expect(aiCalls()).toEqual([]);
    const edited = `${PROOF.instructions.ar}\n\nالنصّ: مرحبا`;
    fireEvent.change(box(), { target: { value: edited } });
    expect(aiCalls()).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: L.ar.send }));
    });
    await waitFor(() => expect(aiCalls().map(([u]) => String(u))).toEqual(["/api/conversations", "/api/chat"]));
    const chatInit = aiCalls()[1]?.[1] as RequestInit;
    const body = JSON.parse(String(chatInit.body)) as { message: string; conversationId: string };
    expect(body.message).toBe(edited.trim());
    expect(body.conversationId).toBe(CONV);
    // لا شيء خفيّ: الطلب لا يحمل تعليمات نظامٍ ولا حقل مهارة
    expect(Object.keys(body)).not.toContain("system");
    expect(JSON.stringify(body)).not.toMatch(/"skill/);
    await waitFor(() => expect(box().value).toBe(""));
    expect(screen.queryByText(L.ar.added, { exact: false })).toBeNull();
  });
});

describe("مسودةٌ قائمة لا تُمسّ إلا باختيارٍ صريح", () => {
  const MINE = "مسودتي التي لم أرسلها";
  const group = () => screen.getByRole("group", { name: L.ar.choice });

  it("تبقى كما هي، ويُعرض القرار بثلاثة أزرار، والرابط بلا معامل", () => {
    window.localStorage.setItem(DRAFT_KEY, MINE);
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    expect(box().value).toBe(MINE);
    expect(within(group()).getAllByRole("button").map((b) => b.textContent)).toEqual(["استبدال المسودة", "إضافتها بعد المسودة", "إلغاء"]);
    expect(group().textContent).toContain(PROOF.name.ar);
    expect(window.location.search).toBe("");
    expect(aiCalls()).toEqual([]);
  });

  it("استبدال ⇒ التعليمات وحدها", () => {
    window.localStorage.setItem(DRAFT_KEY, MINE);
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    fireEvent.click(within(group()).getByRole("button", { name: "استبدال المسودة" }));
    expect(box().value).toBe(PROOF.instructions.ar);
    expect(screen.queryByRole("group", { name: L.ar.choice })).toBeNull();
    expect(skillStatus().textContent).toContain(L.ar.added);
  });

  it("إضافة ⇒ المسودة ثم سطرٌ فارغ ثم التعليمات", () => {
    window.localStorage.setItem(DRAFT_KEY, MINE);
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    fireEvent.click(within(group()).getByRole("button", { name: "إضافتها بعد المسودة" }));
    expect(box().value).toBe(`${MINE}\n\n${PROOF.instructions.ar}`);
  });

  it("إلغاء ⇒ المسودة كما هي، ولا قرار ولا تذكير", () => {
    window.localStorage.setItem(DRAFT_KEY, MINE);
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    fireEvent.click(within(group()).getByRole("button", { name: "إلغاء" }));
    expect(box().value).toBe(MINE);
    expect(screen.queryByRole("group", { name: L.ar.choice })).toBeNull();
    expect(skillNotice()).toBeNull();
  });

  it("المسودة تحمل التعليمات نفسها أصلًا ⇒ لا سؤال ولا تكرار", () => {
    const already = `${PROOF.instructions.ar}\n\nالنصّ: سابق`;
    window.localStorage.setItem(DRAFT_KEY, already);
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    expect(box().value).toBe(already);
    expect(screen.queryByRole("group", { name: L.ar.choice })).toBeNull();
    expect(skillStatus().textContent).toContain(L.ar.added);
  });
});

describe("لا تكرار: إعادة العرض، والوضع الصارم، وإعادة التحميل، والرجوع والتقدّم", () => {
  it("إعادة العرض بالخصائص نفسها لا تُضيف مرّةً ثانية", () => {
    at(`/chat?skill=${PROOF.id}`);
    const { rerender } = render(chat("ar", OK));
    rerender(chat("ar", OK));
    rerender(chat("ar", { ...OK }));
    expect(box().value).toBe(PROOF.instructions.ar);
  });

  it("الوضع الصارم (التأثير مرّتين) ⇒ إضافةٌ واحدة", () => {
    at(`/chat?skill=${PROOF.id}`);
    render(<StrictMode>{chat("ar", OK)}</StrictMode>);
    expect(box().value).toBe(PROOF.instructions.ar);
    expect([...document.querySelectorAll("[data-skill-draft]")]).toHaveLength(1);
  });

  it("إعادة التحميل: المسودة محفوظة كأي مسودة، وتعود مرّةً واحدة بلا معامل", () => {
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    expect(window.localStorage.getItem(DRAFT_KEY)).toBe(PROOF.instructions.ar);
    cleanup();
    // الصفحة بعد التحميل: الرابط /chat فالخادم لا يحلّ مهارة
    render(chat("ar", null));
    expect(box().value).toBe(PROOF.instructions.ar);
    expect(skillNotice()).toBeNull();
  });

  it("الرجوع والتقدّم: حمولةٌ مخزّنة تحمل الطلب والرابط بلا معامل ⇒ لا إضافة", () => {
    at("/chat");
    render(chat("ar", OK));
    expect(box().value).toBe("");
    expect(skillNotice()).toBeNull();
  });

  it("معامل لمهارةٍ أخرى غير المحلولة ⇒ لا إضافة ولا حذف للمعامل", () => {
    at("/chat?skill=summarize-text");
    render(chat("ar", OK));
    expect(box().value).toBe("");
    expect(window.location.search).toBe("?skill=summarize-text");
  });

  it("المعاملات الأخرى في الرابط تبقى؛ يُحذف المعامل وحده", () => {
    at(`/chat?skill=${PROOF.id}&ref=x`);
    render(chat("ar", OK));
    expect(window.location.search).toBe("?ref=x");
  });
});

describe("المجهول والمعطّل: لا نصّ، والسبب معلَن", () => {
  for (const raw of ["no-such-skill", "../etc/passwd", "Arabic-Proofreader"]) {
    it(`معرّفٌ مجهول أو مشوَّه (${raw}) ⇒ الحقل فارغ والسبب معلَن والرابط نظيف`, () => {
      at(`/chat?skill=${encodeURIComponent(raw)}`);
      render(chat("ar", resolveSkillChatRequest(raw)));
      expect(box().value).toBe("");
      expect(skillStatus().textContent).toContain("لا توجد مهارة بهذا المعرّف");
      expect(window.location.search).toBe("");
      expect(aiCalls()).toEqual([]);
    });
  }

  it("مهارةٌ تعتمد على صلاحيةٍ معطّلة (document-qa) ⇒ لا تُضاف، والحدّ معلَن باللغتين", () => {
    for (const locale of ["ar", "en"] as const) {
      at("/chat?skill=document-qa");
      render(chat(locale, resolveSkillChatRequest("document-qa")));
      const ta = screen.getByRole("textbox", { name: L[locale].message }) as HTMLTextAreaElement;
      expect(ta.value, locale).toBe("");
      expect(skillStatus().textContent, locale).toMatch(
        locale === "ar" ? /صلاحية غير مفعّلة/ : /capability that isn't enabled/,
      );
      cleanup();
    }
    expect(aiCalls()).toEqual([]);
  });

  it("الإخفاء يزيل التنبيه ولا يمسّ الحقل", () => {
    at("/chat?skill=no-such-skill");
    render(chat("ar", resolveSkillChatRequest("no-such-skill")));
    fireEvent.click(screen.getByRole("button", { name: "إخفاء التنبيه" }));
    expect(skillNotice()).toBeNull();
    expect(box().value).toBe("");
  });
});

describe("شريط الكتابة كما كان", () => {
  it("بلا طلب مهارة: لا تنبيه، والمسودة القائمة تعود كما كانت", () => {
    window.localStorage.setItem(DRAFT_KEY, "قديمة");
    render(chat("ar", null));
    expect(box().value).toBe("قديمة");
    expect(skillNotice()).toBeNull();
    expect(screen.queryByRole("group", { name: L.ar.choice })).toBeNull();
  });

  it("كل زرٍّ في التنبيهات له اسمٌ مسموع", () => {
    window.localStorage.setItem(DRAFT_KEY, "قديمة");
    at(`/chat?skill=${PROOF.id}`);
    render(chat("ar", OK));
    for (const b of screen.getAllByRole("button")) {
      const name = b.getAttribute("aria-label") ?? b.textContent ?? "";
      expect(name.trim(), b.outerHTML.slice(0, 80)).not.toBe("");
    }
  });
});

describe("عرض الخادم والإماهة", () => {
  it("عرض الخادم لا يعرف المهارة: مطابقٌ لعرض محادثةٍ بلا طلب، وبلا التعليمات", () => {
    for (const locale of ["ar", "en"] as const) {
      const withSkill = renderToString(chat(locale, OK));
      expect(withSkill, locale).toBe(renderToString(chat(locale, null)));
      expect(withSkill, locale).not.toContain(PROOF.instructions[locale].slice(0, 30));
    }
  });

  it("الإماهة بلا خطأ قابل للاسترداد ولا سجلّ إماهة، ثم تُضاف المسودة", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    at(`/chat?skill=${PROOF.id}`);
    const element = chat("ar", OK);
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    render(element, { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
    expect(recoverable).toEqual([]);
    const logs = consoleError.mock.calls.filter((c) => /hydrat|did not match|#418|#423|#425/i.test(c.map(String).join(" ")));
    expect(logs).toEqual([]);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(PROOF.instructions.ar);
    container.remove();
  });
});
