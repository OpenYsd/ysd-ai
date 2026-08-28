/**
 * v136 — رمزُ المحرّك واحد، ولوحتُه تتبع أيَّ الرايتين اشتعلت (4F-C.1).
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطبان اللذان أُغلقا
 *
 *  الأوّل: كان اسمُ مفتاح التخزين مكتوبًا حرفًا في موضعين — في لوحة
 *  الإعدادات وفي راية الصوت. حرفان متطابقان اليوم يكفيان لأن ينزلق
 *  أحدُهما غدًا، فتكتب اللوحةُ في مفتاحٍ لا يقرؤه الزرّ، ويبدو الرمزُ
 *  محفوظًا وغائبًا في آنٍ واحد.
 *
 *  الثاني: كانت اللوحةُ مشروطةً برايةِ الصور وحدَها. فلو أُطلق الصوتُ
 *  دونها لاختفى الحقلُ الذي يُلصق فيه الرمز — ميزةٌ مشتعلةٌ لا سبيلَ
 *  إلى تهيئتها.
 * ══════════════════════════════════════════════════════════════════
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/local-image/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/local-image/client")>("@/lib/local-image/client");
  return { ...actual, probeEngine: vi.fn(async () => false), fetchCapabilities: vi.fn(async () => null) };
});

import { LocalAiSettings } from "@/components/local-image/local-ai-settings";
import { ENGINE_TOKEN_KEY as IMAGE_KEY } from "@/lib/local-image/flag";
import { ENGINE_TOKEN_KEY as VOICE_KEY } from "@/lib/local-voice/flag";

const IMG = "NEXT_PUBLIC_YSD_LOCAL_IMAGE";
const VOI = "NEXT_PUBLIC_YSD_LOCAL_VOICE";
const ROOT = process.cwd();
let prev: Record<string, string | undefined> = {};

beforeEach(() => { prev = { [IMG]: process.env[IMG], [VOI]: process.env[VOI] }; });
afterEach(() => {
  cleanup();
  for (const k of [IMG, VOI]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

describe("v136 — مفتاحٌ واحدٌ لا اثنان", () => {
  it("الصورُ والصوتُ يقرآن المفتاحَ نفسَه", () => {
    expect(VOICE_KEY).toBe(IMAGE_KEY);
    expect(IMAGE_KEY).toBe("ysd.localEngineToken");
  });

  /**
   * ★ ويُقاس أنّه **مصدرٌ** واحد، لا قيمتان تصادفتا.
   *
   * فالتساوي أعلاه يمرّ ولو كُتب الحرفُ مرّتين. والمقصودُ أن يكون التعريفُ
   * في ملفٍّ واحد وأن يُستورد في الباقي.
   */
  it("والاسمُ مُعرَّفٌ مرّةً واحدة في المستودع", () => {
    const files = [
      join("lib", "local-image", "flag.ts"),
      join("lib", "local-voice", "flag.ts"),
      join("components", "local-image", "local-ai-settings.tsx"),
      join("components", "local-voice", "mic-button.tsx"),
    ];
    const declarations = files.filter((f) =>
      /=\s*["']ysd\.localEngineToken["']/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(declarations).toEqual([join("lib", "local-image", "flag.ts")]);
  });
});

describe("v136 — لوحةُ الإعدادات تتبع أيَّ رايةٍ اشتعلت", () => {
  it("الاثنتان مطفأتان ⇒ لا لوحة", () => {
    delete process.env[IMG];
    delete process.env[VOI];
    const { container } = render(<LocalAiSettings />);
    expect(container.innerHTML).toBe("");
  });

  it("الصورُ وحدَها ⇒ تظهر اللوحة", async () => {
    process.env[IMG] = "1";
    delete process.env[VOI];
    render(<LocalAiSettings />);
    await waitFor(() => expect(screen.getByTestId("local-ai-settings")).toBeTruthy());
    expect(screen.getByTestId("engine-serves").textContent).toContain("توليد الصور المحلّي");
  });

  /** ★ الحالةُ التي كانت مستحيلةً قبل الإصلاح */
  it("والصوتُ وحدَه ⇒ تظهر اللوحة كذلك", async () => {
    delete process.env[IMG];
    process.env[VOI] = "1";
    render(<LocalAiSettings />);
    await waitFor(() => expect(screen.getByTestId("local-ai-settings")).toBeTruthy());
    expect(screen.getByTestId("engine-token-input")).toBeTruthy();
    expect(screen.getByTestId("engine-serves").textContent).toContain("الصوت المحلّي");
  });

  it("والاثنتان معًا ⇒ يُقال إنّ الاتصالَ واحدٌ يخدمهما", async () => {
    process.env[IMG] = "1";
    process.env[VOI] = "1";
    render(<LocalAiSettings />);
    await waitFor(() => expect(screen.getByTestId("engine-serves")).toBeTruthy());
    const txt = screen.getByTestId("engine-serves").textContent ?? "";
    expect(txt).toContain("الصور والصوت");
    expect(txt).toContain("رمزٌ واحدٌ يكفيهما");
  });

  /** ★ ولا يُعرض الرمزُ في عنوانٍ ولا يُسرَّب في نصّ */
  it("ولا رمزَ في عنوانٍ ولا اقتراحَ سحابيّ", async () => {
    process.env[IMG] = "1";
    process.env[VOI] = "1";
    const { container } = render(<LocalAiSettings />);
    await waitFor(() => expect(screen.getByTestId("local-ai-settings")).toBeTruthy());
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/token|Bearer/i);
    }
    expect(container.textContent ?? "").not.toMatch(/سحاب|OpenAI|Azure|مدفوع/i);
  });
});
