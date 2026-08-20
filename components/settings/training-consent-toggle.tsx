"use client";

/**
 * إذن المساهمة في تحسين YSD (v0.9.4) — **الافتراض إيقاف، والفشل مغلق**.
 *
 * ── ما يقوله هذا الخيار وما لا يقوله ──
 *
 * تشغيله **إذنٌ مبدئيّ** لا أكثر: لا يُدخل محادثةً إلى التدريب، ولا يُدرّب
 * نموذجًا، ولا يمسّ ما مضى. واختيار المحادثات التي تُشارَك يأتي لاحقًا.
 *
 * ونصُّ الواجهة يقول ذلك صراحةً. فلو كتبنا «ستُستخدم محادثاتك» لَوافق
 * الناس على شيءٍ لا يقع، ثم شعروا بالخديعة يوم يقع غيره.
 *
 * ── ولماذا لا تفاؤل في الحالة ──
 *
 * إذنٌ يظهر مفعَّلًا ولم يُسجَّل أسوأ من زرٍّ بطيء: يظنّ صاحبه أنه أذن ولم
 * يأذن، أو أنه سحب إذنه ولم يسحبه. فلا تتغيّر الحالة إلا بعد أن يؤكّد
 * الخادم — وأي تعذّرٍ يُرجعها كما كانت.
 */

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

/** ما يُقرأ من `GET /api/training-consent` — الحقول التي تعنينا وحدها */
interface ConsentResponse {
  enabled?: unknown;
  active?: unknown;
  acceptedPolicyVersion?: unknown;
}

type Phase = "loading" | "ready" | "unavailable";

export function TrainingConsentToggle() {
  const { t, locale } = useI18n();
  const ar = locale === "ar";

  const [phase, setPhase] = useState<Phase>("loading");
  const [active, setActive] = useState(false);
  /**
   * ★ موافقةٌ قديمة لم تعد سارية.
   *
   * `enabled=true` مع `active=false` تعني أن ما وافق عليه صاحبها كان نصًّا
   * آخر. فيُعرض الخيار **مطفأً** — لأنه مطفأ فعلًا — ويُقال له لماذا، بدل
   * أن يُترك يحسب أن إذنه قائم.
   */
  const [needsReconsent, setNeedsReconsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"enabled" | "disabled" | "error" | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/training-consent", { method: "GET" });
        if (!res.ok) throw new Error("unavailable");
        const body = (await res.json()) as ConsentResponse;
        if (!alive) return;
        const isActive = body.active === true;
        setActive(isActive);
        setNeedsReconsent(body.enabled === true && !isActive);
        setPhase("ready");
      } catch {
        // ★ الفشل مغلق: لا يُفترض إذنٌ لم يُقرأ
        if (!alive) return;
        setActive(false);
        setNeedsReconsent(false);
        setPhase("unavailable");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setNotice(null);
      const previous = active;
      const previousReconsent = needsReconsent;
      try {
        const res = await fetch("/api/training-consent", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // ★ حقلٌ واحد — الهوية من الجلسة، والباقي يملكه الخادم
          body: JSON.stringify({ enabled: next }),
        });
        if (!res.ok) throw new Error("patch_failed");
        const body = (await res.json()) as ConsentResponse;
        const isActive = body.active === true;
        setActive(isActive);
        setNeedsReconsent(body.enabled === true && !isActive);
        setNotice(isActive ? "enabled" : "disabled");
      } catch {
        // ★ ترجع الحالة كما كانت — فلا تكذب الواجهة بعد فشل الشبكة
        setActive(previous);
        setNeedsReconsent(previousReconsent);
        setNotice("error");
      } finally {
        setBusy(false);
      }
    },
    [active, needsReconsent],
  );

  const disabled = busy || phase !== "ready";

  return (
    <section className="rounded-2xl border border-line bg-surface/60 p-5">
      <h2 className="text-[13px] font-medium text-ink-strong mb-3">
        {t("trainingConsentSection")}
      </h2>

      <label className="flex items-start gap-3 cursor-pointer">
        {/**
         * ★ خانةٌ أصلية لا `div` قابلٌ للنقر.
         *
         * فتأتي معها دلالاتُ المتصفّح كلها: التركيز، والمسافة، وقارئ الشاشة،
         * وحالة التعطيل. وكل ذلك يُعاد بناؤه يدويًّا — وناقصًا — في عنصرٍ
         * ليس عنصر تحكّم.
         */}
        <input
          type="checkbox"
          checked={active}
          disabled={disabled}
          onChange={(e) => void toggle(e.target.checked)}
          aria-describedby="training-consent-desc"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-line bg-raised accent-primary
                     focus:outline-none focus:ring-2 focus:ring-primary/50
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <span className="min-w-0">
          <span className="block text-[13px] text-ink-strong">{t("trainingConsentTitle")}</span>
          <span id="training-consent-desc" className="block text-[12px] text-ink-dim mt-1 leading-relaxed">
            {t("trainingConsentDescription")}
          </span>
        </span>
      </label>

      {/**
       * ★ الملاحظة دائمة لا تظهر عند التشغيل وحده.
       *
       * لأن من يقرأ قبل أن يقرّر أحقّ بها ممن قرّر. وإخفاؤها حتى الضغط
       * يجعلها اعتذارًا بعد الفعل لا معلومةً قبله.
       */}
      <p className="text-[12px] text-ink-faint mt-3 leading-relaxed">
        {t("trainingConsentNotice")}
      </p>
      <p className="text-[12px] text-ink-faint mt-1.5">{t("trainingConsentReversible")}</p>

      {needsReconsent && (
        <p className="text-[12px] text-amber-400 mt-3">{t("trainingConsentReconsent")}</p>
      )}

      {phase === "unavailable" && (
        <p className="text-[12px] text-ink-faint mt-3">
          {ar ? "تعذّر تحميل إعداد المشاركة." : "Could not load the sharing preference."}
        </p>
      )}

      {notice === "enabled" && (
        <p role="status" className="text-[12px] text-emerald-400 mt-3">
          {t("trainingConsentOn")}
        </p>
      )}
      {notice === "disabled" && (
        <p role="status" className="text-[12px] text-ink-dim mt-3">
          {t("trainingConsentOff")}
        </p>
      )}
      {notice === "error" && (
        <p role="alert" className="text-[12px] text-red-400 mt-3">
          {t("trainingConsentError")}
        </p>
      )}
    </section>
  );
}
