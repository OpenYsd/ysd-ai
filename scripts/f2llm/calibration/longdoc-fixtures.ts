/**
 * Long, multi-topic synthetic documents for the long-document retrieval benchmark (longdoc-eval.ts).
 * Fictional organisations only. Every fact below appears exactly once, in the middle of a multi-topic paragraph,
 * next to near-duplicate distractors (same vocabulary, different numbers) — the hard case for chunk vectors.
 */

/** Deterministic PRNG so the documents are identical on every run. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ------------------------------------------------------------------ English handbook (~30 sections)
const EN_TOPICS = [
  "attendance", "annual leave", "business travel", "expense claims", "IT equipment", "information security", "workplace safety",
  "code of conduct", "training", "health insurance", "payroll", "performance reviews", "remote work", "procurement", "facilities",
  "internal communications", "visitor management", "fleet vehicles", "warehouse operations", "customer data", "overtime",
  "recruitment", "probation", "grievances", "environmental policy", "records retention", "mobile phones", "parking", "night shifts", "holidays",
];
const EN_FILLER = [
  (t: string) => `The ${t} policy applies to every full-time and part-time employee of Qalam Freight Company.`,
  (t: string) => `Managers review the ${t} guidelines once a year and publish any change on the staff portal.`,
  (t: string) => `Questions about ${t} should be sent to the people operations desk before the end of the working week.`,
  (t: string) => `Exceptions to the ${t} rules need a written justification and the approval of the department head.`,
  (t: string) => `Records related to ${t} are kept in the shared drive under the folder for the current financial year.`,
  (t: string) => `New joiners receive a short briefing on ${t} during their first week at the regional office.`,
  (t: string) => `Repeated breaches of the ${t} standard may lead to a formal warning after a documented conversation.`,
  (t: string) => `The ${t} procedure was last updated after feedback from the Dammam and Riyadh branches.`,
  (t: string) => `Team leads are expected to explain the practical effect of ${t} decisions to their teams.`,
  (t: string) => `Contractors follow the ${t} arrangements described in their individual service agreements.`,
];
/** section index → [fact sentence, distractor sentences] */
const EN_FACTS: Record<number, [string, string[]]> = {
  28: ["Employees who work the night shift receive a meal allowance of 38 riyals per shift.", ["Employees on the day shift receive a transport allowance of 25 riyals per day.", "Weekend shifts are paid at the standard hourly rate plus a fixed supplement."]],
  6: ["The emergency assembly point for Building C is the north parking lot beside gate 7.", ["The assembly point for Building A is the south lawn near the main reception.", "Fire drills are held twice a year in every building."]],
  4: ["Laptop replacements are approved by the IT asset committee, which meets on the second Tuesday of each month.", ["Monitors and keyboards can be requested directly through the service desk.", "Phones are replaced every three years."]],
  1: ["Annual leave carried over into the next year expires on the thirty-first of March.", ["Sick leave does not carry over from one year to the next.", "Leave requests longer than two weeks need three weeks of notice."]],
  2: ["The maximum hotel rate reimbursed in Jeddah is 640 riyals per night.", ["The maximum hotel rate reimbursed in Riyadh is 580 riyals per night.", "Airport transfers are reimbursed at cost with a receipt."]],
  16: ["Visitors must wear the orange lanyard at all times inside the warehouse.", ["Staff wear blue lanyards and contractors wear grey ones.", "Visitors sign in at reception and are escorted by their host."]],
  22: ["The probation period for engineering roles is one hundred and twenty days.", ["The probation period for administrative roles is ninety days.", "Probation reviews are held two weeks before the period ends."]],
  20: ["Overtime above twelve hours in a week requires written approval from the regional director.", ["Overtime below four hours in a week needs only the line manager's agreement.", "Overtime is paid in the following payroll cycle."]],
};
export function buildEnglishHandbook(): string {
  const rand = prng(7);
  const out: string[] = ["QALAM FREIGHT COMPANY — EMPLOYEE HANDBOOK", ""];
  EN_TOPICS.forEach((topic, i) => {
    out.push(`SECTION ${i + 1}: ${topic.toUpperCase()}`);
    const pick = () => EN_FILLER[Math.floor(rand() * EN_FILLER.length)]!(topic);
    const [fact, distractors] = EN_FACTS[i] ?? [null, []];
    const p1 = [pick(), pick(), ...(distractors.slice(0, 1)), pick()];
    const p2 = [pick(), ...(fact ? [fact] : []), ...(distractors.slice(1)), pick(), pick()];
    out.push(p1.join(" "), "", p2.join(" "), "");
  });
  return out.join("\n");
}

// ------------------------------------------------------------------ Arabic operations manual (~25 sections)
const AR_TOPICS = [
  "الاستلام", "التخزين", "غرف التبريد", "الجرد", "السلامة من الحرائق", "الرافعات الشوكية", "الشحن الدولي", "الشحن المحلي", "المرتجعات",
  "المشتريات", "الموردون", "الأمن", "الكاميرات", "النظافة", "الصيانة", "التدريب", "المناوبات", "الطوارئ", "التقارير", "الجودة",
  "التغليف", "الملصقات", "الأسطول", "الوقود", "المخلفات",
];
const AR_FILLER = [
  (t: string) => `تنطبق إجراءات ${t} على جميع مستودعات شركة النخبة للإمداد في المنطقة الشرقية.`,
  (t: string) => `يراجع مشرف الوردية تعليمات ${t} في بداية كل أسبوع ويوثّق الملاحظات في النظام.`,
  (t: string) => `تُرفع الاستفسارات المتعلقة بـ${t} إلى إدارة العمليات عبر نموذج الطلبات الإلكتروني.`,
  (t: string) => `أي استثناء من قواعد ${t} يحتاج إلى موافقة مكتوبة من مدير الفرع.`,
  (t: string) => `تُحفظ سجلات ${t} في الأرشيف الإلكتروني حسب السنة المالية الجارية.`,
  (t: string) => `يتلقى الموظفون الجدد تعريفًا مختصرًا بإجراءات ${t} خلال أسبوعهم الأول.`,
  (t: string) => `تتكرر مخالفة تعليمات ${t} قد تؤدي إلى إنذار كتابي بعد محضر رسمي.`,
  (t: string) => `حُدّثت إجراءات ${t} بعد ملاحظات فرعي الدمام والجبيل في الربع الماضي.`,
];
const AR_FACTS: Record<number, [string, string[]]> = {
  2: ["يجب ألا تتجاوز درجة حرارة غرفة التبريد رقم ٣ أربع درجات مئوية.", ["غرفة التبريد رقم ١ مخصصة للأدوية وتُراقب كل ساعتين.", "تُنظف غرف التبريد مرة كل شهر."]],
  3: ["تُجرى مراجعة المخزون الشاملة في الأسبوع الأخير من شهر ذي القعدة.", ["يُجرى الجرد الجزئي للأصناف سريعة الحركة كل أسبوعين.", "تُطابق نتائج الجرد مع النظام المحاسبي."]],
  17: ["رمز الطوارئ الداخلي للإبلاغ عن الحرائق هو نجمة-٢١.", ["رمز الإخلاء العام يُعلن عبر مكبرات الصوت.", "تُختبر أجهزة الإنذار كل ثلاثة أشهر."]],
  5: ["الحد الأقصى لحمولة الرافعة الشوكية الكهربائية ألفان وخمسمئة كيلوغرام.", ["الرافعة اليدوية مخصصة للمنصات الخفيفة داخل الممرات.", "تُشحن بطاريات الرافعات في غرفة الشحن المخصصة."]],
  6: ["يُسمح بتأخير الشحنات الدولية حتى ثمانٍ وأربعين ساعة دون غرامة.", ["الشحنات المحلية تُسلّم خلال يومي عمل.", "تُرفق شهادة المنشأ مع كل شحنة دولية."]],
  11: ["مسؤولة السلامة في الفرع الشرقي هي المهندسة هيفاء العتيبي.", ["مسؤول الأمن في الفرع الشمالي يتابع بطاقات الدخول.", "تُعقد اجتماعات السلامة الشهرية يوم الأحد."]],
  12: ["تُحفظ تسجيلات كاميرات المراقبة لمدة تسعين يومًا.", ["تُراجع تسجيلات البوابات عند أي حادثة موثقة.", "تُصان الكاميرات الخارجية مرتين في السنة."]],
  9: ["خصم الدفع المبكر للموردين اثنان بالمئة إذا سُدّدت الفاتورة خلال عشرة أيام.", ["تُسدّد فواتير الموردين خلال ثلاثين يومًا من الاستلام.", "يُقيَّم أداء الموردين كل ستة أشهر."]],
};
export function buildArabicManual(): string {
  const rand = prng(11);
  const out: string[] = ["دليل التشغيل لمستودعات شركة النخبة للإمداد", ""];
  AR_TOPICS.forEach((topic, i) => {
    out.push(`القسم ${i + 1}: ${topic}`);
    const pick = () => AR_FILLER[Math.floor(rand() * AR_FILLER.length)]!(topic);
    const [fact, distractors] = AR_FACTS[i] ?? [null, []];
    const p1 = [pick(), pick(), ...(distractors.slice(0, 1)), pick()];
    const p2 = [pick(), ...(fact ? [fact] : []), ...(distractors.slice(1)), pick(), pick()];
    out.push(p1.join(" "), "", p2.join(" "), "");
  });
  return out.join("\n");
}

export type LongDocKey = "handbook" | "manual";
export interface LongQ {
  doc: LongDocKey | "portfolio" | "report";
  lang: "en" | "ar";
  q: string;
  goldSubstring: string;
}
export const LONG_QUESTIONS: LongQ[] = [
  { doc: "handbook", lang: "en", q: "How much is the meal allowance for the night shift?", goldSubstring: "meal allowance of 38 riyals" },
  { doc: "handbook", lang: "ar", q: "كم بدل الوجبة لمن يعمل في المناوبة الليلية؟", goldSubstring: "meal allowance of 38 riyals" },
  { doc: "handbook", lang: "en", q: "Where is the emergency assembly point for Building C?", goldSubstring: "Building C is the north parking lot" },
  { doc: "handbook", lang: "ar", q: "أين نقطة التجمع في حالات الطوارئ للمبنى C؟", goldSubstring: "Building C is the north parking lot" },
  { doc: "handbook", lang: "en", q: "Who approves laptop replacements and when do they meet?", goldSubstring: "IT asset committee" },
  { doc: "handbook", lang: "ar", q: "من يوافق على استبدال أجهزة اللابتوب ومتى يجتمع؟", goldSubstring: "IT asset committee" },
  { doc: "handbook", lang: "en", q: "When does carried-over annual leave expire?", goldSubstring: "expires on the thirty-first of March" },
  { doc: "handbook", lang: "ar", q: "متى تنتهي صلاحية الإجازة السنوية المرحّلة؟", goldSubstring: "expires on the thirty-first of March" },
  { doc: "handbook", lang: "en", q: "What is the maximum hotel rate reimbursed in Jeddah?", goldSubstring: "Jeddah is 640 riyals" },
  { doc: "handbook", lang: "ar", q: "ما أعلى سعر فندق يُعوَّض في جدة؟", goldSubstring: "Jeddah is 640 riyals" },
  { doc: "handbook", lang: "en", q: "What colour lanyard must visitors wear in the warehouse?", goldSubstring: "orange lanyard" },
  { doc: "handbook", lang: "ar", q: "ما لون شريط التعريف الذي يجب أن يرتديه الزوار في المستودع؟", goldSubstring: "orange lanyard" },
  { doc: "handbook", lang: "en", q: "How long is the probation period for engineering roles?", goldSubstring: "engineering roles is one hundred and twenty days" },
  { doc: "handbook", lang: "ar", q: "كم مدة فترة التجربة للوظائف الهندسية؟", goldSubstring: "engineering roles is one hundred and twenty days" },
  { doc: "handbook", lang: "en", q: "Who must approve overtime above twelve hours a week?", goldSubstring: "regional director" },
  { doc: "handbook", lang: "ar", q: "من يجب أن يوافق على العمل الإضافي الذي يتجاوز اثنتي عشرة ساعة أسبوعيًا؟", goldSubstring: "regional director" },
  { doc: "manual", lang: "ar", q: "ما الحد الأقصى لدرجة حرارة غرفة التبريد رقم ٣؟", goldSubstring: "غرفة التبريد رقم ٣ أربع درجات" },
  { doc: "manual", lang: "en", q: "What is the maximum temperature for cold room number 3?", goldSubstring: "غرفة التبريد رقم ٣ أربع درجات" },
  { doc: "manual", lang: "ar", q: "متى تُجرى مراجعة المخزون الشاملة؟", goldSubstring: "الأسبوع الأخير من شهر ذي القعدة" },
  { doc: "manual", lang: "en", q: "When is the full inventory review carried out?", goldSubstring: "الأسبوع الأخير من شهر ذي القعدة" },
  { doc: "manual", lang: "ar", q: "ما رمز الطوارئ الداخلي للإبلاغ عن الحرائق؟", goldSubstring: "نجمة-٢١" },
  { doc: "manual", lang: "en", q: "What is the internal emergency code for reporting a fire?", goldSubstring: "نجمة-٢١" },
  { doc: "manual", lang: "ar", q: "ما الحمولة القصوى للرافعة الشوكية الكهربائية؟", goldSubstring: "ألفان وخمسمئة كيلوغرام" },
  { doc: "manual", lang: "en", q: "What is the maximum load of the electric forklift?", goldSubstring: "ألفان وخمسمئة كيلوغرام" },
  { doc: "manual", lang: "ar", q: "كم ساعة يُسمح بتأخير الشحنات الدولية دون غرامة؟", goldSubstring: "ثمانٍ وأربعين ساعة" },
  { doc: "manual", lang: "en", q: "How long can international shipments be delayed without a penalty?", goldSubstring: "ثمانٍ وأربعين ساعة" },
  { doc: "manual", lang: "ar", q: "من مسؤولة السلامة في الفرع الشرقي؟", goldSubstring: "هيفاء العتيبي" },
  { doc: "manual", lang: "en", q: "Who is the safety officer of the eastern branch?", goldSubstring: "هيفاء العتيبي" },
  { doc: "manual", lang: "ar", q: "كم مدة حفظ تسجيلات كاميرات المراقبة؟", goldSubstring: "تسعين يومًا" },
  { doc: "manual", lang: "en", q: "How long are CCTV recordings kept?", goldSubstring: "تسعين يومًا" },
  { doc: "manual", lang: "ar", q: "كم خصم الدفع المبكر للموردين؟", goldSubstring: "خصم الدفع المبكر للموردين اثنان بالمئة" },
  { doc: "manual", lang: "en", q: "What is the early payment discount for suppliers?", goldSubstring: "خصم الدفع المبكر للموردين اثنان بالمئة" },
  // the known staging miss and other portfolio/report facts, asked inside the big multi-file scope
  { doc: "portfolio", lang: "en", q: "How long is his notice period?", goldSubstring: "Notice period: sixty days" },
  { doc: "portfolio", lang: "ar", q: "كم خفّض المشروع الذي قاده عام 2021 أوقات الانتظار؟", goldSubstring: "Blue Heron" },
  { doc: "portfolio", lang: "ar", q: "بكم خفّض الإنفاق الشهري على البنية التحتية؟", goldSubstring: "roughly a quarter" },
  { doc: "portfolio", lang: "en", q: "What is the final annual rent of the Tabuk data center lease?", goldSubstring: "1,284,000" },
  { doc: "report", lang: "en", q: "How many volunteers took part in the winter campaign?", goldSubstring: "612 متطوعًا" },
  { doc: "report", lang: "ar", q: "ما رمز الاعتماد الداخلي للتقرير؟", goldSubstring: "ع-٩٠٤-نخيل" },
  { doc: "report", lang: "en", q: "How many families did the Qatif branch serve?", goldSubstring: "القطيف خدماته إلى 184" },
];
