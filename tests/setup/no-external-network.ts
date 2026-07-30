/**
 * حارس الشبكة لاختبارات Vitest — لا اتصال خارج الجهاز.
 *
 * نطاق vitest معرَّف في vitest.config.ts بأنه «وحدات وتكامل **بلا شبكة**»، لكن
 * لا شيء كان يُنفّذ ذلك. فمرّ اختبارٌ يستدعي عنوان OpenRouter الحقيقي ويعتمد
 * على أن الشبكة سترفضه (401) — سلوك يتغيّر بتغيّر البيئة: بلا إنترنت يصير
 * انتظارًا ثم فشلًا، وبمفتاح صالح في البيئة يصير طلبًا حيًّا مدفوعًا. اختبار
 * حتمي لا يجوز أن يعتمد على مضيف بعيد إطلاقًا.
 *
 * المسموح: 127.0.0.1 · localhost · ::1 — أي مزوّد وهمي يشغّله الاختبار نفسه.
 * وأي وجهة أخرى تفشل فورًا برسالة تذكر **اسم المضيف وحده**: لا مسار ولا
 * query ولا ترويسات ولا جسم — فالرسالة تُطبع في السجلات وقد تحمل أسرارًا.
 *
 * هذا الملف يُحمَّل عبر setupFiles في vitest وحده. لا يمسّ وقت تشغيل الإنتاج
 * ولا يُستورد من أي مسار تطبيق.
 */
import net from "node:net";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);

function isLocal(host: string | undefined): boolean {
  if (!host) return true; // مقبس unix أو أنبوب — ليس شبكة خارجية
  return LOCAL.has(host.toLowerCase());
}

/** رسالة آمنة: اسم المضيف وحده */
function refuse(host: string, via: string): Error {
  return new Error(
    `[حارس الشبكة] اتصال خارجي محجوب في الاختبارات: host=${host} (via ${via}). ` +
      `الاختبارات الحتمية تستعمل مزوّدًا محليًا على 127.0.0.1 أو stub لـfetch.`,
  );
}

// ── 1) طبقة fetch ──────────────────────────────────────────────────────────
// معظم مسارات المشروع (المزوّد، Supabase) تمرّ من هنا.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  let host = "";
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string })?.url ?? "");
    host = new URL(raw).hostname;
  } catch {
    host = ""; // عنوان غير قابل للتحليل — نتركه للسلوك الطبيعي
  }
  if (host && !isLocal(host)) throw refuse(host, "fetch");
  return (realFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
}) as typeof globalThis.fetch;

/**
 * استخراج المضيف من وسائط Socket.prototype.connect.
 *
 * `net.connect(options)` لا يمرّر options كما هي: فـ`createConnection` تستدعي
 * `socket.connect(normalizeArgs(args))` — أي **مصفوفة** `[options, cb]`. أول
 * صيغة لهذا الحارس قرأت `.host` من تلك المصفوفة فحصلت على undefined فسمحت
 * بكل شيء: طبقة حماية قائمة لا تُطلق أبدًا. كشفها اختبار الحارس نفسه.
 *
 * الصيغ المدعومة: مصفوفة مطبَّعة · كائن options · (port, host).
 */
function hostFromConnectArgs(args: unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    return (first as { host?: string }).host;
  }
  // الصيغة الموضعية connect(port, host)
  return typeof args[1] === "string" ? (args[1] as string) : undefined;
}

// ── 2) طبقة المقبس ─────────────────────────────────────────────────────────
// شبكة الأمان: يلتقط أي مسار لا يمرّ بـfetch (عميل HTTP خام مثلًا)، ويلتقط
// كذلك أي اختبار يستبدل fetch بـstub خاص به فيتجاوز الطبقة الأولى.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(
  this: net.Socket,
  ...args: unknown[]
): net.Socket {
  if (!isLocal(hostFromConnectArgs(args))) {
    throw refuse(String(hostFromConnectArgs(args)), "socket");
  }
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
};
