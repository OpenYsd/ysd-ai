"use client";

/**
 * لوحةُ التوليد المحلّيّ — تظهر داخل المحادثة عند كشفِ النيّة.
 *
 * ── ما تقوله للمستخدم صراحةً ──
 *
 * «يُولَّد على جهازك». وليست هذه عبارةً تسويقيّة: الطلبُ يخرج من الصفحة
 * إلى `127.0.0.1` ولا يمرّ بخادمٍ لنا. فالقولُ مطابقٌ للطريق.
 *
 * ── ولا تُعرض إلا بشرطين ──
 *
 * رايةٌ مشتعلة، ومحرّكٌ متّصل. وبغيابِ أحدهما لا يظهر شيءٌ أصلًا — لا زرٌّ
 * معطَّل ولا دعوةٌ إلى الترقية. فميزةٌ لا تعمل خيرٌ أن تغيب من أن تُعرض
 * ثم تُخيّب.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchCapabilities,
  generateLocally,
  probeEngine,
  type EngineCapabilities,
  type EnginePreset,
  type GenerateResult,
} from "@/lib/local-image/client";

type Phase = "idle" | "checking" | "ready" | "generating" | "done" | "error";

export interface LocalImagePanelProps {
  prompt: string;
  token: string;
  onDismiss?: () => void;
}

export function LocalImagePanel({ prompt, token, onDismiss }: LocalImagePanelProps) {
  const [caps, setCaps] = useState<EngineCapabilities | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [useQuality, setUseQuality] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  /**
   * ★ عناوينُ الكائنات تُحرَّر عند الخروج.
   *
   * كلُّ `createObjectURL` يحجز البايتاتِ في ذاكرة الصفحة حتى يُلغى
   * صراحةً. وصورةٌ بميغابايتٍ تتراكم مع كلِّ إعادةِ توليد حتى يثقل التبويب.
   */
  const urlsRef = useRef<string[]>([]);
  useEffect(() => () => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const alive = await probeEngine();
      if (cancelled) return;
      if (!alive) {
        setCaps({ status: "not_running", message: "YSD Local Engine is not running." });
        setPhase("error");
        return;
      }
      const c = await fetchCapabilities(token);
      if (cancelled) return;
      setCaps(c);
      setPhase(c.status === "connected" ? "ready" : "error");
    })();
    return () => { cancelled = true; };
  }, [token]);

  /** عدّادٌ ظاهر — التوليدُ ثوانٍ، والصمتُ فيها يُقلق */
  useEffect(() => {
    if (phase !== "generating") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 100) / 10), 100);
    return () => clearInterval(t);
  }, [phase]);

  const run = useCallback(async (preset: EnginePreset) => {
    setPhase("generating");
    setError(null);
    setElapsed(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const out = await generateLocally(
      token,
      {
        prompt,
        negative: "text, watermark, signature, letters",
        width: preset.width,
        height: preset.height,
        steps: preset.steps,
      },
      ctrl.signal,
    );
    abortRef.current = null;
    if (out.ok && out.objectUrl) {
      urlsRef.current.push(out.objectUrl);
      setResult(out);
      setPhase("done");
    } else {
      setError(out.message ?? "Generation failed.");
      setPhase("error");
    }
  }, [prompt, token]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const discard = useCallback(() => {
    if (result?.objectUrl) {
      URL.revokeObjectURL(result.objectUrl);
      urlsRef.current = urlsRef.current.filter((u) => u !== result.objectUrl);
    }
    setResult(null);
    setPhase("ready");
  }, [result]);

  if (phase === "checking") {
    return (
      <div data-testid="local-image-panel" className="rounded-lg border border-slate-200 p-3 text-sm">
        <span className="text-slate-500">جارٍ فحص المحرّك المحلّيّ…</span>
      </div>
    );
  }

  if (phase === "error" && !result) {
    return (
      <div data-testid="local-image-panel" data-state="error" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <p className="font-medium text-amber-900">{error ?? caps?.message ?? "المحرّك المحلّيّ غير متاح."}</p>
        {caps?.status === "not_running" ? (
          <p className="mt-1 text-amber-800">شغّل YSD Local Engine على جهازك ثم أعد المحاولة.</p>
        ) : null}
        {/**
         * ★ ولا بديلَ سحابيّ هنا.
         *
         * هذه أكثرُ اللحظات إغراءً بعرض «جرّب عبر السحابة» — والمستخدم
         * ينتظر ولا شيء يعمل. وعرضُه يخرق قاعدةَ الكلفة الصفريّة من حيث
         * لا يُنتبَه، فيبقى الرفضُ محلّيًّا ونهائيًّا.
         */}
        <button type="button" onClick={onDismiss} className="mt-2 text-xs text-amber-700 underline">
          متابعة المحادثة عاديًّا
        </button>
      </div>
    );
  }

  const preset = useQuality ? caps?.presets?.quality : caps?.presets?.default;

  return (
    <div data-testid="local-image-panel" data-state={phase} className="rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">توليدُ صورة على جهازك</span>
        {/** ★ يُقال في كلِّ حال، لا في النجاح وحده */}
        <span data-testid="local-badge" className="rounded bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
          يُولَّد محلّيًّا على جهازك
        </span>
      </div>

      <p className="mt-2 text-slate-600" data-testid="local-image-prompt">{prompt}</p>

      {phase === "ready" ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="local-generate"
              onClick={() => preset && run(preset)}
              disabled={!preset}
              className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50"
            >
              توليد محلّيًّا
            </button>
            <span className="text-xs text-slate-500">
              {preset ? `${useQuality ? "جودة" : "متوازن"} · ${preset.width}×${preset.height} · ${preset.steps} خطوة` : "لا ضبط متاح"}
            </span>
          </div>

          {caps?.presets?.quality ? (
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                data-testid="local-quality-toggle"
                checked={useQuality}
                onChange={(e) => setUseQuality(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                جودة أعلى ({caps.presets.quality.width}×{caps.presets.quality.height})
                {caps.presets.quality.warning ? (
                  /**
                   * التحذيرُ مقيسٌ لا عامّ: يُذكر المقدارُ الذي رُصد فعلًا،
                   * لا عبارةُ «قد يكون أبطأ».
                   */
                  <span data-testid="quality-warning" className="mt-0.5 block text-amber-700">
                    يستعمل ذاكرةَ النظام إضافةً إلى البطاقة
                    {typeof caps.presets.quality.measuredSpillMb === "number"
                      ? ` (قِيس نحوُ ${caps.presets.quality.measuredSpillMb} م.ب على الجهاز المرجعيّ)`
                      : ""}
                    ، وقد يبطئ الجهازَ إن كانت التطبيقاتُ الأخرى مفتوحة.
                  </span>
                ) : null}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {phase === "generating" ? (
        <div className="mt-3 flex items-center gap-3" data-testid="local-generating">
          <span className="text-slate-700">جارٍ التوليد على جهازك… {elapsed.toFixed(1)}ث</span>
          <button type="button" data-testid="local-cancel" onClick={cancel} className="rounded border px-2 py-1 text-xs">
            إلغاء
          </button>
        </div>
      ) : null}

      {phase === "done" && result?.objectUrl ? (
        <div className="mt-3 space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- عنوانُ كائنٍ محلّيّ، لا أصلٌ بعيد يُحسّنه Next */}
          <img
            data-testid="local-image-result"
            src={result.objectUrl}
            alt="صورة مولَّدة محلّيًّا"
            width={result.width}
            height={result.height}
            className="max-w-full rounded border"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">
              {result.width}×{result.height} · {((result.ms ?? 0) / 1000).toFixed(1)}ث · بذرة {result.seed}
            </span>
            <button type="button" data-testid="local-regenerate" onClick={() => preset && run(preset)} className="rounded border px-2 py-1">
              إعادة التوليد
            </button>
            <a data-testid="local-download" href={result.objectUrl} download={`ysd-local-${result.seed}.png`} className="rounded border px-2 py-1">
              تنزيل
            </a>
            <button type="button" data-testid="local-discard" onClick={discard} className="rounded border px-2 py-1">
              حذف النتيجة
            </button>
            {/**
             * ★ «الحفظ في YSD» معطَّلٌ عمدًا في هذه المرحلة.
             *
             * ورفعُ البايتات يحتاج قرارًا في التخزين والخصوصيّة لم يُتّخذ
             * بعد. وزرٌّ معطَّلٌ مع سببٍ أصدقُ من زرٍّ يعمل قبل أوانه.
             */}
            <button type="button" data-testid="local-save" disabled title="غير متاح في هذه المرحلة" className="rounded border px-2 py-1 opacity-40">
              الحفظ في YSD
            </button>
          </div>
          <p className="text-xs text-slate-500">
            هذه الصورة على جهازك فقط، ولم تُرفع إلى YSD.
          </p>
        </div>
      ) : null}
    </div>
  );
}
