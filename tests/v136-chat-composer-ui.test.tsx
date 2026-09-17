import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { I18nProvider, type Locale } from "@/lib/i18n";
import { acceptAttribute, attachmentsReducer, type ComposerAttachment } from "@/lib/chat/composer-attachments";

/**
 * شريط الكتابة بمرفقاته — في DOM فعليّ وبقاموسٍ حقيقيّ (عربي RTL وإنجليزي LTR).
 */

afterEach(cleanup);

function Harness({
  attachments = [],
  onFiles = vi.fn(),
  onRemove = vi.fn(),
  onRetry = vi.fn(),
  onSend = vi.fn(),
  input = "",
  sendBlocked = false,
  locale = "ar",
}: {
  attachments?: ComposerAttachment[];
  onFiles?: (f: File[]) => void;
  onRemove?: (k: string) => void;
  onRetry?: (k: string) => void;
  onSend?: () => void;
  input?: string;
  sendBlocked?: boolean;
  locale?: Locale;
}) {
  function Inner() {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    return (
      <div dir={locale === "ar" ? "rtl" : "ltr"}>
        <ChatComposer
          input={input}
          setInput={vi.fn()}
          onSend={onSend}
          onStop={vi.fn()}
          generating={false}
          taRef={taRef}
          autoGrow={vi.fn()}
          placeholder="…"
          sendLabel="send"
          stopLabel="stop"
          composerLabel="message"
          attachLabel="attach"
          attachments={attachments}
          onFiles={onFiles}
          onRemoveAttachment={onRemove}
          onRetryAttachment={onRetry}
          sendBlocked={sendBlocked}
        />
      </div>
    );
  }
  return (
    <I18nProvider initialLocale={locale}>
      <Inner />
    </I18nProvider>
  );
}

const draft = (over: Partial<ComposerAttachment> & { key: string }): ComposerAttachment => ({
  fileId: null,
  name: "file.pdf",
  size: 2048,
  mime: "application/pdf",
  phase: "selected",
  progress: null,
  serverStatus: null,
  ragRequested: false,
  aiContext: false,
  errorKind: null,
  errorMessage: null,
  retry: null,
  scope: "draft",
  ...over,
});

const pdf = (name = "a.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });

function fileDrag(files: File[]) {
  return { dataTransfer: { files, types: ["Files"], dropEffect: "none" } };
}

describe("★ (١) البطاقات داخل الشريط", () => {
  it("★ ★ ★ البطاقة داخل حاوية الشريط نفسها، قبل حقل الكتابة", () => {
    const { container } = render(<Harness attachments={[draft({ key: "a", name: "تقرير.pdf" })]} />);
    const composer = container.querySelector("[data-composer]") as HTMLElement;
    const tray = composer.querySelector("[data-attachment-tray]");
    const textarea = composer.querySelector("textarea");
    expect(tray).not.toBeNull();
    expect((tray as Element).compareDocumentPosition(textarea as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(composer).getByTitle("تقرير.pdf")).toBeTruthy();
  });

  it("★ ★ ★ عدّة ملفّات: بطاقةٌ لكلٍّ بحالتها وحجمها وتقدّمها", () => {
    const { container } = render(
      <Harness
        locale="en"
        attachments={[
          draft({ key: "a", name: "report.pdf", phase: "uploading", progress: 40, size: 3 * 1024 * 1024 }),
          draft({ key: "b", name: "photo.png", mime: "image/png", phase: "ready", fileId: "f2" }),
          draft({ key: "c", name: "notes.txt", phase: "error", errorKind: "rateLimited", retry: "upload", mime: "text/plain" }),
        ]}
      />,
    );
    const cards = container.querySelectorAll("[data-attachment-card]");
    expect(cards).toHaveLength(3);
    expect([...cards].map((c) => c.getAttribute("data-attachment-phase"))).toEqual(["uploading", "ready", "error"]);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(cards[0]?.textContent).toContain("3 MB");
    expect(cards[0]?.textContent).toContain("Uploading 40%");
    expect(cards[1]?.textContent).toContain("Image — no AI context");
    expect(cards[2]?.textContent).toContain("Too many uploads");
  });

  it("★ ★ ★ كل زرٍّ مُسمّى، والأفعال الثلاثة بأسمائها الصادقة", () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    render(
      <Harness
        locale="en"
        onRemove={onRemove}
        onRetry={onRetry}
        attachments={[
          draft({ key: "up", phase: "uploading", progress: 10 }),
          draft({ key: "linked", fileId: "f1", phase: "indexing" }),
          draft({ key: "bad", phase: "error", errorKind: "network", retry: "upload" }),
          draft({ key: "proc", phase: "processing" }),
        ]}
      />,
    );
    for (const b of screen.getAllByRole("button")) expect(b.getAttribute("aria-label") || b.textContent?.trim()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(onRemove).toHaveBeenCalledWith("up");
    fireEvent.click(screen.getByRole("button", { name: "Remove from chat context (keeps the file)" }));
    expect(onRemove).toHaveBeenCalledWith("linked");
    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    expect(onRetry).toHaveBeenCalledWith("bad");
    const locked = screen.getByRole("button", { name: /Processing on the server/ });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("★ (٢) المداخل الثلاثة", () => {
  it("★ ★ ★ منتقي الملفات متعدّد، وaccept من أنواع الخادم", () => {
    const onFiles = vi.fn();
    const { container } = render(<Harness onFiles={onFiles} />);
    const input = container.querySelector("[data-attachment-input]") as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("accept")).toBe(acceptAttribute());
    fireEvent.change(input, { target: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0]?.[0] as File[]).map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("★ ★ ★ السحب والإفلات: طبقةُ إرشاد ثم الملفّات كلّها", () => {
    const onFiles = vi.fn();
    const { container } = render(<Harness locale="en" onFiles={onFiles} />);
    const zone = container.querySelector("[data-composer]") as HTMLElement;
    const files = [pdf("one.pdf"), pdf("two.pdf")];
    fireEvent.dragEnter(zone, fileDrag(files));
    expect(container.querySelector("[data-drop-overlay]")?.textContent).toContain("Drop files to attach");
    fireEvent.drop(zone, fileDrag(files));
    expect(container.querySelector("[data-drop-overlay]")).toBeNull();
    expect((onFiles.mock.calls[0]?.[0] as File[]).map((f) => f.name)).toEqual(["one.pdf", "two.pdf"]);
  });

  it("★ ★ ★ ولا يستجيب لسحب نصٍّ لا ملفّات", () => {
    const onFiles = vi.fn();
    const { container } = render(<Harness onFiles={onFiles} />);
    const zone = container.querySelector("[data-composer]") as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(container.querySelector("[data-drop-overlay]")).toBeNull();
    fireEvent.drop(zone, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("★ ★ ★ لصقُ صورةٍ يُرفقها باسمٍ مولَّد؛ ولصقُ نصٍّ يبقى نصًّا", () => {
    const onFiles = vi.fn();
    const { container } = render(<Harness onFiles={onFiles} />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    fireEvent.paste(ta, { clipboardData: { types: ["Files"], files: [png], getData: () => "" } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    const sent = (onFiles.mock.calls[0]?.[0] as File[])[0] as File;
    expect(sent.name).toMatch(/^pasted-image-\d{8}-\d{6}\.png$/);
    expect(sent.type).toBe("image/png");

    fireEvent.paste(ta, { clipboardData: { types: ["text/plain", "Files"], files: [png], getData: () => "فقرة منسوخة" } });
    const gif = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
    fireEvent.paste(ta, { clipboardData: { types: ["Files"], files: [gif], getData: () => "" } });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});

describe("★ (٣) الإرسال والسياق", () => {
  it("★ ★ ★ الإرسال معطّل ما دام ملفٌّ يُرفع، مع سببٍ مقروء", () => {
    render(<Harness locale="en" input="hello" sendBlocked attachments={[draft({ key: "a", phase: "uploading", progress: 5 })]} />);
    const send = screen.getByRole("button", { name: /send/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/Wait for uploads to finish/)).toBeTruthy();
  });

  it("★ ★ ★ ملفّات المحادثة مطويّةٌ في زرٍّ واحد يفتحها", () => {
    const ctx = [
      draft({ key: "file:1", fileId: "1", scope: "context", phase: "ready", aiContext: true, name: "a.pdf" }),
      draft({ key: "file:2", fileId: "2", scope: "context", phase: "ready", aiContext: true, name: "b.pdf" }),
    ];
    const { container } = render(<Harness locale="en" attachments={ctx} />);
    expect(container.querySelectorAll("[data-attachment-card]")).toHaveLength(0);
    const toggle = container.querySelector("[data-context-toggle]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("2");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-attachment-card]")).toHaveLength(2);
    expect(screen.getByText(/File ready — ask about its content/)).toBeTruthy();
  });
});

describe("★ (٤) الأمن والاتّجاه", () => {
  it("★ ★ ★ اسمٌ يحمل HTML يُعرض نصًّا لا عنصرًا", () => {
    const evil = attachmentsReducer([], {
      type: "add",
      items: [{ key: "x", name: '<img src=x onerror="alert(1)">.pdf', size: 10, mime: "application/pdf" }],
    });
    const { container } = render(<Harness attachments={evil} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("★ ★ ★ ولا رابط تنزيلٍ ولا عنوانٌ موقَّع في الشريط", () => {
    const { container } = render(
      <Harness attachments={[draft({ key: "a", fileId: "f1", phase: "ready", aiContext: true })]} />,
    );
    expect(container.querySelector("a[href]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/token=|signedUrl|\/storage\/v1\/object\/sign/);
  });

  it("★ ★ ★ عربيًّا: نصوصٌ عربيّة، والاسم معزولُ الاتّجاه", () => {
    const { container } = render(
      <Harness locale="ar" attachments={[draft({ key: "a", name: "Quarterly report.pdf", phase: "uploading", progress: 60 })]} />,
    );
    const card = container.querySelector("[data-attachment-card]") as HTMLElement;
    expect(card.textContent).toContain("جارٍ الرفع 60%");
    const bdis = card.querySelectorAll("bdi");
    expect(bdis[0]?.getAttribute("dir")).toBe("auto");
    expect(bdis[1]?.textContent).toBe(".pdf");
    expect(card.className).toMatch(/\bps-2\b/);
    expect(card.className).not.toMatch(/\bpl-|\bpr-/);
  });

  it("★ ★ ★ ولا منطقة aria-live جديدة: المنطقة الحيّة للبثّ وحده", () => {
    const { container } = render(<Harness attachments={[draft({ key: "a", phase: "uploading", progress: 1 })]} />);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
