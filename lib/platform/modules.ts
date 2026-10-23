/**
 * وحدات منصّة YSD — الحدود المعمارية، ومصدر واحد لشريط التنقل.
 *
 * ── القاعدة ──
 *
 * لا يظهر في التنقل إلا ما يعمل فعلًا (`status: "available"` مع `href`). الوحدة
 * المخطَّطة مسجّلة هنا لتثبيت حدّها واسمها، لكنها **لا تُعرض** — فلا زرّ يوهم
 * بوظيفةٍ لم تُبنَ. وتحويل وحدةٍ إلى متاحة يعني صفحتها الفعلية أولًا، ثم سطرًا هنا.
 *
 * ما تملكه كل وحدة من مسارات ومكوّنات ومكتبات: docs/architecture/platform-modules.md
 */

import type { DictKey } from "@/lib/i18n";

export type PlatformModuleId =
  | "chat"
  | "projects"
  | "code"
  | "library"
  | "extensions"
  | "automations"
  | "models"
  | "settings";

export type PlatformModuleStatus = "available" | "planned";

/** مفاتيح أسماء الوحدات — نصوص قصيرة موجودة فعلًا في القاموس */
export type ModuleLabelKey = Extract<
  DictKey,
  | "moduleChat"
  | "moduleProjects"
  | "moduleLibrary"
  | "moduleCode"
  | "moduleExtensions"
  | "moduleAutomations"
  | "moduleModels"
  | "settings"
>;

export interface PlatformModule {
  id: PlatformModuleId;
  labelKey: ModuleLabelKey;
  status: PlatformModuleStatus;
  /** صفحة الوحدة الحالية — null للمخطَّطة */
  href: string | null;
  /** بادئات المسارات التي تملكها الوحدة (لتمييز الوحدة النشطة) */
  routes: readonly string[];
  /** موضعها في شريط الأيقونات: أعلاه، أو أسفله، أو خارجه */
  placement: "primary" | "secondary" | "none";
}

export const PLATFORM_MODULES: readonly PlatformModule[] = [
  { id: "chat", labelKey: "moduleChat", status: "available", href: "/chat", routes: ["/chat"], placement: "primary" },
  // المشاريع: مجلّداتٌ تجمع محادثاتٍ وملفات — لا مساعدٌ ينفّذ مهامّ؛ فلا تُسمّى «العمل» حتى يُبنى ذلك فعلًا
  { id: "projects", labelKey: "moduleProjects", status: "available", href: "/projects", routes: ["/projects"], placement: "primary" },
  // Library = الملفات المرفوعة وفهرسها (RAG)
  { id: "library", labelKey: "moduleLibrary", status: "available", href: "/files", routes: ["/files"], placement: "primary" },
  { id: "code", labelKey: "moduleCode", status: "planned", href: null, routes: [], placement: "primary" },
  { id: "extensions", labelKey: "moduleExtensions", status: "planned", href: null, routes: [], placement: "primary" },
  { id: "automations", labelKey: "moduleAutomations", status: "planned", href: null, routes: [], placement: "primary" },
  // Models: بوابة النماذج موجودة خادميًّا (lib/models) ولا صفحة مستخدم لها بعد
  { id: "models", labelKey: "moduleModels", status: "planned", href: null, routes: [], placement: "none" },
  { id: "settings", labelKey: "settings", status: "available", href: "/settings", routes: ["/settings"], placement: "secondary" },
];

export type NavModule = PlatformModule & { status: "available"; href: string };

const isNavigable = (m: PlatformModule): m is NavModule => m.status === "available" && m.href !== null;

/** وحدات شريط الأيقونات في موضعٍ معيّن — المتاحة فقط */
export function railModules(placement: "primary" | "secondary"): NavModule[] {
  return PLATFORM_MODULES.filter((m) => m.placement === placement).filter(isNavigable);
}

/** كل الوحدات المتاحة (للبحث السريع) */
export function availableModules(): NavModule[] {
  return PLATFORM_MODULES.filter(isNavigable);
}

/** الوحدة التي يقع فيها المسار — null لصفحاتٍ خارج الوحدات (الحساب، الاستهلاك) */
export function activeModuleId(pathname: string): PlatformModuleId | null {
  const hit = PLATFORM_MODULES.find((m) =>
    m.routes.some((r) => pathname === r || pathname.startsWith(`${r}/`)),
  );
  return hit?.id ?? null;
}
