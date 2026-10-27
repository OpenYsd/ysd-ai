import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

/**
 * المرحلة 3D — مسودة المحادثة الجديدة لحسابها وحده.
 *
 * ── ما يحرسه هذا الملف ──
 *
 *   - أ ← ب ← أ: كل حسابٍ يجد مسودته ولا يرى مسودة غيره — بعد الخروج والدخول، وفي الصفحة القائمة نفسها.
 *   - لا يُكتب نصّ حسابٍ تحت مفتاح غيره، ولا تُمحى مسودة أحدٍ عند التبديل أو الخروج.
 *   - المفتاح القديم المشترك `ysd-draft:new` مجهول الصاحب: لا يُقرأ ولا يُعرض ولا يُكتب ولا يُحذف.
 *   - مسودات المحادثات القائمة بمفاتيحها كما كانت.
 *   - المرحلة 3B بالنطاق: استبدال / إضافة / إلغاء، وقرارٌ معلَّق لا ينتقل إلى حسابٍ آخر.
 *   - الوضع الصارم، والإماهة، وتعذّر التخزين، والإرسال بيد المستخدم وحده.
 *
 * المكوّن الحقيقي والقاموس الحقيقي والنطاق الحقيقي؛ يُستبدل الموجّه و`fetch` فقط.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/shell/app-shell", () => ({ MobileMenuButton: () => null }));

import { ChatView } from "@/components/chat/chat-view";
import { I18nProvider } from "@/lib/i18n";
import { chatDraftScopeFor } from "@/lib/chat/draft-scope";
import type { SkillChatRequest } from "@/lib/skills/chat-draft";
import { resolveSkillChatRequest } from "@/lib/skills/chat-request";
import { builtInSkillRegistry } from "@/lib/skills/registry";

const { renderToString } = createRequire(import.meta.url)("react-dom/server") as {
  renderToString: (element: React.ReactElement) => string;
};

const MODELS = [{ id: "ysd/free", nameAr: "YSD Free", nameEn: "YSD Free", provider: "", available: true }];
const CONV = "44444444-4444-4444-8444-444444444444";
const LEGACY = "ysd-draft:new";
const OLD = "نصٌّ قديم لا يُعرف صاحبه";

const A = chatDraftScopeFor(randomUUID());
const B = chatDraftScopeFor(randomUUID());
const keyOf = (scope: string) => `ysd-draft:${scope}:new`;
const A_TEXT = "مسودة أ التي لم تُرسل — خاصّة";
const B_TEXT = "مسودة ب";

const proof = builtInSkillRegistry().get("arabic-proofreader");
if (!proof) throw new Error("built-in skill missing: arabic-proofreader");
const PROOF = proof;
const INS = PROOF.instructions.ar;
const OK = resolveSkillChatRequest(PROOF.id) as SkillChatRequest;

const L = { message: "رسالتك إلى YSD AI", send: "إرسال", choice: "اختيار مكان تعليمات المهارة" } as const;

const view = (
  scope: string | null | undefined,
  opts: { conversationId?: string | null; skill?: SkillChatRequest | null } = {},
) => (
  <I18nProvider initialLocale="ar">
    <ChatView
      conversationId={opts.conversationId ?? null}
      initialMessages={[]}
      models={MODELS}
      initialModelId="ysd/free"
      greetingName=""
      initialAttachments={[]}
      skillRequest={opts.skill ?? null}
      draftScope={scope}
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

const box = () => screen.getByRole("textbox", { name: L.message }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const group = () => screen.getByRole("group", { name: L.choice });
const skillNotice = () => document.querySelector<HTMLElement>("[data-skill-draft]");
const at = (path: string) => window.history.replaceState(null, "", path);
const clickSend = () =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name: L.send }));
  });

/** كل مفتاحٍ مسّه المكوّن، بفعله — يُقرأ قبل أيّ قراءةٍ من الاختبار نفسه */
function watchStorage() {
  const get = vi.spyOn(Storage.prototype, "getItem");
  const set = vi.spyOn(Storage.prototype, "setItem");
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const clear = vi.spyOn(Storage.prototype, "clear");
  return {
    set,
    remove,
    clear,
    touched: () => [...get.mock.calls, ...set.mock.calls, ...remove.mock.calls].map(([k]) => String(k)),
  };
}

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

describe("أ ← ب ← أ", () => {
  it("خروجٌ ثم دخولٌ بحسابٍ آخر ثم عودة: كلٌّ يجد مسودته وحدها، ولا شيء يُمحى", () => {
    render(view(A));
    type(A_TEXT);
    // الخروج نموذجٌ يغادر الصفحة: لا يبقى في الذاكرة شيء
    cleanup();
    render(view(B));
    expect(box().value).toBe("");
    type(B_TEXT);
    cleanup();
    render(view(A));
    expect(box().value).toBe(A_TEXT);
    cleanup();
    render(view(B));
    expect(box().value).toBe(B_TEXT);
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
    expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
    expect(aiCalls()).toEqual([]);
  });

  it("الصفحة قائمة والحساب يتبدّل (تحديثٌ من الخادم): لا نصٌّ قديم في الحقل، ولا يُكتب تحت مفتاح غيره", () => {
    const storage = watchStorage();
    const { rerender } = render(view(A));
    type(A_TEXT);
    // من هنا لكلٍّ مسودةٌ محفوظة: لا يجوز أن يُزال منها شيء بالتبديل
    storage.remove.mockClear();
    rerender(view(B));
    expect(box().value).toBe("");
    type(B_TEXT);
    rerender(view(A));
    expect(box().value).toBe(A_TEXT);
    rerender(view(B));
    expect(box().value).toBe(B_TEXT);

    const writes = storage.set.mock.calls.map(([k, v]) => [String(k), String(v)] as const);
    expect(writes.filter(([k]) => k === keyOf(B)).map(([, v]) => v)).toEqual(expect.arrayContaining([B_TEXT]));
    expect(writes.filter(([k]) => k === keyOf(B)).every(([, v]) => v === B_TEXT)).toBe(true);
    expect(writes.filter(([k]) => k === keyOf(A)).every(([, v]) => v === A_TEXT)).toBe(true);
    // ب لم تكن لها مسودةٌ حين رُكّب شريطها — فما أُزيل مفتاحٌ فارغ، لا مسودة أ
    expect(storage.remove.mock.calls.map(([k]) => String(k))).not.toContain(keyOf(A));
    expect(new Set(storage.touched())).toEqual(new Set([keyOf(A), keyOf(B)]));
    expect(storage.clear).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
    expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
  });

  it("قرارٌ معلَّق لمسودة أ لا ينتقل إلى ب، ولا يُطبَّق على مسودته", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    at(`/chat?skill=${PROOF.id}`);
    const { rerender } = render(view(A, { skill: OK }));
    expect(box().value).toBe(A_TEXT);
    expect(group()).toBeTruthy();
    rerender(view(B, { skill: OK }));
    expect(screen.queryByRole("group", { name: L.choice })).toBeNull();
    expect(skillNotice()).toBeNull();
    expect(box().value).toBe("");
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
    expect(window.localStorage.getItem(keyOf(B))).toBeNull();
    expect(aiCalls()).toEqual([]);
  });

  it("مسودة محادثةٍ قائمة بمفتاحها كما كان — لا تتغيّر بالنطاق ولا تُنقل", () => {
    const key = `ysd-draft:${CONV}`;
    window.localStorage.setItem(key, "مسودة محادثة");
    render(view(A, { conversationId: CONV }));
    expect(box().value).toBe("مسودة محادثة");
    type("مسودة محادثة معدّلة");
    expect(window.localStorage.getItem(key)).toBe("مسودة محادثة معدّلة");
    expect(Object.keys(window.localStorage)).toEqual([key]);
  });
});

describe("المرحلة 3B بالنطاق: القرار يمسّ مسودة الحساب الحالي وحدها", () => {
  for (const [label, expected] of [
    ["استبدال المسودة", INS],
    ["إضافتها بعد المسودة", `${A_TEXT}\n\n${INS}`],
    ["إلغاء", A_TEXT],
  ] as const) {
    it(`«${label}»`, () => {
      window.localStorage.setItem(keyOf(A), A_TEXT);
      window.localStorage.setItem(keyOf(B), B_TEXT);
      at(`/chat?skill=${PROOF.id}`);
      render(view(A, { skill: OK }));
      expect(box().value).toBe(A_TEXT);
      fireEvent.click(within(group()).getByRole("button", { name: label }));
      expect(box().value).toBe(expected);
      expect(window.localStorage.getItem(keyOf(A))).toBe(expected);
      expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
      expect(window.location.search).toBe("");
      expect(aiCalls()).toEqual([]);
    });
  }

  it("مهارةٌ تصل لحسابٍ بلا مسودة ومسودة غيره محفوظة ⇒ التعليمات مباشرةً بلا سؤال", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    at(`/chat?skill=${PROOF.id}`);
    render(view(B, { skill: OK }));
    expect(box().value).toBe(INS);
    expect(screen.queryByRole("group", { name: L.choice })).toBeNull();
    expect(window.localStorage.getItem(keyOf(B))).toBe(INS);
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
  });
});

describe("المفتاح القديم المشترك ysd-draft:new — مجهول الصاحب", () => {
  it("لا يُعرض على أيّ حساب، ولا يُقرأ ولا يُكتب ولا يُحذف", () => {
    window.localStorage.setItem(LEGACY, OLD);
    const storage = watchStorage();
    render(view(A));
    expect(box().value).toBe("");
    type(A_TEXT);
    type("");
    cleanup();
    render(view(B));
    expect(box().value).toBe("");
    type(B_TEXT);
    expect(storage.touched()).not.toContain(LEGACY);
    expect(storage.clear).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(LEGACY)).toBe(OLD);
  });

  it("مهارةٌ تصل ومعها المفتاح القديم ⇒ لا يُعدّ مسودةً للحساب: لا سؤال، والقديم كما هو", () => {
    window.localStorage.setItem(LEGACY, OLD);
    at(`/chat?skill=${PROOF.id}`);
    render(view(A, { skill: OK }));
    expect(box().value).toBe(INS);
    expect(box().value).not.toContain(OLD);
    expect(screen.queryByRole("group", { name: L.choice })).toBeNull();
    expect(window.localStorage.getItem(LEGACY)).toBe(OLD);
  });

  it("بلا نطاقٍ صالح ⇒ لا مسودة تُسترجع ولا تُحفظ، والقديم كما هو", () => {
    for (const bad of [undefined, null, "", "new", randomUUID(), "A".repeat(32), "a".repeat(31), `${A}:x`]) {
      window.localStorage.setItem(LEGACY, OLD);
      render(view(bad));
      expect(box().value, String(bad)).toBe("");
      type("نصٌّ للجلسة وحدها");
      expect(box().value, String(bad)).toBe("نصٌّ للجلسة وحدها");
      expect(Object.keys(window.localStorage), String(bad)).toEqual([LEGACY]);
      expect(window.localStorage.getItem(LEGACY), String(bad)).toBe(OLD);
      cleanup();
    }
  });
});

describe("الوضع الصارم", () => {
  it("المسودة تعود مرّةً واحدة، ولا تُمحى من التخزين في أثناء التركيب", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    const storage = watchStorage();
    render(<StrictMode>{view(A)}</StrictMode>);
    expect(box().value).toBe(A_TEXT);
    expect(storage.remove.mock.calls.map(([k]) => String(k))).not.toContain(keyOf(A));
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
  });

  it("أ ← ب ← أ في الوضع الصارم", () => {
    const { rerender } = render(<StrictMode>{view(A)}</StrictMode>);
    type(A_TEXT);
    rerender(<StrictMode>{view(B)}</StrictMode>);
    expect(box().value).toBe("");
    type(B_TEXT);
    rerender(<StrictMode>{view(A)}</StrictMode>);
    expect(box().value).toBe(A_TEXT);
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
    expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
  });

  it("مهارةٌ ومسودةٌ قائمة في الوضع الصارم ⇒ قرارٌ واحد، والمسودة كما هي", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    at(`/chat?skill=${PROOF.id}`);
    render(<StrictMode>{view(A, { skill: OK })}</StrictMode>);
    expect(screen.getAllByRole("group", { name: L.choice })).toHaveLength(1);
    expect(box().value).toBe(A_TEXT);
    fireEvent.click(within(group()).getByRole("button", { name: "إضافتها بعد المسودة" }));
    expect(box().value).toBe(`${A_TEXT}\n\n${INS}`);
  });
});

describe("عرض الخادم والإماهة", () => {
  it("HTML الخادم لا يحمل المسودة ولا النطاق، ومطابقٌ بين حسابين", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    const html = renderToString(view(A));
    expect(html).toBe(renderToString(view(B)));
    expect(html).not.toContain(A);
    expect(html).not.toContain(A_TEXT);
    expect(html).not.toContain("ysd-draft");
  });

  it("الإماهة بلا خلاف، ثم تظهر مسودة الحساب وحدها", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    window.localStorage.setItem(keyOf(B), B_TEXT);
    window.localStorage.setItem(LEGACY, OLD);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = view(A);
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.appendChild(container);
    const recoverable: unknown[] = [];
    render(element, { container, hydrate: true, onRecoverableError: (e: unknown) => void recoverable.push(e) });
    expect(recoverable).toEqual([]);
    const logs = consoleError.mock.calls.filter((c) => /hydrat|did not match|#418|#423|#425/i.test(c.map(String).join(" ")));
    expect(logs).toEqual([]);
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(A_TEXT);
    container.remove();
  });
});

describe("تعذّر التخزين", () => {
  it("الوصول إلى التخزين يرمي: لا كسر، والحقل يعمل، والإرسال بالضغط وحده", async () => {
    const own = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      render(view(A));
      expect(box().value).toBe("");
      type(A_TEXT);
      expect(box().value).toBe(A_TEXT);
      expect(aiCalls()).toEqual([]);
      await clickSend();
      await waitFor(() => expect(aiCalls().map(([u]) => String(u))).toEqual(["/api/conversations", "/api/chat"]));
    } finally {
      cleanup();
      if (own) Object.defineProperty(window, "localStorage", own);
      else delete (window as { localStorage?: unknown }).localStorage;
    }
  });

  it("القراءة محجوبة والكتابة ممتلئة: النصّ يبقى في الحقل، ومسودة غيره كما هي", () => {
    window.localStorage.setItem(keyOf(B), B_TEXT);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(view(A));
    expect(box().value).toBe("");
    type(A_TEXT);
    expect(box().value).toBe(A_TEXT);
    type("");
    expect(box().value).toBe("");
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
    expect(window.localStorage.getItem(keyOf(A))).toBeNull();
    expect(aiCalls()).toEqual([]);
  });

  it("الكتابة وحدها ممتلئة: المحفوظ من قبل يعود ولا يُمحى", () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    render(view(A));
    expect(box().value).toBe(A_TEXT);
    type(`${A_TEXT} …`);
    expect(box().value).toBe(`${A_TEXT} …`);
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(keyOf(A))).toBe(A_TEXT);
  });
});

describe("الإرسال بيد المستخدم وحده", () => {
  it("الاسترجاع والتبديل لا يُرسلان شيئًا؛ الضغط وحده يُرسل مسودة الحساب الحالي", async () => {
    window.localStorage.setItem(keyOf(A), A_TEXT);
    window.localStorage.setItem(keyOf(B), B_TEXT);
    const { rerender } = render(view(A));
    rerender(view(B));
    expect(box().value).toBe(B_TEXT);
    rerender(view(A));
    expect(box().value).toBe(A_TEXT);
    expect(aiCalls()).toEqual([]);

    await clickSend();
    await waitFor(() => expect(aiCalls().map(([u]) => String(u))).toEqual(["/api/conversations", "/api/chat"]));
    const body = JSON.parse(String((aiCalls()[1]?.[1] as RequestInit).body)) as { message: string };
    expect(body.message).toBe(A_TEXT);
    // لا مسودة غيره ولا نطاق في الطلب
    expect(JSON.stringify(body)).not.toContain(B_TEXT);
    expect(JSON.stringify(body)).not.toContain(A);
    await waitFor(() => expect(box().value).toBe(""));
    // ما أُرسل يُمسح كما كان؛ ومسودة الحساب الآخر لا تُمسّ
    expect(window.localStorage.getItem(keyOf(A))).toBeNull();
    expect(window.localStorage.getItem(keyOf(B))).toBe(B_TEXT);
  });
});
