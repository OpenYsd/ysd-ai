"use client";

/**
 * سطحُ الاكتشاف — حالةُ المحرّك المحلّيّ، ورمزُ الجلسة.
 *
 * ── ما يُعرض وما لا يُعرض ──
 *
 * تُعرض أرقامٌ مجمّعة: المورّد، وذاكرةُ البطاقة، وذاكرةُ النظام. ولا
 * يُعرض اسمُ الجهاز ولا رقمُه التسلسليّ ولا عنوانُ الشبكة ولا مسارٌ مطلق
 * — ليس لأنّها تُرفع (لا شيءَ يُرفع)، بل لأنّ عرضَها في واجهةٍ يجعلها
 * تُلتقط في صورةِ شاشةٍ تُشارَك بعد حين.
 */

import { useCallback, useEffect, useState } from "react";

import { fetchCapabilities, probeEngine, type EngineCapabilities } from "@/lib/local-image/client";
import { LOCAL_ENGINE_ORIGIN, isLocalImageEnabled } from "@/lib/local-image/flag";

const TOKEN_KEY = "ysd.localEngineToken";

export function LocalAiSettings() {
  const [token, setToken] = useState("");
  const [caps, setCaps] = useState<EngineCapabilities | null>(null);
  const [alive, setAlive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try { setToken(window.localStorage.getItem(TOKEN_KEY) ?? ""); } catch { /* محجوب */ }
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    const up = await probeEngine();
    setAlive(up);
    setCaps(up && token ? await fetchCapabilities(token) : null);
    setBusy(false);
  }, [token]);

  const save = useCallback(() => {
    try { window.localStorage.setItem(TOKEN_KEY, token); } catch { /* محجوب */ }
    void check();
  }, [token, check]);

  if (!isLocalImageEnabled()) {
    /**
     * ★ الميزةُ المطفأة تغيب — ولا تُعرض «قريبًا».
     *
     * فترقُّبٌ معروضٌ في الإعدادات وعدٌ ضمنيّ، وهذه لم تُطلق بعد.
     */
    return null;
  }

  const status =
    alive === null ? "غير مفحوص"
      : !alive ? "غير مشتغل"
        : caps?.status === "connected" ? "متّصل"
          : caps?.status === "unverified_hardware" ? "عتادٌ غير موثَّق"
            : caps?.status === "unauthorized" ? "رمزٌ غير صحيح"
              : "غير متاح";

  return (
    <section data-testid="local-ai-settings" className="space-y-3 rounded-lg border p-4 text-sm">
      <header className="flex items-center justify-between">
        <h2 className="font-medium">YSD Local Engine</h2>
        <span data-testid="engine-status" className="rounded bg-slate-100 px-2 py-0.5 text-xs">{status}</span>
      </header>

      <p className="text-xs text-slate-500">
        يعمل على جهازك على <code>{LOCAL_ENGINE_ORIGIN}</code>. شغّله ثم الصق الرمز الذي يطبعه عند الإقلاع.
      </p>

      <div className="flex gap-2">
        <input
          data-testid="engine-token-input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="رمز المحرّك المحلّيّ"
          className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs"
        />
        <button type="button" data-testid="engine-save" onClick={save} disabled={busy} className="rounded border px-3 py-1 text-xs">
          حفظ وفحص
        </button>
      </div>

      {caps?.status === "connected" && caps.hardware ? (
        <dl data-testid="engine-hardware" className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
          <dt>المعالج الرسوميّ</dt><dd>{caps.hardware.vendor}</dd>
          <dt>ذاكرة البطاقة</dt><dd>{caps.hardware.vramFree} / {caps.hardware.vramTotal} م.ب متاحة</dd>
          <dt>ذاكرة النظام</dt><dd>{caps.hardware.ramFree} / {caps.hardware.ramTotal} م.ب متاحة</dd>
          <dt>الضبط الافتراضيّ</dt>
          <dd>{caps.presets?.default ? `${caps.presets.default.width}×${caps.presets.default.height}` : "—"}</dd>
        </dl>
      ) : null}

      {caps?.profile && !caps.profile.eligible ? (
        <p data-testid="engine-unverified" className="text-xs text-amber-700">
          {caps.message}
          {caps.profile.reasons?.length ? <span className="block text-slate-500">({caps.profile.reasons.join("، ")})</span> : null}
        </p>
      ) : null}

      {/**
       * ★ يُفصل ما جُرّب عمّا اشتُقّ منه — في الواجهة كما في الكود.
       *
       * فبطاقةٌ واحدة قِيست، والعتبةُ مشتقّةٌ منها. وإخفاءُ ذلك يجعل
       * المستخدمَ يقرأ «مطابق» على أنه «مُجرَّب على جهازي».
       */}
      {caps?.profile?.eligibilityBasis ? (
        <p data-testid="engine-basis" className="text-[11px] leading-relaxed text-slate-500">
          {caps.profile.eligibilityBasis}
        </p>
      ) : null}
    </section>
  );
}
