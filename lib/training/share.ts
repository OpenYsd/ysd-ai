import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "@/lib/supabase/admin";
import { isConsentActive, readTrainingConsent } from "./consent";
import { createTrainingCandidate, revokeUserCandidates } from "./candidate";

/**
 * مشاركة محادثةٍ صراحةً مع بنك تحسين YSD (v0.9.5، المرحلة 2A).
 *
 * ── الإذن ليس مشاركة ──
 *
 * تشغيلُ الخيار في الإعدادات يقول: «أقبل مبدأ المشاركة». ولا يقول: «خذوا
 * كل ما أكتب». فبين الاثنين فعلٌ ثالث لا بدّ منه — أن يفتح المستخدم محادثةً
 * بعينها ويقول: هذه.
 *
 * ولذلك لا يُستدعى هذا من مسار المحادثة، ولا من خطّافٍ بعد البثّ، ولا من
 * مستمعٍ في الخلفية. يُستدعى من زرٍّ يضغطه إنسان.
 *
 * ── وهي لقطة، لا اشتراك ──
 *
 * تشارك ما في المحادثة **الآن**. ورسائل الغد لا تدخل بهذه الضغطة: من
 * أرادها شارك مرّةً أخرى. والفرق ليس تفصيلًا تقنيًّا — «شاركت محادثة»
 * قرارٌ يعرف صاحبه حدوده، و«شغّلت المشاركة على محادثة» عقدٌ مفتوح لا يعرف
 * صاحبه إلامَ ينتهي.
 */

export type ShareRejection =
  | "consent_required"
  | "conversation_not_found"
  | "database_error";

export interface ShareCounters {
  /** أزواج أُدخلت الآن */
  created: number;
  /** أزواج مسجّلة سلفًا — ليست عطلًا */
  duplicates: number;
  /** أزواج وقعت قبل الإذن — لا تدخل ولا تُسجَّل */
  beforeConsent: number;
  rejectedQuality: number;
  rejectedPrivacy: number;
  /** ما تعذّر إدخاله لسببٍ في القاعدة — يُميَّز عن الرفض المشروع */
  failed: number;
  /** كل ما فُحص — مجموع ما سبق */
  examined: number;
  /**
   * بلغت القراءةُ سقفها، فقد يكون في المحادثة ما لم يُفحص.
   *
   * تُقال ولا تُبتلع: «لا أجزاء جديدة» عن محادثةٍ لم تُقرأ كاملةً جوابٌ
   * غير صادق، وإن كان العدد صحيحًا فيما قُرئ.
   */
  truncated: boolean;
}

export type ShareResult =
  | ({ ok: true } & ShareCounters)
  | { ok: false; reason: ShareRejection };

export interface ShareDependencies {
  getAdminClient: typeof getAdminClient;
  readConsent: typeof readTrainingConsent;
  createCandidate: typeof createTrainingCandidate;
  revokeCandidates: typeof revokeUserCandidates;
}

const DEFAULTS: ShareDependencies = {
  getAdminClient,
  readConsent: readTrainingConsent,
  createCandidate: createTrainingCandidate,
  revokeCandidates: revokeUserCandidates,
};

/**
 * سقفٌ لعدد الرسائل المقروءة في المشاركة الواحدة.
 *
 * ليس حدًّا على ما يملك المستخدم مشاركته، بل على ما تفعله ضغطةٌ واحدة:
 * محادثةٌ بآلاف الرسائل تعني آلاف الرحلات إلى القاعدة في طلبٍ ينتظره
 * إنسان. والسقف عالٍ بما يكفي لألّا يبلغه استعمالٌ طبيعيّ.
 */
const MAX_MESSAGES = 400;

interface OrderedMessage {
  id: string;
  role: string;
  created_at: string | null;
}

export interface EligiblePair {
  userMessageId: string;
  assistantMessageId: string;
  userCreatedAt: string | null;
  assistantCreatedAt: string | null;
}

/**
 * ★ الاقتران — حتميّ، ويسكت عند الالتباس.
 *
 * ── لماذا لا يكفي «كل رسالتين متتاليتين» ──
 *
 * لأن التتابع ليس اقترانًا. وفي هذا المسار حالةٌ تُنتج مستخدمَين متتاليَين
 * فعلًا: إن أوقف المستخدم التوليد، تُحفظ رسالته ولا يُحفظ ردٌّ إطلاقًا
 * (`assistant_saved=false`)، ثم يكتب رسالةً أخرى. فمن يقرأ الاثنتين زوجًا
 * يُلصق سؤالًا بسؤال.
 *
 * ── والقاعدة التي تنجو ──
 *
 * لكل ردٍّ **حيّ**: قرينه هو ما يسبقه مباشرةً في الترتيب، بشرط أن يكون
 * دورُه `user`. وإلّا فلا زوج — يُتخطّى بلا تخمين.
 *
 * وهي تنجو مما لم نتوقّعه: ردّان متتاليان (لا ينبغي أن يقعا — إعادة التوليد
 * تُبدّل في مكانها) يجعلان الثاني بلا قرين فيُترك، لا أن يُقرن بردّ. وهذا
 * هو الاتجاه الصحيح للخطأ.
 *
 * ── والترتيب كلّيّ ──
 *
 * `created_at` ثم `id`. فتساوي الطوابع — وإن بَعُد — يجعل الترتيب رأيًا لا
 * حقيقة، والفاصل الثابت يجعله واحدًا في كل قراءة.
 */
export function buildEligiblePairs(ordered: readonly OrderedMessage[]): EligiblePair[] {
  const pairs: EligiblePair[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i]!;
    if (current.role !== "assistant") continue;
    const previous = ordered[i - 1]!;
    if (previous.role !== "user") continue;
    pairs.push({
      userMessageId: previous.id,
      assistantMessageId: current.id,
      userCreatedAt: previous.created_at,
      assistantCreatedAt: current.created_at,
    });
  }
  return pairs;
}

/** كما في الخدمة: طابعٌ غائب أو غير مقروء ⇒ «قبل الإذن» */
function isAfter(createdAt: string | null, grantedAt: string | null): boolean {
  if (typeof createdAt !== "string" || typeof grantedAt !== "string") return false;
  const c = Date.parse(createdAt);
  const g = Date.parse(grantedAt);
  if (Number.isNaN(c) || Number.isNaN(g)) return false;
  return c >= g;
}

/**
 * ★ يشارك محادثةً — ويعيد أعدادًا لا نصوصًا.
 */
export async function shareConversationForTraining(
  userId: string,
  conversationId: string,
  deps: Partial<ShareDependencies> = {},
): Promise<ShareResult> {
  const d = { ...DEFAULTS, ...deps };

  let db: SupabaseClient | null;
  try {
    db = d.getAdminClient();
  } catch {
    return { ok: false, reason: "database_error" };
  }
  if (!db) return { ok: false, reason: "database_error" };

  /**
   * ★ (١) الإذن قبل أن تُقرأ رسالةٌ واحدة.
   *
   * ولو كان الترتيب معكوسًا لَقرأنا كلامًا لنعرف بعده أنّا لم نكن نملك
   * قراءته. والقراءة لا تُستعاد.
   */
  const consent = await d.readConsent(db, userId);
  if (!isConsentActive(consent)) return { ok: false, reason: "consent_required" };
  const grantedAt = consent.grantedAt;

  // ── (٢) المحادثة: موجودة، حيّة، ومملوكة لمن يطلب ──
  try {
    const { data, error } = await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .limit(1);
    if (error) return { ok: false, reason: "database_error" };
    if ((data ?? []).length !== 1) return { ok: false, reason: "conversation_not_found" };
  } catch {
    return { ok: false, reason: "database_error" };
  }

  /**
   * ── (٣) الهيكل قبل المحتوى ──
   *
   * لا `content` هنا. ما يلزم للاقتران هو المعرّف والدور والزمن؛ والنصّ
   * تقرأه الخدمة لما تحتاجه له، وبعد أن تكون البوّابات قد أجازته.
   */
  let ordered: OrderedMessage[];
  let truncated = false;
  try {
    /**
     * ★ الأحدث أولًا ثم يُقلب — لا الأقدم.
     *
     * السقف يجب أن يقع حيث لا يضرّ. ومحادثةٌ طويلة سبقت الإذن ثم استُؤنفت
     * بعده: قراءةُ أقدم أربعمئة تستنفد الميزانية كلها فيما هو مرفوض سلفًا،
     * فيخرج الجواب «لا أجزاء جديدة» وفي المحادثة أزواجٌ مأذونة لم تُقرأ.
     *
     * والقصّ من الأعلى آمنٌ على الاقتران: قد تبدأ الشريحة بردٍّ قرينُه
     * خارجها، والقاعدة تتخطّاه — لأن ما يسبقه ليس `user`، أو لا يسبقه شيء.
     */
    const { data, error } = await db
      .from("messages")
      .select("id, role, created_at")
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_MESSAGES);
    if (error) return { ok: false, reason: "database_error" };
    const rows = (data ?? []) as OrderedMessage[];
    truncated = rows.length >= MAX_MESSAGES;
    ordered = [...rows].reverse();
  } catch {
    return { ok: false, reason: "database_error" };
  }

  const counters: ShareCounters = {
    created: 0,
    duplicates: 0,
    beforeConsent: 0,
    rejectedQuality: 0,
    rejectedPrivacy: 0,
    failed: 0,
    examined: 0,
    truncated,
  };

  for (const pair of buildEligiblePairs(ordered)) {
    counters.examined += 1;

    /**
     * ★ الفرز الزمنيّ هنا **توفيرٌ لا حراسة**.
     *
     * الحراسة في `createTrainingCandidate` — وهناك وحدها تُلزم كل مستدعٍ.
     * وهذا الفحص يمنع رحلةً إلى القاعدة عن زوجٍ نعرف سلفًا أنه سيُردّ،
     * ومحادثةٌ طويلة سابقة للإذن قد تكون كلها كذلك.
     *
     * وحين يفلت شيء منه — لأنه نُسي أو نُقض — يردّه الباب. فالاثنان يعدّان
     * في العدّاد نفسه، ولا يعتمد الصدق على أيّهما سبق.
     */
    if (!isAfter(pair.userCreatedAt, grantedAt) || !isAfter(pair.assistantCreatedAt, grantedAt)) {
      counters.beforeConsent += 1;
      continue;
    }

    const result = await d.createCandidate({
      userId,
      conversationId,
      userMessageId: pair.userMessageId,
      assistantMessageId: pair.assistantMessageId,
      source: "user_opt_in",
    });

    if (result.ok) {
      counters.created += 1;
      continue;
    }

    switch (result.reason) {
      case "duplicate":
        counters.duplicates += 1;
        break;
      case "before_consent":
        counters.beforeConsent += 1;
        break;
      case "quality_rejected":
        counters.rejectedQuality += 1;
        break;
      case "privacy_rejected":
        counters.rejectedPrivacy += 1;
        break;
      /**
       * ★ سحبُ الإذن أثناء الجولة يوقفها.
       *
       * الخدمة تقرأ الموافقة لكل زوج، فإن أُطفئت بين زوجٍ وآخر ردّت
       * `consent_missing`. والمضيّ بعدها محاولةٌ لإدخال ما لم يعد مأذونًا —
       * فنقف، ونعيد ما تمّ صادقًا.
       */
      case "consent_missing": {
        /**
         * وننظّف ما أنشأناه قبل لحظةٍ: كنسةُ الإلغاء في مسار الإعدادات
         * جرت قبل هذه الإدخالات، فلا تشملها. وتركُها يخالف ما وُعد به
         * صاحبها — أن الإطفاء يُبطل كل ما لم يخرج.
         */
        try {
          await d.revokeCandidates(userId);
        } catch {
          /* الإذن مسحوبٌ في القاعدة على كل حال، والرفض هو الجواب */
        }
        return { ok: false, reason: "consent_required" };
      }
      default:
        counters.failed += 1;
        break;
    }
  }

  return { ok: true, ...counters };
}
