/**
 * خطّاف بدء تشغيل Next.js — يفحص متغيرات البيئة عند الإقلاع دون طباعة قيمها.
 * لا يوقف الخادم في التطوير؛ يحذّر فقط. في الإنتاج يمكن جعله صارمًا.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkEnv } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");

  const report = checkEnv();
  if (!report.ok) {
    logger.warn({
      event: "startup_env_check",
      status: "incomplete",
      // أسماء فقط — لا قيم
      code: [...report.missingRequired, ...report.invalidFormat].join(",") || "none",
    });
    if (process.env.NODE_ENV === "production" && process.env.YSD_STRICT_ENV === "1") {
      throw new Error(
        `بدء التشغيل مرفوض: متغيرات ناقصة/غير صحيحة → ${[
          ...report.missingRequired,
          ...report.invalidFormat,
        ].join(", ")}`,
      );
    }
  } else {
    logger.info({ event: "startup_env_check", status: "ok" });
  }
}
