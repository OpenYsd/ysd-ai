"use client";

/**
 * مِنصّةُ القبول — تعرض اللوحةَ الحقيقيّة وتضيف إليها أدواتِ فحصٍ للمخزن.
 *
 * ★ ولا تُعيد تنفيذَ شيء.
 *
 *   كلُّ ما هنا يستدعي وحداتِ `lib/local-pairing/*` نفسَها التي تعمل في
 *   `/settings`. فما يُقاس هو ما يُشحن، لا نسخةٌ منه كُتبت للاختبار.
 *
 * ★ ولا تطبع سرًّا.
 *
 *   تقول «موجود» و«غير موجود» و«رمى» و«نجح». والقيمُ نفسُها لا تظهر في
 *   الصفحة ولا في السجلّ — فلقطةُ شاشةٍ لهذه الصفحة قد تُشارَك.
 */

import { useCallback, useState } from "react";

import { LocalPairingPanel } from "@/components/local-pairing/pairing-panel";
import { authorizedFetch } from "@/lib/local-pairing/client";
import { loadCredential } from "@/lib/local-pairing/credential";
import { peekSession } from "@/lib/local-pairing/session";

type Row = { label: string; verdict: "PASS" | "FAIL" | "INFO"; detail: string };

export function PairingHarness() {
  const [rows, setRows] = useState<Row[]>([]);

  const add = (label: string, verdict: Row["verdict"], detail = "") =>
    setRows((r) => [...r, { label, verdict, detail }]);

  /** فحصُ المفتاح: العامُّ يُصدَّر، والخاصُّ يجب أن يرمي في الصيغ الثلاث */
  const inspectKey = useCallback(async () => {
    const loaded = await loadCredential();
    if (loaded.state !== "present") {
      add("credential in IndexedDB", "INFO", loaded.state);
      return;
    }
    add("credential in IndexedDB", "PASS", `client ${loaded.credential.clientId.slice(0, 8)}…`);

    let escaped = false;
    for (const format of ["pkcs8", "jwk", "raw"] as const) {
      try { await crypto.subtle.exportKey(format, loaded.credential.privateKey); escaped = true; } catch { /* المطلوب */ }
    }
    add("private key export refused in all formats", escaped ? "FAIL" : "PASS",
      escaped ? "a format succeeded" : "pkcs8 · jwk · raw all threw");

    try {
      const jwk = await crypto.subtle.exportKey("jwk", loaded.credential.publicKey);
      add("public key exports", jwk.crv === "P-256" && !("d" in jwk) ? "PASS" : "FAIL", `crv ${jwk.crv}`);
    } catch {
      add("public key exports", "FAIL", "threw");
    }
  }, []);

  /** فحصُ المخزن: لا رمزَ جلسةٍ في أيّ مكانٍ دائم */
  const inspectStorage = useCallback(async () => {
    const session = peekSession();
    add("session held in memory", session ? "PASS" : "INFO", session ? "present" : "none right now");

    const dumps: string[] = [];
    try { dumps.push(JSON.stringify(window.localStorage)); } catch { /* محجوب */ }
    try { dumps.push(JSON.stringify(window.sessionStorage)); } catch { /* محجوب */ }
    dumps.push(document.cookie);
    const blob = dumps.join("|");

    if (session) {
      add("session token absent from web storage and cookies",
        blob.includes(session.token) ? "FAIL" : "PASS", `${blob.length} chars scanned`);
    }

    /** ★ وأسماءُ المفاتيح تُعرض، لا قيمُها */
    let keys: string[] = [];
    try { keys = Object.keys(window.localStorage); } catch { /* محجوب */ }
    add("localStorage keys", "INFO", keys.length ? keys.join(", ") : "(empty)");

    add("URL carries no code or token",
      /\d{8}|token/i.test(window.location.href) ? "FAIL" : "PASS", window.location.pathname);
  }, []);

  /**
   * نداءُ مسارٍ محميّ عبر الطبقة نفسِها التي يستعملها التطبيق.
   *
   * ★ و`/models` قراءةٌ محضة، فيصحّ تعليمُها بأنّها آمنةُ التكرار —
   *   وبذلك يُقاس مسارُ «إعادةِ المصادقة ثمّ إعادةِ الطلب» كاملًا.
   */
  const callProtected = useCallback(async () => {
    const result = await authorizedFetch("/models", { method: "GET", retryOnReauth: true });
    add("protected endpoint via session", result.response?.status === 200 ? "PASS" : "FAIL",
      `state ${result.state}${result.code ? ` · ${result.code}` : ""} · http ${result.response?.status ?? "—"}`);
  }, []);

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
      <header>
        <h1 className="text-lg font-semibold">Local pairing — acceptance harness</h1>
        <p className="text-xs text-slate-500">
          Development only. Renders the real settings panel; the buttons below inspect
          browser storage. No secret value is ever printed.
        </p>
      </header>

      <LocalPairingPanel />

      <section className="space-y-2 rounded-lg border p-4">
        <div className="flex gap-2">
          <button type="button" data-testid="harness-key" onClick={() => void inspectKey()} className="rounded border px-3 py-1 text-xs">
            Inspect credential
          </button>
          <button type="button" data-testid="harness-storage" onClick={() => void inspectStorage()} className="rounded border px-3 py-1 text-xs">
            Inspect storage
          </button>
          <button type="button" data-testid="harness-call" onClick={() => void callProtected()} className="rounded border px-3 py-1 text-xs">
            Call protected endpoint
          </button>
          <button type="button" data-testid="harness-clear" onClick={() => setRows([])} className="rounded border px-3 py-1 text-xs">
            Clear
          </button>
        </div>

        <table className="w-full text-xs" data-testid="harness-results">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-b">
                <td className={`w-14 py-1 font-bold ${r.verdict === "PASS" ? "text-emerald-700" : r.verdict === "FAIL" ? "text-rose-700" : "text-slate-500"}`}>
                  {r.verdict}
                </td>
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-slate-500">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
