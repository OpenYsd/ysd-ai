/**
 * فحص متغيرات البيئة — يتحقق من الوجود والصيغة دون طباعة أي قيمة.
 * يُستخدم عند بدء التشغيل وفي فحص الصحة.
 */
import { isValidAppOrigin } from "@/lib/http/origin";

interface EnvSpec {
  name: string;
  required: boolean;
  /** تحقق صيغة اختياري (لا يُطبع القيمة) */
  validate?: (v: string) => boolean;
  /** وصف للتشخيص */
  note: string;
}

const SPECS: EnvSpec[] = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    required: true,
    validate: (v) => /^https:\/\/.+\.supabase\.co\/?$/.test(v),
    note: "رابط مشروع Supabase",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    required: true,
    validate: (v) => v.length > 20,
    note: "المفتاح العام anon",
  },
  {
    name: "OPENROUTER_API_KEY",
    required: true,
    validate: (v) => v.startsWith("sk-or-") || v.length > 20,
    note: "مفتاح OpenRouter (الموفر الافتراضي المجاني)",
  },
  {
    /**
     * منه وحده تُبنى تحويلات الوسيط. مطلوب لأن غيابه ليس تدهورًا جزئيًا:
     * `absoluteRedirect` ترمي، فتردّ **كل صفحة محمية** 500 بدل التحويل إلى
     * /login. وقع هذا حيًّا على staging؛ ووجوده هنا يجعل الخلل يظهر عند
     * الإقلاع وفي /api/health بدل أن يُكتشف من تقرير مستخدم.
     */
    name: "APP_ORIGIN",
    required: true,
    validate: isValidAppOrigin,
    note: "العنوان العام للمنصّة — أصل تحويلات الوسيط",
  },
  { name: "ANTHROPIC_API_KEY", required: false, note: "موفر Anthropic (اختياري)" },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    required: false,
    note: "لعامل RAG المستقل فقط — غير مطلوب في الوضع request-driven",
  },
];

export interface EnvCheckItem {
  name: string;
  present: boolean;
  required: boolean;
  validFormat: boolean | null; // null إذا لا يوجد فحص صيغة
  note: string;
}

export interface EnvReport {
  ok: boolean;
  missingRequired: string[];
  invalidFormat: string[];
  items: EnvCheckItem[]; // بلا قيم — أسماء وحالة فقط
}

/** تقرير البيئة — أسماء وحالة فقط، لا قيم إطلاقًا */
export function checkEnv(): EnvReport {
  const items: EnvCheckItem[] = [];
  const missingRequired: string[] = [];
  const invalidFormat: string[] = [];

  for (const spec of SPECS) {
    const raw = process.env[spec.name];
    const present = typeof raw === "string" && raw.trim().length > 0;
    let validFormat: boolean | null = null;
    if (present && spec.validate) {
      validFormat = spec.validate(raw.trim());
      if (!validFormat) invalidFormat.push(spec.name);
    }
    if (spec.required && !present) missingRequired.push(spec.name);
    items.push({
      name: spec.name,
      present,
      required: spec.required,
      validFormat,
      note: spec.note,
    });
  }

  return {
    ok: missingRequired.length === 0 && invalidFormat.length === 0,
    missingRequired,
    invalidFormat,
    items,
  };
}

/** فحص بدء التشغيل — يرمي إن نقص متغير مطلوب (يُطبع الأسماء فقط) */
export function assertEnvAtStartup(): void {
  const report = checkEnv();
  if (report.missingRequired.length > 0) {
    throw new Error(
      `متغيرات بيئة مطلوبة ناقصة: ${report.missingRequired.join(", ")}`,
    );
  }
  if (report.invalidFormat.length > 0) {
    console.warn(
      `[env] صيغة غير متوقعة (تحقق من القيم): ${report.invalidFormat.join(", ")}`,
    );
  }
}
