"use client";

/**
 * لوحةُ الاقتران بالمحرّك المحلّيّ.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ الاقترانُ لا يقع بضغطةٍ في هذه الصفحة وحدَها
 *
 *  الزرُّ هنا لا يُقرن شيئًا. وإنّما يقول للمستخدم: افتح نافذةَ محرّكك،
 *  واضغط «اقترن» هناك، واقرأ الرقمَ بعينك، ثمّ اكتبه هنا.
 *
 *  ولماذا هذا التطويل؟ لأنّ صفحةً على الشبكة لو استطاعت أن تُقرن نفسَها
 *  بمحرّكٍ على جهازك بضغطةٍ واحدة، لكفى أن تُخدع مرّةً واحدة. والرقمُ
 *  الذي يُقرأ من نافذةٍ محلّيّةٍ ويُكتب هنا هو الدليلُ — الوحيد — على أنّ
 *  من يطلب الاقتران جالسٌ أمام الجهاز.
 *
 *  ★ ولا يُقرأ الرمزُ من الصفحة المحلّيّة آليًّا
 *
 *  نستطيع تقنيًّا أن نحاول. ولو فعلنا لأصبح «الفعلُ الصريح» تمثيلًا:
 *  خطوةٌ تبدو للمستخدم وهي تجري بلا علمه. فيُكتب باليد.
 *
 *  ★ ولا يدخل الرمزُ عنوانًا
 *
 *  العناوينُ تبقى في تاريخ المتصفّح وفي ترويسة المُحيل. فالرمزُ يعيش في
 *  حالةِ المكوّن حتّى يُرسَل، ثمّ يُمحى — نجح أم فشل.
 * ══════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  authorizedFetch,
  completePairing,
  discoverEngine,
  ensureSession,
  handleRevocation,
  type PairingState,
} from "@/lib/local-pairing/client";
import { LOCAL_ENGINE_ORIGIN, isLocalPairingEnabled } from "@/lib/local-pairing/flag";

/** العنوانُ ثابتٌ حرفيًّا — لا يُركَّب من مُدخَل، ولا يحمل مُعامِلًا */
const PAIR_PAGE_URL = `${LOCAL_ENGINE_ORIGIN}/pair`;

const CODE_LENGTH = 8;

type View = PairingState | "IDLE";

const LABEL: Record<View, string> = {
  IDLE: "غير مفحوص",
  ENGINE_UNAVAILABLE: "المحرّك لا يعمل",
  PAIRING_UNSUPPORTED: "المحرّك أقدم من الاقتران",
  PAIRING_REQUIRED: "غير مقترن",
  AUTHENTICATING: "جارٍ التحقّق",
  CONNECTED: "مقترن",
  REVOKED: "أُلغي الاقتران",
  ERROR: "تعذّر الاتّصال",
};

export function LocalPairingPanel() {
  const [view, setView] = useState<View>("IDLE");
  const [engineVersion, setEngineVersion] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showCodeEntry, setShowCodeEntry] = useState(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  /**
   * فحصٌ أوّليّ عند العرض.
   *
   * ★ في تأثيرٍ لا في التهيئة: `window` غيرُ موجودٍ أثناء التصيير
   *   الخادميّ، ونداءُ الحلقة المحلّية من الخادم يصيب الحاويةَ لا الجهاز.
   */
  const refresh = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const found = await discoverEngine();
    if (!alive.current) return;

    if (found.state === "ENGINE_UNAVAILABLE") { setView("ENGINE_UNAVAILABLE"); setBusy(false); return; }
    if (found.state === "PAIRING_UNSUPPORTED") {
      setEngineVersion(found.engineVersion ?? null);
      setView("PAIRING_UNSUPPORTED");
      setBusy(false);
      return;
    }

    setEngineVersion(found.identity.engineVersion);
    setView("AUTHENTICATING");

    const session = await ensureSession();
    if (!alive.current) return;

    if (!session.ok) {
      if (session.state === "REVOKED") { await handleRevocation(); setView("REVOKED"); }
      else setView(session.state);
      setBusy(false);
      return;
    }

    /**
     * ★ و«أعد الفحص» يسأل المحرّكَ فعلًا — ولا يكتفي برمزٍ في الذاكرة.
     *
     *   الجلسةُ تعيش خمسَ عشرةَ دقيقة. فلو أُلغي هذا المتصفّحُ من نافذة
     *   المحرّك، لبقي الرمزُ في الذاكرة صالحَ الشكل، ولقالت اللوحةُ
     *   «مقترن» بينما المحرّكُ قد قطعه — وهو ما وقع في أوّل قبولٍ على
     *   متصفّحٍ حقيقيّ.
     *
     *   والاستعمالُ الصامتُ يبقى على الرمز المخبَّأ: ذلك غرضُ الجلسة.
     *   أمّا فحصٌ طلبه المستخدمُ صراحةً فيجب أن يُقاس لا أن يُفترض.
     *
     *   و`/models` قراءةٌ محضة، فإعادتُها بعد مصادقةٍ جديدة آمنة.
     */
    const probe = await authorizedFetch("/models", { method: "GET", retryOnReauth: true });
    if (!alive.current) return;

    if (probe.state === "REVOKED") { await handleRevocation(); setView("REVOKED"); }
    else if (probe.response?.status === 200) setView("CONNECTED");
    else setView(probe.state);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!isLocalPairingEnabled()) return;
    void refresh();
  }, [refresh]);

  const openEnginePage = useCallback(() => {
    /** ★ `noopener` — فالصفحةُ المفتوحة لا تملك مِقبضًا على هذه */
    window.open(PAIR_PAGE_URL, "_blank", "noopener,noreferrer");
  }, []);

  const submitCode = useCallback(async () => {
    const entered = code.trim();
    if (entered.length !== CODE_LENGTH) return;

    setBusy(true);
    setNote(null);
    setView("AUTHENTICATING");

    const result = await completePairing(entered);

    /** ★ ويُمحى الرمزُ فورًا — نجح أم فشل. وهو صالحٌ مرّةً واحدةً أصلًا. */
    setCode("");
    if (!alive.current) return;

    setView(result.state);
    if (result.state === "CONNECTED") setShowCodeEntry(false);
    else setNote(explain(result.code));
    setBusy(false);
  }, [code]);

  const unpair = useCallback(async () => {
    setBusy(true);
    await handleRevocation();
    if (!alive.current) return;
    setView("PAIRING_REQUIRED");
    setShowCodeEntry(false);
    setBusy(false);
  }, []);

  if (!isLocalPairingEnabled()) {
    /**
     * ★ الميزةُ المطفأة تغيب — ولا تُعرض «قريبًا».
     *
     *   فترقُّبٌ معروضٌ في الإعدادات وعدٌ ضمنيّ، وهذه لم تُطلق بعد.
     */
    return null;
  }

  const needsPairing = view === "PAIRING_REQUIRED" || view === "REVOKED";

  return (
    <section data-testid="local-pairing-panel" className="space-y-3 rounded-lg border p-4 text-sm">
      <header className="flex items-center justify-between">
        <h2 className="font-medium">اقتران YSD Local Engine</h2>
        <span data-testid="pairing-status" className="rounded bg-slate-100 px-2 py-0.5 text-xs">
          {LABEL[view]}
        </span>
      </header>

      {view === "CONNECTED" ? (
        <p data-testid="pairing-connected" className="text-xs text-slate-500">
          هذا المتصفّح مقترنٌ بمحرّكك{engineVersion ? ` (${engineVersion})` : ""}. لا يلزم رمزٌ بعد اليوم،
          ولا يُحفظ رمزُ دخولٍ في المتصفّح.
        </p>
      ) : null}

      {view === "ENGINE_UNAVAILABLE" ? (
        <p data-testid="pairing-engine-down" className="text-xs text-slate-500">
          لم يُعثر على محرّكٍ يعمل على <code>{LOCAL_ENGINE_ORIGIN}</code>. شغّله ثم أعد الفحص.
        </p>
      ) : null}

      {view === "PAIRING_UNSUPPORTED" ? (
        <p data-testid="pairing-unsupported" className="text-xs text-amber-700">
          المحرّكُ المثبَّت{engineVersion ? ` (${engineVersion})` : ""} لا يدعم الاقتران الدائم. حدّثه ثمّ أعد الفحص.
        </p>
      ) : null}

      {view === "REVOKED" ? (
        <p data-testid="pairing-revoked" className="text-xs text-amber-700">
          أُلغي اقترانُ هذا المتصفّح من نافذة المحرّك. اقترن من جديد للمتابعة.
        </p>
      ) : null}

      {needsPairing && !showCodeEntry ? (
        <button
          type="button"
          data-testid="pairing-start"
          onClick={() => setShowCodeEntry(true)}
          className="rounded border px-3 py-1 text-xs"
        >
          اقترن بالمحرّك المحلّيّ
        </button>
      ) : null}

      {needsPairing && showCodeEntry ? (
        <div data-testid="pairing-instructions" className="space-y-2">
          <ol className="list-decimal space-y-1 pe-4 text-xs text-slate-600">
            <li>
              افتح نافذةَ المحرّك على{" "}
              <code data-testid="pairing-page-url">{PAIR_PAGE_URL}</code>
              {" "}
              <button type="button" data-testid="pairing-open-engine" onClick={openEnginePage} className="underline">
                (افتحها)
              </button>
            </li>
            <li>اضغط «Start pairing» هناك.</li>
            <li>اكتب الرقمَ الظاهر — ثمانيةَ أرقام — في الحقل أدناه.</li>
          </ol>

          <div className="flex gap-2">
            <input
              data-testid="pairing-code-input"
              inputMode="numeric"
              autoComplete="off"
              maxLength={CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="12345678"
              className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              data-testid="pairing-submit"
              onClick={() => void submitCode()}
              disabled={busy || code.trim().length !== CODE_LENGTH}
              className="rounded border px-3 py-1 text-xs"
            >
              اقترن
            </button>
          </div>

          <p className="text-[11px] text-slate-500">
            لا يغادر الرمزُ جهازَك، ولا يُحفظ، ويصلح مرّةً واحدة.
          </p>
        </div>
      ) : null}

      {note ? <p data-testid="pairing-note" className="text-xs text-rose-700">{note}</p> : null}

      <div className="flex gap-2">
        <button type="button" data-testid="pairing-refresh" onClick={() => void refresh()} disabled={busy} className="rounded border px-3 py-1 text-xs">
          أعد الفحص
        </button>
        {view === "CONNECTED" ? (
          <button type="button" data-testid="pairing-unpair" onClick={() => void unpair()} disabled={busy} className="rounded border px-3 py-1 text-xs">
            انسَ هذا الاقتران
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * ترجمةُ تصنيفِ الخطأ إلى جملةٍ مفيدة.
 *
 * ★ ولا يُعرض رمزٌ ولا تحدٍّ ولا توقيع. التصنيفُ يكفي للعلاج، والقيمةُ
 *   لا تنفع المستخدمَ وتضرّه إن صُوّرت شاشتُه.
 */
function explain(code: string | undefined): string {
  switch (code) {
    case "BAD_CODE":
      return "الرمزُ غير صحيح. تحقّق منه أو اطلب رمزًا جديدًا من نافذة المحرّك.";
    case "NO_PAIRING_WINDOW":
      return "لا توجد نافذةُ اقترانٍ مفتوحة. اضغط «Start pairing» في نافذة المحرّك أوّلًا.";
    case "TOO_MANY_ATTEMPTS":
      return "انتهت المحاولات. اطلب رمزًا جديدًا من نافذة المحرّك.";
    case "RATE_LIMITED":
      return "محاولاتٌ كثيرة في وقتٍ قصير. انتظر دقيقةً ثمّ أعد المحاولة.";
    case "ORIGIN_NOT_ALLOWED":
      return "المحرّكُ لا يقبل الاقتران من هذا الموقع.";
    case "REGISTRY_FULL":
      return "بلغ المحرّكُ حدَّ المتصفّحات المقترنة. ألغِ واحدًا من نافذته ثمّ أعد المحاولة.";
    case "ENGINE_IDENTITY_CHANGED":
      return "هذا محرّكٌ مختلفٌ عن الذي اقترنتَ به. اقترن من جديد.";
    case "CREDENTIAL_NOT_STORED":
      return "تعذّر حفظُ الاعتماد في هذا المتصفّح. قد يكون التخزينُ محجوبًا في وضع التصفّح الخاصّ.";
    default:
      return "تعذّر إتمامُ الاقتران. أعد المحاولة.";
  }
}
