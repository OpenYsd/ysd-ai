import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  groupCitationsByMessage,
  type ClientCitation,
  type EvidenceRow,
} from "@/lib/evidence/client-citation";
import { logger } from "@/lib/logger";

/**
 * قراءة أدلة المحادثة عند التحميل (v0.9.0، الإيداع السابع).
 *
 * ── نداء واحد لكل محادثة ──
 *
 * `get_conversation_evidence` تُعيد أدلة كل الرسائل دفعةً واحدة. والبديل —
 * نداء لكل رسالة — نمط N+1: يبدو سليمًا على محادثة من ثلاث رسائل ويخنق الصفحة
 * على محادثة من مئتين. ولهذا لا تأخذ هذه الوحدة `messageId` إطلاقًا: التوقيع
 * نفسه يمنع الاستعمال الخاطئ.
 *
 * ── الفشل لا يكسر التحميل ──
 *
 * الأدلة زينةٌ على الرسائل لا شرطٌ لعرضها. فتعذّر قراءتها يُعيد خريطة فارغة،
 * وتُعرض المحادثة كما كانت قبل v0.9. الرمي هنا كان سيحوّل عطبًا في ميزة
 * إضافية إلى صفحة بيضاء.
 *
 * ── عميل الجلسة لا عميل الخدمة ──
 *
 * تُنادى بعميل المستخدم كي يكون `auth.uid()` هو صاحب الجلسة، فتفحص الدالة
 * الملكية بنفسها. وبـ`service_role` كان `auth.uid()` فارغًا فتُعيد صفرًا
 * دائمًا — أو، لو كُتبت الدالة بلا فحص، أدلةَ أي محادثة.
 */

export interface ConversationEvidence {
  /** أدلة كل رسالة، بترتيب الفقرة ثم الرقم */
  byMessage: Map<string, ClientCitation[]>;
  /** هل تمّت القراءة؟ `false` تعني «تعذّرت» لا «لا أدلة» */
  ok: boolean;
}

const EMPTY: ConversationEvidence = { byMessage: new Map(), ok: false };

export async function loadConversationEvidence(
  supabase: SupabaseClient,
  conversationId: string,
  correlation?: string,
): Promise<ConversationEvidence> {
  try {
    const { data, error } = await supabase.rpc("get_conversation_evidence", {
      p_conversation_id: conversationId,
    });

    if (error) {
      /**
       * لا `error.message` ولا `details` ولا `hint`: رسائل PostgREST قد تحمل
       * صفًّا مخالفًا وفيه الاقتباس. رمزٌ ثابت وحده.
       */
      logger.warn({ event: "evidence.read", code: "evidence_read_failed", correlation });
      return EMPTY;
    }

    const rows = Array.isArray(data) ? (data as EvidenceRow[]) : [];
    return { byMessage: groupCitationsByMessage(rows), ok: true };
  } catch {
    // ولا الاستثناء يُطبع — قد يحمل جسم الرد
    logger.warn({ event: "evidence.read", code: "evidence_read_exception", correlation });
    return EMPTY;
  }
}
