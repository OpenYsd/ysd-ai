/**
 * لوحةُ الاقتران — ما تعرضه، وما لا تفعله.
 *
 * ★ وأهمُّ تأكيدٍ هنا سلبيّ: أنّ الضغطَ على «اقترن» **لا يُقرن**.
 *
 *   فلو أقرنت الضغطةُ وحدَها، لكفى أن يُخدع المستخدمُ مرّةً واحدة. والرقمُ
 *   الذي يُقرأ من نافذةٍ محلّيّةٍ ويُكتب هنا هو الدليلُ الوحيد على أنّ من
 *   يطلب الاقتران جالسٌ أمام الجهاز.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENGINE = "http://127.0.0.1:47615";

/** الرايةُ تُقرأ وقتَ التصيير، فتُضبط قبل استيراد المكوّن */
async function renderPanel(enabled: boolean) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_YSD_LOCAL_PAIRING = enabled ? "1" : "0";
  const { LocalPairingPanel } = await import("@/components/local-pairing/pairing-panel");
  return render(<LocalPairingPanel />);
}

const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ENGINE}/version`) {
      return new Response(JSON.stringify({ engineVersion: "0.2.0-alpha.4", apiVersion: 1, pairingApiVersion: 1 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("indexedDB", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_YSD_LOCAL_PAIRING;
});

describe("الرايةُ مطفأة", () => {
  it("لا لوحةَ، ولا وعدَ بـ«قريبًا»", async () => {
    const { container } = await renderPanel(false);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("local-pairing-panel")).toBeNull();
  });

  it("★ ولا نداءَ شبكةٍ واحد", async () => {
    await renderPanel(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls().length).toBe(0);
  });

  it("ولا يظهر عنوانُ المحرّك في الصفحة", async () => {
    const { container } = await renderPanel(false);
    expect(container.innerHTML).not.toContain("127.0.0.1");
    expect(container.innerHTML).not.toContain("47615");
  });
});

describe("الرايةُ مشتعلة", () => {
  it("اللوحةُ تظهر وتفحص المحرّك", async () => {
    await renderPanel(true);
    expect(await screen.findByTestId("local-pairing-panel")).toBeTruthy();
    await waitFor(() => expect(calls().some((c) => String(c[0]) === `${ENGINE}/version`)).toBe(true));
  });

  it("غيرُ مقترن ⇒ زرُّ اقتران، ولا حقلَ رمزٍ قبل الضغط", async () => {
    await renderPanel(true);
    await screen.findByTestId("pairing-start");
    expect(screen.queryByTestId("pairing-code-input")).toBeNull();
  });

  it("★ والضغطُ يعرض التعليماتِ ولا يُقرن", async () => {
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));

    expect(await screen.findByTestId("pairing-instructions")).toBeTruthy();
    expect(screen.getByTestId("pairing-code-input")).toBeTruthy();
    /** ولم يُلمس مسارُ الاقتران */
    expect(calls().some((c) => String(c[0]).includes("/pair/complete"))).toBe(false);
  });

  it("وتُعرض نافذةُ المحرّك بعنوانٍ ثابتٍ بلا مُعامِلات", async () => {
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));

    const shown = (await screen.findByTestId("pairing-page-url")).textContent ?? "";
    expect(shown).toBe(`${ENGINE}/pair`);
    expect(shown).not.toContain("?");
    expect(shown).not.toContain("#");
  });

  it("وزرُّ الفتح يستعمل العنوانَ نفسَه مع noopener", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));
    fireEvent.click(await screen.findByTestId("pairing-open-engine"));

    expect(open).toHaveBeenCalledWith(`${ENGINE}/pair`, "_blank", "noopener,noreferrer");
  });

  it("والحقلُ يقبل الأرقامَ وحدَها بثمانيةِ خانات", async () => {
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));

    const input = await screen.findByTestId("pairing-code-input") as HTMLInputElement;
    expect(input.maxLength).toBe(8);
    expect(input.autocomplete).toBe("off");

    fireEvent.change(input, { target: { value: "12ab34cd" } });
    expect(input.value).toBe("1234");
  });

  it("★ والإرسالُ معطَّلٌ حتّى يكتمل الرمز", async () => {
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));

    const submit = await screen.findByTestId("pairing-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("pairing-code-input"), { target: { value: "27528448" } });
    await waitFor(() => expect((screen.getByTestId("pairing-submit") as HTMLButtonElement).disabled).toBe(false));
  });

  it("★ ولا يظهر الرمزُ في العنوان ولا في التاريخ", async () => {
    await renderPanel(true);
    fireEvent.click(await screen.findByTestId("pairing-start"));
    fireEvent.change(await screen.findByTestId("pairing-code-input"), { target: { value: "27528448" } });

    expect(window.location.href).not.toContain("27528448");
    expect(window.location.search).toBe("");
  });
});
