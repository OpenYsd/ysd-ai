"use client";

import { forwardRef } from "react";

import type { ClientCitation } from "@/lib/evidence/client-citation";

/**
 * زرّ الاستشهاد `[1]` (v0.9.0، الإيداع الثامن).
 *
 * ── لماذا `button` لا `span` ──
 *
 * يفتح لوحة. و`span` بمستمع نقر لا يبلغه Tab ولا مسافة ولا Enter، ولا يُعلنه
 * قارئ الشاشة زرًّا. الفرق ليس تجميليًا: من لا يستعمل فأرة يفقد الميزة كلها.
 *
 * ── ولماذا `dir="ltr"` وعزل ثنائي الاتجاه ──
 *
 * `[1]` أرقامٌ وأقواس داخل نصّ عربي. وبغير العزل تُعيد خوارزمية Unicode ترتيب
 * القوسين حول الرقم حسب ما يجاورهما، فيظهر `]1[` أو ينزلق القوس إلى الكلمة
 * التالية. `isolate` يجعل الزرّ وحدةً مستقلة لا تتفاوض مع جيرانها.
 *
 * ── وما لا يُعرض ──
 *
 * لا `relevance` ولا الاقتباس كاملًا. الرقم مقبضٌ يفتح المصدر، والاقتباس يُقرأ
 * في اللوحة حيث يُعرض مع سياقه — أما داخل الرد فيصير حشوًا يُربك القراءة.
 */

export interface CitationButtonProps {
  citation: ClientCitation;
  onOpen: (citation: ClientCitation) => void;
}

export const CitationButton = forwardRef<HTMLButtonElement, CitationButtonProps>(
  function CitationButton({ citation, onOpen }, ref) {
    const page =
      citation.pageNumber !== null ? `، صفحة ${citation.pageNumber}` : "";
    const unavailable = citation.sourceAvailable ? "" : " (لم يعد متاحًا)";

    return (
      <button
        ref={ref}
        type="button"
        onClick={() => onOpen(citation)}
        dir="ltr"
        style={{ unicodeBidi: "isolate" }}
        data-ysd-citation={citation.marker}
        aria-label={`المصدر ${citation.marker}: ${citation.fileName}${page}${unavailable}`}
        title={`${citation.fileName}${page}`}
        className={[
          "inline-flex items-center justify-center align-baseline",
          // صغير كي لا يقطع سطر العربية، وبهامش جانبي لا رأسي
          "mx-0.5 min-w-[1.6em] h-[1.4em] px-1 rounded-md",
          "text-[0.78em] font-medium leading-none tabular-nums",
          "border transition-colors select-none",
          citation.sourceAvailable
            ? "border-primary/40 bg-primary/10 text-primary-glow hover:bg-primary/20 hover:border-primary/60"
            : // المحذوف باهت لكنه يبقى قابلًا للفتح — الاستشهاد تاريخٌ لا رابط
              "border-line bg-raised text-ink-dim hover:text-ink hover:border-ink-faint",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg",
        ].join(" ")}
      >
        [{citation.marker}]
      </button>
    );
  },
);

/**
 * صفّ أزرار فقرةٍ واحدة.
 *
 * الترتيب تصاعديّ والأرقام بلا تكرار — والفرز هنا لا يعتمد على ترتيب المصدر:
 * الأزرار تُقرأ يمينًا ويسارًا فترتيبها جزءٌ من معناها.
 */
export function CitationRow({
  citations,
  onOpen,
  buttonRef,
}: {
  citations: ClientCitation[];
  onOpen: (citation: ClientCitation) => void;
  buttonRef?: (marker: number, el: HTMLButtonElement | null) => void;
}) {
  if (citations.length === 0) return null;

  const seen = new Set<number>();
  const unique = citations
    .filter((c) => (seen.has(c.marker) ? false : (seen.add(c.marker), true)))
    .sort((a, b) => a.marker - b.marker);

  return (
    <span className="inline whitespace-nowrap" data-ysd-citation-row="">
      {unique.map((c) => (
        <CitationButton
          key={`${c.segmentIndex}:${c.marker}`}
          citation={c}
          onOpen={onOpen}
          ref={buttonRef ? (el) => buttonRef(c.marker, el) : undefined}
        />
      ))}
    </span>
  );
}

/**
 * وسم الفقرة غير الموثّقة.
 *
 * الصياغة مقصودة: «غير موثق» لا «غير صحيح». الفرق بين «لم نتحقق من مصدر لهذا»
 * و«هذا خطأ» هو الفرق بين إفادةٍ صادقة وحكمٍ لا نملكه — والفقرة قد تكون صحيحة
 * تمامًا ولم يجد النموذج لها اقتباسًا حرفيًا.
 *
 * ولهذا الوسم هادئ ولا تُصبغ الفقرة بالأحمر: التلوين الكامل يقرأه المستخدم
 * تحذيرًا من خطأ، فيشكّ فيما لا موجب للشكّ فيه.
 */
export function UnsupportedBadge() {
  return (
    <span
      className="inline-flex items-center align-baseline mx-1 px-1.5 h-[1.4em] rounded-md
                 border border-line bg-raised text-ink-faint text-[0.72em] leading-none
                 select-none cursor-help"
      title="لم نتمكن من التحقق من مصدر لهذه الفقرة."
      aria-label="غير موثق: لم نتمكن من التحقق من مصدر لهذه الفقرة."
      data-ysd-unsupported=""
    >
      غير موثق
    </span>
  );
}
