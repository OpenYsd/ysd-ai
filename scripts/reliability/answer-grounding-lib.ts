/**
 * Answer-grounding acceptance — the pure parts (guards, fixtures, cases, verdicts). The runner is
 * answer-grounding.ts; these are unit-tested in tests/v143-answer-grounding-harness.test.ts.
 *
 * Synthetic documents only (no real person or organization); each carries facts that exist nowhere else,
 * so a correct answer can only come from the attached file, and a leaked one can only come from another
 * conversation.
 */
import { AR_DOC, APPENDIX, CV } from "../f2llm/calibration/crosslingual-fixtures";

export const PRODUCTION_REF = "mnewsldyrrlpmouetyve";

// ------------------------------------------------------------------ guards
export interface GuardInput {
  base: string;
  supabaseUrl: string;
  acceptance: boolean;
  allowProductionAcceptance: boolean;
}
/** null = allowed; otherwise the refusal reason. Production needs both explicit flags; anything else must be staging. */
export function refuseReason(g: GuardInput): string | null {
  if (!g.base || !g.supabaseUrl) return "required: --base and --supabase-url";
  const prod = g.supabaseUrl.includes(PRODUCTION_REF);
  if (prod && !(g.acceptance && g.allowProductionAcceptance)) return "production requires --acceptance --allow-production-acceptance";
  if (!prod && !/staging/i.test(g.base)) return "non-production runs target staging only";
  return null;
}

/** Service-role writes allowed in acceptance mode: creating the synthetic account's invite, nothing else. */
const ACCEPTANCE_WRITES = [/^beta_invites$/, /^rpc\/beta_claim_invite$/];
export function serviceWriteAllowed(acceptance: boolean, method: string, path: string): boolean {
  if (method === "GET") return true;
  if (!acceptance) return true;
  return ACCEPTANCE_WRITES.some((re) => re.test(path.split("?")[0]!));
}

// ------------------------------------------------------------------ fixtures
/** A minimal valid PDF (Helvetica, Latin text) — one page per 48 lines. */
export function buildPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids: string[] = [];
  for (const pg of pages) {
    const stream = `BT /F1 10 Tf 14 TL 50 800 Td ${pg.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const contentRef = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const SITE14 =
  "Warehouse audit notes - Site 14\n\nThe audit of Site 14 took place over three days. Most shelving met the safety standard.\n" +
  "The forklift inspection found one vehicle with worn brake pads, which was taken out of service.\n" +
  "The official stock discrepancy for Site 14 was 212 missing pallets of ceramic tiles, traced to a mislabeled shipment.\n" +
  "The auditor recommended a second count in the next quarter and new labels for aisle G.\n";
/** The Arabic report plus a generic appendix, so it is well past the full-read budget (ranked-search path). */
const AR_LONG =
  AR_DOC +
  "\n\n" +
  Array.from(
    { length: 8 },
    (_, i) =>
      `ملحق تشغيلي ${i + 1}: تراجع الإدارة إجراءات الاستلام والتوزيع في المستودع الرئيسي كل ربع سنة، وتحدّث نماذج الطلبات، ` +
      `وتدرّب الموظفين الجدد على نظام الأرشفة الإلكترونية، وتتابع مؤشرات رضا المستفيدين عبر استبانات قصيرة بعد كل زيارة ميدانية.`,
  ).join("\n\n");

export interface FixtureFile {
  name: string;
  mime: string;
  bytes: Buffer;
}
const portfolio = (): FixtureFile => ({ name: "Portfolio-long.pdf", mime: "application/pdf", bytes: buildPdf([...CV, ...APPENDIX]) });
const arReport = (): FixtureFile => ({ name: "التقرير-السنوي.txt", mime: "text/plain", bytes: Buffer.from(AR_LONG, "utf8") });

export type ConversationKey = "ar_en" | "en_ar" | "multi" | "small" | "empty";
export function conversationFiles(key: ConversationKey): FixtureFile[] {
  switch (key) {
    case "ar_en":
      return [portfolio()];
    case "en_ar":
      return [arReport()];
    case "multi":
      return [portfolio(), arReport(), { name: "site14-audit.txt", mime: "text/plain", bytes: Buffer.from(SITE14, "utf8") }];
    case "small":
      return [{ name: "CV-short.pdf", mime: "application/pdf", bytes: buildPdf(CV) }];
    case "empty":
      return [];
  }
}
/** How the server must have read the files (files_scope.mode): long documents are searched, small ones read whole. */
export const EXPECTED_MODE: Record<ConversationKey, string> = { ar_en: "search", en_ar: "search", multi: "search", small: "full", empty: "none" };

// ------------------------------------------------------------------ cases
export interface Case {
  conversation: ConversationKey;
  q: string;
  /** every pattern must match the answer */
  expect?: RegExp[];
  /** the answer is not in the attached files: the model must say so */
  absent?: boolean;
  /** facts from OTHER conversations — must never appear (cross-conversation leakage) */
  forbid?: RegExp[];
}
const TABUK = /(1[,.]?284[,.]?000|١[٬,.]?٢٨٤[٬,.]?٠٠٠)/;
/** Ordered by priority: a run cut short (quota, rollback) still covers what matters most. */
export const CASES: Case[] = [
  { conversation: "ar_en", q: "كم خفّض المشروع الذي قاده عام 2021 أوقات الانتظار؟", expect: [/(37|٣٧)/] },
  { conversation: "ar_en", q: "ما رقم الشارة الوظيفية؟", expect: [/QX-?7741-?ZETA/i] },
  { conversation: "ar_en", q: "بكم خفّض الإنفاق الشهري على البنية التحتية؟", expect: [/(ربع|25|٢٥|quarter)/i] },
  { conversation: "ar_en", q: "ما فصيلة دمه؟", absent: true },
  { conversation: "en_ar", q: "How many families benefited from the affordable housing program?", expect: [/(4,?318|٤٣١٨)/] },
  { conversation: "en_ar", q: "What is the internal accreditation code of this report?", expect: [/(٩٠٤|904)/] },
  { conversation: "en_ar", q: "What is the association's annual membership fee?", absent: true },
  { conversation: "multi", q: "How many pallets were missing at Site 14?", expect: [/\b212\b/] },
  { conversation: "multi", q: "ما الإيجار السنوي النهائي لمركز بيانات تبوك؟", expect: [TABUK] },
  { conversation: "multi", q: "How many volunteers took part in the winter campaign?", expect: [/(612|٦١٢)/] },
  { conversation: "multi", q: "What was the budget approved for Site 14 renovations?", absent: true },
  { conversation: "small", q: "ما رقم الشارة الوظيفية لصاحب السيرة الذاتية؟", expect: [/QX-?7741-?ZETA/i] },
  { conversation: "small", q: "What is his blood type?", absent: true },
  { conversation: "empty", q: "What is his employee badge number?", absent: true, forbid: [/QX-?7741/i] },
  { conversation: "empty", q: "How many volunteers took part in the winter campaign?", absent: true, forbid: [/(612|٦١٢)/] },
  { conversation: "empty", q: "ما الإيجار السنوي النهائي لمركز بيانات تبوك؟", absent: true, forbid: [/(1[,.]?284|١[٬,.]?٢٨٤)/] },
];

// ------------------------------------------------------------------ verdicts
export type Verdict = "PASS" | "FAIL" | "PASS_ABSENT" | "CHECK_ABSENT" | "LEAK" | "INCONCLUSIVE_PROVIDER";
const ABSENCE =
  /(لم أجد|غير موجود|غير مذكور|لا يتضمن|لا تتضمن|لا يحتوي|لا تحتوي|لم يرد|لم يُذكر|لا يذكر|لا تذكر|لا تشير|لا توجد معلومات|ليس(ت)? لدي|not (mentioned|found|included|specified|stated|provided|listed|contain)|doesn't (mention|contain|include|say)|does not (mention|contain|include|say)|no (mention|information|record))/i;

export interface Answer {
  status: number;
  text: string;
  /** metadata.completion.status of the saved assistant message */
  completion: string | null;
}
/** A provider outage is never an answer; a leak outranks everything else; absence must be stated, not implied. */
export function verdictFor(c: Case, a: Answer): Verdict {
  if (a.status !== 200 || !a.text.trim() || a.completion === "incomplete_provider") return "INCONCLUSIVE_PROVIDER";
  if (c.forbid?.some((re) => re.test(a.text))) return "LEAK";
  if (c.absent) return ABSENCE.test(a.text) ? "PASS_ABSENT" : "CHECK_ABSENT";
  return (c.expect ?? []).every((re) => re.test(a.text)) ? "PASS" : "FAIL";
}

/** Extracts the visible text from the chat route's SSE stream. */
export function parseSse(raw: string): { text: string; events: string[] } {
  let text = "";
  const events: string[] = [];
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim()) as { type?: string; text?: unknown };
      if (ev.type) events.push(ev.type);
      if (ev.type === "text" && typeof ev.text === "string") text += ev.text;
    } catch {
      /* keep-alive or partial frame */
    }
  }
  return { text, events };
}
