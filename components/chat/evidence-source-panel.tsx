"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

import type { ClientCitation } from "@/lib/evidence/client-citation";

/**
 * لوحة عرض المصدر (v0.9.0، الإيداع الثامن).
 *
 * ── محتوى الملفات نصٌّ غير موثوق ──
 *
 * الاقتباس والمقطع يأتيان من ملفٍ رفعه المستخدم، وقد يحوي وسومًا أو Markdown
 * أو شيفرة. فيُعرضان **نصًّا محفوظًا** بلا `dangerouslySetInnerHTML` وبلا
 * تفسير Markdown: React يهرّب النصّ تلقائيًا، وتفسيرُه كان سيحوّل كل ملفٍ
 * يرفعه المستخدم إلى مدخل حقنٍ في صفحته.
 *
 * ── التمييز بالإزاحات ثم بالبحث ثم لا شيء ──
 *
 * الإزاحات محفوظة وقت الإجابة، والملف قد تغيّر بعدها. فتُستعمل **فقط** إن
 * طابقت الشريحةُ الاقتباسَ حرفيًا. وإلا يُبحث عن الاقتباس نصًّا. وإن لم يوجد
 * يُعرض وحده في صندوق منفصل بلا تمييز — ولا تقريب: تمييزُ الموضع الخطأ يقول
 * للقارئ «هذا ما استُشهد به» وهو ليس كذلك.
 *
 * ── الجلب كسول ──
 *
 * لا نداء عند تحميل المحادثة: عشرات الاستشهادات تعني عشرات الطلبات لمحتوى قد
 * لا يُفتح أيٌّ منه. النداء يقع عند الفتح وحده، ويُلغى عند الإغلاق أو فتح غيره.
 */

interface ChunkPayload {
  fileId: string;
  fileName: string;
  targetChunkId: string | null;
  chunks: {
    chunkId: string;
    chunkIndex: number;
    content: string;
    pageNumber: number | null;
    isTarget: boolean;
  }[];
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: ChunkPayload }
  | { status: "error" };

/** يحدّد موضع الاقتباس داخل المقطع — أو لا يحدّده */
export function locateQuote(
  content: string,
  quote: string,
  quoteStart: number,
  quoteEnd: number,
): { start: number; end: number } | null {
  if (!content || !quote) return null;

  // (١) الإزاحات المحفوظة — تُقبل فقط إن طابقت فعلًا
  if (
    quoteStart >= 0 &&
    quoteEnd <= content.length &&
    quoteEnd > quoteStart &&
    content.slice(quoteStart, quoteEnd) === quote
  ) {
    return { start: quoteStart, end: quoteEnd };
  }

  // (٢) بحث حرفيّ — الملف قد يكون أُعيد تقطيعه فانزاحت الإزاحات
  const at = content.indexOf(quote);
  if (at !== -1) return { start: at, end: at + quote.length };

  // (٣) لا تقريب: الاقتباس يُعرض وحده
  return null;
}

function ChunkText({
  content,
  highlight,
}: {
  content: string;
  highlight: { start: number; end: number } | null;
}) {
  const base =
    "whitespace-pre-wrap break-words text-[13px] leading-[1.9] text-ink";
  if (!highlight) {
    return <p className={base}>{content}</p>;
  }
  return (
    <p className={base}>
      {content.slice(0, highlight.start)}
      <mark className="rounded bg-primary/25 text-ink-strong px-0.5">
        {content.slice(highlight.start, highlight.end)}
      </mark>
      {content.slice(highlight.end)}
    </p>
  );
}

export function EvidenceSourcePanel({
  citation,
  onClose,
}: {
  citation: ClientCitation | null;
  onClose: () => void;
}) {
  /**
   * ★ اسم زرّ الإغلاق من القاموس (المرحلة 6D).
   *
   * كان `aria-label="إغلاق"` نصًّا عربيًّا ثابتًا — فيسمعه مستخدم الإنجليزية
   * بالعربية. وهو العطل نفسه الذي أُصلح في نصوص الأخطاء، وقد كشفه الفاحص
   * البنيويّ في هذه المرحلة.
   */
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const canFetch =
    citation !== null &&
    citation.sourceAvailable &&
    Boolean(citation.fileId) &&
    Boolean(citation.chunkId);

  const load = useCallback(() => {
    if (!citation || !canFetch) return;
    // الطلب السابق يُلغى: فتح مصدر ثانٍ لا ينتظر الأول ولا يعرض رده
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ status: "loading" });

    void (async () => {
      try {
        const res = await fetch(
          `/api/files/${citation.fileId}/chunks/${citation.chunkId}?neighbors=1`,
          { signal: ac.signal, headers: { Accept: "application/json" } },
        );
        if (!res.ok) {
          // 401 و404 و500 ⇒ رسالة واحدة: التفريق لا يفيد القارئ ويكشف ما لا يلزم
          setState({ status: "error" });
          return;
        }
        setState({ status: "ok", data: (await res.json()) as ChunkPayload });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setState({ status: "error" });
      }
    })();
  }, [citation, canFetch]);

  // الجلب عند الفتح وحده — ولا شيء للمصدر المحذوف
  useEffect(() => {
    if (!citation) {
      abortRef.current?.abort();
      setState({ status: "idle" });
      return;
    }
    if (!canFetch) {
      setState({ status: "idle" });
      return;
    }
    load();
    return () => abortRef.current?.abort();
  }, [citation, canFetch, load]);

  // Escape يغلق · والتركيز يُحبس داخل اللوحة ما دامت مفتوحة
  useEffect(() => {
    if (!citation) return;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [citation, onClose]);

  if (!citation) return null;

  const target = state.status === "ok"
    ? state.data.chunks.find((c) => c.isTarget) ?? null
    : null;
  const highlight = target
    ? locateQuote(target.content, citation.quote, citation.quoteStart, citation.quoteEnd)
    : null;
  const quoteShownInChunk = highlight !== null;

  return (
    <div className="fixed inset-0 z-50 flex" data-ysd-panel="">
      {/* النقر خارج اللوحة يغلقها */}
      <button
        type="button"
        aria-label={t("close")}
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-night/60 backdrop-blur-[2px] cursor-default"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`المصدر ${citation.marker}`}
        className={[
          "relative bg-surface border-line shadow-2xl flex flex-col",
          // جوّال: ورقة سفلية · سطح المكتب: لوحة جانبية
          "w-full max-h-[85vh] mt-auto rounded-t-2xl border-t",
          "sm:mt-0 sm:ms-auto sm:h-full sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-s-2xl sm:border-t-0 sm:border-s",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink-strong">
              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                المصدر [{citation.marker}]
              </span>
            </h2>
            <p className="mt-1 text-[13px] text-ink-dim break-words">{citation.fileName}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
              {citation.pageNumber !== null && (
                <span className="px-1.5 py-0.5 rounded bg-raised text-ink-dim">
                  صفحة {citation.pageNumber}
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded bg-raised text-ink-dim">
                {citation.verification === "exact"
                  ? "مطابق حرفيًا"
                  : "مطابق بعد تسوية التنسيق"}
              </span>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="shrink-0 p-1.5 rounded-lg text-ink-dim hover:text-ink-strong hover:bg-raised
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* المصدر المحذوف: تنبيه هادئ، والاقتباس التاريخي يبقى */}
          {!citation.sourceAvailable && (
            <p className="text-[12px] text-ink-dim bg-raised border border-line rounded-lg px-3 py-2">
              المصدر الأصلي لم يعد متاحًا.
            </p>
          )}

          {/* الاقتباس منفصلًا حين لا يمكن تمييزه داخل المقطع */}
          {(!quoteShownInChunk || !citation.sourceAvailable) && (
            <div>
              <h3 className="text-[12px] font-medium text-ink-dim mb-1.5">الاقتباس</h3>
              <blockquote className="border-s-2 border-primary/50 ps-3 py-1 text-[13px] leading-[1.9] text-ink whitespace-pre-wrap break-words">
                {citation.quote}
              </blockquote>
            </div>
          )}

          {citation.sourceAvailable && (
            <div>
              <h3 className="text-[12px] font-medium text-ink-dim mb-1.5">المقطع</h3>

              {state.status === "loading" && (
                <p className="text-[13px] text-ink-faint">جارٍ فتح المصدر…</p>
              )}

              {state.status === "error" && (
                <div className="space-y-2">
                  <p className="text-[13px] text-ink-dim">تعذّر فتح المصدر.</p>
                  <button
                    type="button"
                    onClick={load}
                    className="text-[12px] px-2.5 py-1 rounded-lg border border-line text-ink-dim
                               hover:text-ink-strong hover:border-ink-faint
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              )}

              {state.status === "ok" && (
                <div className="space-y-2.5">
                  {state.data.chunks.map((c) => (
                    <div
                      key={c.chunkId}
                      data-ysd-chunk={c.isTarget ? "target" : "neighbor"}
                      className={[
                        "rounded-lg px-3 py-2.5 border",
                        c.isTarget
                          ? "border-primary/30 bg-primary/5"
                          : "border-line bg-raised/40 opacity-70",
                      ].join(" ")}
                    >
                      <ChunkText content={c.content} highlight={c.isTarget ? highlight : null} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
