import "server-only";

import { YSD_ALPHA_MODEL_ID } from "./ysd";
import { checkYSDPublicActivationReadiness } from "./ysd-public-readiness";
import { readYSDRuntimeConfig } from "./ysd-runtime-config";
import { resolveServableDeployment } from "./model-registry-resolver";
import { requestYSDRuntimeJsonCompletion } from "./ysd-runtime-client";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * اختبار توليدٍ اصطناعيّ قبل الفتح العامّ (v0.9.3، الرقعة الثانية عشرة).
 *
 * ── الفجوة التي يسدّها ──
 *
 * الرقعة الحادية عشرة أثبتت السلسلة كلها حتى `GET /models`: هدفٌ في
 * السجلّ، ونسخةٌ معتمدة، ونشرةٌ نشطة، ووقت تشغيلٍ يُجيب ويحمل النموذج
 * المطلوب باسمه. ولم تُثبت شيئًا واحدًا: **أن التوليد نفسه يعمل**.
 *
 * وقائمةُ النماذج تُقرأ من الذاكرة؛ أما التوليد فيحمّل الأوزان ويحجز
 * ذاكرةً ويشتغل. ووقتُ تشغيلٍ يسرد نموذجه في `/models` ثم يفشل عند أول
 * `chat/completions` حالةٌ واقعية — نموذجٌ مُعلَن وغير محمَّل فعلًا، أو
 * عتادٌ لا يتّسع له. فيُفتح المفتاح على قائمةٍ صادقة وخدمةٍ معطوبة.
 *
 * ── ولماذا لا يكفي ردٌّ غير فارغ ──
 *
 * لأن الغرض إثبات أن النموذج **فهم تعليمة وأعاد ما طُلب**، لا أن المنفذ
 * أعاد أحرفًا. ووقت تشغيلٍ يردّ نصًّا عشوائيًّا أو رسالة خطأ في جسم
 * ناجح يمرّ من فحصٍ يقيس الطول وحده.
 *
 * ── وما لا يخرج منه ──
 *
 * النصّ المولَّد لا يُعاد ولا يُسجَّل ولا يُطبع — **ولا حتى عند الفشل**.
 * فهو مخرَج نموذجٍ لم يُراجَع، وطباعتُه في سجلٍّ إداريّ تفتح بابًا لا
 * يُغلق: اليوم علامة، وغدًا رسالةُ خطأ تحمل مسارًا داخليًّا.
 *
 * ── ولا يفتح شيئًا ──
 *
 * ينجح الاختبار أو يفشل، ويبقى المفتاح مغلقًا في الحالين.
 */

export type YSDSmokeResult =
  | { ok: true; passed: true; publiclyEnabled: false; latencyMs: number }
  | {
      ok: false;
      passed: false;
      reason:
        | "owner_required"
        | "not_ready"
        | "target_unavailable"
        | "generation_failed"
        | "unexpected_output"
        | "timeout"
        | "aborted"
        | "internal_error";
      latencyMs: number;
    };

/**
 * ★ المدخل ثابتٌ في الكود بالكامل — لا حرفَ منه من طلب.
 *
 * ولو قُبل موجّهٌ من العميل لصار هذا المسار بابَ توليدٍ إداريًّا بلا
 * حدود: بلا حصّة، وبلا رصد، وبلا سقف تكلفة. والاختبار الذي يقبل مدخلًا
 * لم يعد اختبارًا بل واجهة.
 */
const SMOKE_SYSTEM_PROMPT =
  "You are performing an internal YSD runtime health smoke test. " +
  "Follow the instruction exactly.";

const SMOKE_MARKER = "YSD_SMOKE_OK";
const SMOKE_USER_TEXT = `Reply with exactly: ${SMOKE_MARKER}`;

/**
 * ★ سقفُ إكمالٍ يتّسع لتفكيرٍ لا نراه — قِيس حيًّا لا خُمِّن.
 *
 * ── لماذا كانت ستّة عشر خطأً ──
 *
 * `include_reasoning: false` يمنع **إعادة** التفكير، لا **توليده**. ونماذج
 * `gpt-oss` تفكّر أولًا، وتُحاسَب على سقف الإكمال نفسه. فالستّة عشر
 * استُهلكت كلها قبل أن يبدأ الجواب، وعاد ردٌّ ناجح بمحتوى فارغ.
 *
 * والدليل قاطع: سجلّ Groq لنداءٍ حيّ (2026-08-18) يقول
 * `HTTP 200` و`Output tokens: 16` — **مساويًا للسقف بالضبط**. وانتهاءٌ
 * عند السقف حرفيًّا قطعٌ لا اكتمال؛ ولو أتمّ النموذج جوابه لكان أقلّ.
 * وقياسٌ سابق في هذا المشروع (2026-08-11، `lib/ai/groq.ts`) وجد أن جوابًا
 * قصيرًا احتاج ٢٦ رمز إكمال بسقفٍ ٢٤ — التوقيع نفسه.
 *
 * ── ولماذا مئة وثمانية وعشرون ──
 *
 * العلامة نفسها دون عشرة رموز، فهي ليست القيد قطّ. والقيد مقدّمةُ التفكير:
 * أربعة أضعاف أطول قياسٍ لدينا (٢٦)، وهامشٌ لأن `120b` يفكّر أكثر من
 * `20b`. ومسار Groq العامّ في هذا المشروع يفترض `2048` — فمئةٌ وثمانية
 * وعشرون تبقى **متحفّظة** لا سخيّة.
 *
 * وكلفتها لا تُذكر: النداء الحيّ قطع ستّة عشر رمزًا في ١٧٧ مللي ثانية،
 * والمهلة خمس ثوانٍ تبقى السقف الحقيقيّ.
 *
 * ── ولا يصنع هذا نجاحًا كاذبًا ──
 *
 * المقارنة تامّة بعد قصّ المسافات. فنموذجٌ يُضيف شرحًا يفشل بـ
 * `unexpected_output` مهما اتّسع سقفه. ورفعُ السقف يزيل سببَ فشلٍ زائفًا
 * ولا يفتح بابًا لنجاحٍ غير مستحقّ — وذلك ما يجعله إصلاحًا لا تخفيفًا.
 */
const SMOKE_MAX_TOKENS = 128;
/** خمس ثوانٍ: مشرفٌ ينتظر أمام زرّ، والتوليد المطلوب كلمةٌ واحدة */
const SMOKE_TIMEOUT_MS = 5_000;

export interface YSDSmokeDependencies {
  checkPublicReadiness: typeof checkYSDPublicActivationReadiness;
  readRuntimeConfig: typeof readYSDRuntimeConfig;
  getAdminClient: typeof getAdminClient;
  resolveDeployment: typeof resolveServableDeployment;
  requestRuntimeJsonCompletion: typeof requestYSDRuntimeJsonCompletion;
  now: () => number;
}

const DEFAULTS: YSDSmokeDependencies = {
  checkPublicReadiness: checkYSDPublicActivationReadiness,
  readRuntimeConfig: readYSDRuntimeConfig,
  getAdminClient,
  resolveDeployment: resolveServableDeployment,
  requestRuntimeJsonCompletion: requestYSDRuntimeJsonCompletion,
  now: () => Date.now(),
};

/**
 * ★ يُثبت أن التوليد يعمل — ولا يفتح النموذج.
 *
 * @param isOwner من سياق الإدارة. لا تُقرأ الأدوار هنا: المستدعي أثبت
 *   الهوية سلفًا، وإعادةُ التحقّق من مكانٍ ثانٍ تخلق مصدرين للحقيقة.
 */
export async function checkYSDPreActivationSmoke(
  isOwner: boolean,
  deps: Partial<YSDSmokeDependencies> = {},
): Promise<YSDSmokeResult> {
  const d = { ...DEFAULTS, ...deps };
  const t0 = d.now();
  /** لا سالبَ ولا NaN مهما فعل مصدر الوقت المحقون */
  const since = () => {
    const ms = d.now() - t0;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  };
  const fail = (reason: Exclude<YSDSmokeResult, { ok: true }>["reason"]): YSDSmokeResult => ({
    ok: false,
    passed: false,
    reason,
    latencyMs: since(),
  });

  // ★ المالك وحده — قبل أي فحصٍ وأي قاعدة وأي شبكة
  if (isOwner !== true) return fail("owner_required");

  /**
   * ★ الجاهزية أولًا — ومصدرها الرقعة الحادية عشرة وحدها.
   *
   * ولا يُكرَّر منطقها هنا: المالك، والمفتاح المغلق، وأهليّة القاعدة،
   * وقائمة السماح، والفحص. ومحرّكان يحسبان القاعدة نفسها يفترقان صامتًا
   * — يُصلَح أحدهما ويبقى الآخر يقول القديم.
   *
   * و`publiclyEnabled` يُفحص كذلك: عقدُ تلك الدالة أن يكون `false`
   * دائمًا، فمخالفتُه تعني أن شيئًا لم نعد نفهمه.
   */
  let readiness;
  try {
    readiness = await d.checkPublicReadiness(isOwner);
  } catch {
    return fail("internal_error");
  }
  if (!readiness.ok || readiness.ready !== true || readiness.publiclyEnabled !== false) {
    return fail("not_ready");
  }

  // ── الهدف: من إعداد الخادم ثم من السجلّ — لا استعلام مباشر ──

  /**
   * ★ القراءة تُلَفّ — والتمييز بين الحالتين مقصود.
   *
   * `{ok:false}` جوابٌ متوقَّع يقول «الإعداد ناقص»، فهو `target_unavailable`
   * يدلّ المشغّل على البيئة. أما الاستثناء فيقول «شيءٌ في برنامجنا انكسر»،
   * وإلباسُه ثوبَ نقصِ إعدادٍ يرسل المشغّل يفتّش متغيّراتٍ سليمة.
   *
   * ونصُّ الاستثناء لا يعبر: قد يحمل عنوانًا أو مفتاحًا.
   */
  let configResult;
  try {
    configResult = d.readRuntimeConfig();
  } catch {
    return fail("internal_error");
  }
  if (!configResult.ok) return fail("target_unavailable");
  const config = configResult.config;

  let admin;
  try {
    admin = d.getAdminClient();
  } catch {
    return fail("target_unavailable");
  }
  if (!admin) return fail("target_unavailable");

  let resolution;
  try {
    resolution = await d.resolveDeployment(
      admin,
      YSD_ALPHA_MODEL_ID,
      config.deploymentEnvironment,
    );
  } catch {
    return fail("target_unavailable");
  }
  if (!resolution.ok) return fail("target_unavailable");

  // ── التوليد: مدخلٌ ثابت، وسقفٌ ضيّق ──

  let result;
  try {
    result = await d.requestRuntimeJsonCompletion(
      config,
      resolution.deployment,
      resolution.version,
      {
        systemPrompt: SMOKE_SYSTEM_PROMPT,
        userText: SMOKE_USER_TEXT,
        maxTokens: SMOKE_MAX_TOKENS,
        timeoutMs: SMOKE_TIMEOUT_MS,
      },
    );
  } catch {
    return fail("internal_error");
  }

  if (!result.ok) {
    if (result.reason === "timeout") return fail("timeout");
    if (result.reason === "aborted") return fail("aborted");
    // unauthorized · network_error · runtime_unavailable · invalid_response · …
    return fail("generation_failed");
  }

  /**
   * ★ تطابقٌ تامّ بعد قصّ المسافات وحده.
   *
   * لا `includes` ولا `startsWith` ولا تجاهل حالة أحرف: نموذجٌ يُضيف
   * شرحًا أو يغيّر الحالة لم يتبع التعليمة، ومن لا يتبع تعليمةً بهذه
   * البساطة لا يُفتح للناس. والقصّ وحده مقبول لأن المسافات الطرفية
   * تنسيقٌ لا معنى.
   */
  if (result.text.trim() !== SMOKE_MARKER) return fail("unexpected_output");

  return { ok: true, passed: true, publiclyEnabled: false, latencyMs: since() };
}
