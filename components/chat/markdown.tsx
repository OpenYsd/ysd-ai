"use client";

/** عرض Markdown حقيقي: عناوين، قوائم، جداول، كتل كود مع زر نسخ */

import { createElement, isValidElement, memo, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/lib/i18n";
import type { ClientCitation } from "@/lib/evidence/client-citation";
import { CitationRow, UnsupportedBadge } from "@/components/chat/citation-button";
import {
  readSegmentAttr,
  readSegmentFromNode,
  remarkEvidenceSegments,
  segmentLinesFor,
} from "@/components/chat/evidence-segments";

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // <pre> يحتوي <code className="language-x">النص</code>
  let lang = "code";
  let text = "";
  if (isValidElement(children)) {
    const el = children as React.ReactElement<{
      className?: string;
      children?: React.ReactNode;
    }>;
    lang = /language-(\w+)/.exec(el.props.className ?? "")?.[1] ?? "code";
    text = String(el.props.children ?? "").replace(/\n$/, "");
  } else {
    text = String(children ?? "");
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div dir="ltr" className="my-3 rounded-xl overflow-hidden border border-line bg-night">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-line">
        <span className="text-[11px] text-ink-faint font-mono">{lang}</span>
        <button
          onClick={() => void copy()}
          className="text-[11px] text-ink-dim hover:text-ink-strong transition-colors"
        >
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[13px] leading-relaxed text-ink font-mono">
        {text}
      </pre>
    </div>
  );
}

export interface MarkdownEvidence {
  /** استشهادات الرسالة — مجمّعة بالفقرة عند العرض */
  citations: ClientCitation[];
  /** أرقام الفقرات غير الموثّقة — تُعرض فقط حين يكون الوضع فعّالًا */
  unsupportedSegments: number[];
  onOpenCitation: (citation: ClientCitation) => void;
  /** لإعادة التركيز إلى الزرّ بعد إغلاق اللوحة */
  registerButton?: (segmentIndex: number, marker: number, el: HTMLButtonElement | null) => void;
}

/**
 * الكتل التي قد تكون آخر عقدة في فقرة — وحدها تُغلَّف.
 *
 * `pre` منها: الزرّ يقع **بعد** سياج الشيفرة لا داخله. و`code` ليست منها
 * إطلاقًا، فلا سبيل لأن يدخل استشهاد شيفرةً سطرية.
 */
const BLOCK_TAGS = ["p", "ul", "ol", "table", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"] as const;

export const Markdown = memo(function Markdown({
  text,
  evidence,
}: {
  text: string;
  evidence?: MarkdownEvidence;
}) {
  /**
   * ★ بلا أدلة: **نفس المسار القديم حرفًا بحرف**.
   *
   * لا إضافة remark، ولا تغليف عناصر، ولا حساب أسطر. الرسائل التي لا تحمل
   * استشهادًا — وهي كل ما سبق v0.9 — تُعرض بالشجرة نفسها، فلا فرق في الشكل
   * ولا في الترطيب.
   */
  const active =
    evidence !== undefined &&
    (evidence.citations.length > 0 || evidence.unsupportedSegments.length > 0);

  const bySegment = useMemo(() => {
    const map = new Map<number, ClientCitation[]>();
    if (!active || !evidence) return map;
    for (const c of evidence.citations) {
      const list = map.get(c.segmentIndex);
      if (list) list.push(c);
      else map.set(c.segmentIndex, [c]);
    }
    return map;
  }, [active, evidence]);

  const lineSegments = useMemo(
    () => (active ? segmentLinesFor(text) : []),
    [active, text],
  );

  const unsupported = useMemo(
    () => new Set(active && evidence ? evidence.unsupportedSegments : []),
    [active, evidence],
  );

  /** يُغلّف كتلةً: العنصر كما هو، ثم الأزرار والوسم إن كانت الفقرة موسومة */
  const blockComponents = useMemo(() => {
    if (!active || !evidence) return {};
    const made: Record<string, unknown> = {};
    for (const tag of BLOCK_TAGS) {
      made[tag] = function EvidenceBlock({
        children,
        node,
        ...rest
      }: {
        children?: React.ReactNode;
        node?: unknown;
      } & Record<string, unknown>) {
        // الخصائص أولًا، ثم العقدة — لأن سياج الشيفرة يحمل السمة على ابنه
        const segment = readSegmentAttr(rest) ?? readSegmentFromNode(node);
        const citations = segment === null ? [] : (bySegment.get(segment) ?? []);
        const isUnsupported = segment !== null && unsupported.has(segment);

        // نزع سمتنا كي لا تصل إلى DOM
        const domProps = { ...rest };
        delete domProps["data-ysd-segment"];

        const trail =
          citations.length > 0 || isUnsupported ? (
            <>
              {isUnsupported ? <UnsupportedBadge /> : null}
              <CitationRow
                citations={citations}
                onOpen={evidence.onOpenCitation}
                buttonRef={
                  evidence.registerButton && segment !== null
                    ? (marker, el) => evidence.registerButton!(segment, marker, el)
                    : undefined
                }
              />
            </>
          ) : null;

        /**
         * الفقرة النصّية تحمل الأزرار **داخلها** فتنساب مع آخر سطر. وغيرها
         * (قائمة، جدول، سياج) يحملها بعده: الإدخال داخل تلك البنى يفسدها.
         */
        if (tag === "p") {
          return createElement("p", domProps, children, trail);
        }
        // سياج الشيفرة يبقى بزرّ النسخ — الاستشهاد بعده لا داخله
        const block =
          tag === "pre" ? <CodeBlock>{children}</CodeBlock> : createElement(tag, domProps, children);
        return (
          <>
            {block}
            {trail ? <div className="mt-1 mb-2">{trail}</div> : null}
          </>
        );
      };
    }
    return made;
  }, [active, evidence, bySegment, unsupported]);

  return (
    <div className="text-[14px] leading-[1.85] break-words [&>p]:my-2 [&>h1]:mt-4 [&>h1]:mb-1.5 [&>h1]:font-bold [&>h1]:text-[19px] [&>h1]:text-ink-strong [&>h2]:mt-4 [&>h2]:mb-1.5 [&>h2]:font-bold [&>h2]:text-[17px] [&>h2]:text-ink-strong [&>h3]:mt-3 [&>h3]:mb-1 [&>h3]:font-bold [&>h3]:text-[15px] [&>h3]:text-ink-strong [&>ul]:my-2 [&>ul]:ps-5 [&>ul]:space-y-1.5 [&>ul]:list-disc [&>ol]:my-2 [&>ol]:ps-5 [&>ol]:space-y-1.5 [&>ol]:list-decimal [&_li]:leading-relaxed [&_strong]:font-semibold [&_strong]:text-ink-strong [&_a]:text-primary-glow [&_a]:underline [&_blockquote]:border-s-2 [&_blockquote]:border-primary/50 [&_blockquote]:ps-3 [&_blockquote]:my-2 [&_blockquote]:text-ink-dim [&_table]:my-3 [&_table]:w-full [&_table]:text-[13px] [&_th]:border [&_th]:border-line [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:bg-surface [&_th]:text-ink-strong [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_hr]:my-4 [&_hr]:border-line">
      <ReactMarkdown
        /**
         * الصيغة الثنائية `[إضافة, خيارات]` هي ما تتوقّعه unified: تنادي
         * الإضافة بالخيارات فتُعيد المحوّل. وتمريرُ `remarkEvidenceSegments(x)`
         * مباشرةً كان يُمرّر **المحوّل** في موضع الإضافة، فتُنادى بالخيارات بدل
         * الشجرة وتنهار عند أول قراءة لـ`children`.
         */
        remarkPlugins={
          active ? [remarkGfm, [remarkEvidenceSegments, lineSegments]] : [remarkGfm]
        }
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // بعد `pre` عمدًا: النسخة الواعية بالأدلة تعرض CodeBlock نفسه وتزيد
          // عليه صفّ الأزرار، فيجب أن تفوز حين يكون الوضع فعّالًا
          ...blockComponents,
          code: ({ children, className }) =>
            className ? (
              // داخل كتلة — يعرضه CodeBlock
              <code className={className}>{children}</code>
            ) : (
              <code
                dir="ltr"
                className="px-1.5 py-0.5 rounded bg-raised text-primary-glow text-[0.85em]"
              >
                {children}
              </code>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
