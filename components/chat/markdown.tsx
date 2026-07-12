"use client";

/** عرض Markdown حقيقي: عناوين، قوائم، جداول، كتل كود مع زر نسخ */

import { isValidElement, memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "@/lib/i18n";

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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[14px] leading-[1.85] break-words [&>p]:my-2 [&>h1]:mt-4 [&>h1]:mb-1.5 [&>h1]:font-bold [&>h1]:text-[19px] [&>h1]:text-ink-strong [&>h2]:mt-4 [&>h2]:mb-1.5 [&>h2]:font-bold [&>h2]:text-[17px] [&>h2]:text-ink-strong [&>h3]:mt-3 [&>h3]:mb-1 [&>h3]:font-bold [&>h3]:text-[15px] [&>h3]:text-ink-strong [&>ul]:my-2 [&>ul]:ps-5 [&>ul]:space-y-1.5 [&>ul]:list-disc [&>ol]:my-2 [&>ol]:ps-5 [&>ol]:space-y-1.5 [&>ol]:list-decimal [&_li]:leading-relaxed [&_strong]:font-semibold [&_strong]:text-ink-strong [&_a]:text-primary-glow [&_a]:underline [&_blockquote]:border-s-2 [&_blockquote]:border-primary/50 [&_blockquote]:ps-3 [&_blockquote]:my-2 [&_blockquote]:text-ink-dim [&_table]:my-3 [&_table]:w-full [&_table]:text-[13px] [&_th]:border [&_th]:border-line [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:bg-surface [&_th]:text-ink-strong [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_hr]:my-4 [&_hr]:border-line">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
