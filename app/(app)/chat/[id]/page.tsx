import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext } from "@/lib/auth/request-context";
import { listModelOptions } from "@/lib/ai/registry";
import { loadModelPolicy, tierAllows } from "@/lib/ai/model-policy";
import { ChatView, type ChatModel } from "@/components/chat/chat-view";
import { loadConversationEvidence } from "@/lib/evidence/evidence-reader";
import { evidenceSummaryFromMetadata } from "@/lib/evidence/client-citation";
import { readEvidenceLayout } from "@/lib/evidence/evidence-layout";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) redirect("/chat");

  const supabase = await createClient();
  // الهوية من سياق الوسيط — يُسقط رحلة getUser (fallback شبكي آمن لو غاب السياق)
  const ctx = await getRequestContext(await headers(), supabase);
  if (!ctx) redirect("/login");
  const userId = ctx.userId;

  // كل الاستعلامات مقيّدة بـuserId + RLS، فتُنفَّذ بالتوازي بأمان — بما فيها فحص
  // ملكية المحادثة. لو لم يملكها المستخدم، RLS يُرجع الكل فارغًا ثم redirect.
  /**
   * أدلة الاستشهاد تُقرأ **داخل نفس الموازاة** (v0.9.0).
   *
   * نداء واحد لكل المحادثة، لا نداء لكل رسالة. ووضعه هنا لا بعد الحصول على
   * الرسائل يعني ألّا يضيف رحلةً متسلسلة: الصفحة تنتظر أبطأ استعلام لا مجموعها.
   */
  const [
    { data: conv },
    { data: rows },
    { data: prefs },
    { data: profile },
    { data: convFiles },
    evidence,
  ] = await Promise.all([
      supabase
        .from("conversations")
        .select("id, title, model_id")
        .eq("id", id)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("messages")
        .select("id, role, content, metadata")
        .eq("conversation_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase
        .from("user_preferences")
        .select("default_model_id")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
      supabase
        .from("files")
        // mime_type لازم: الواجهة تُفرّق به الصور (لا تدخل RAG) عن المستندات
        .select("id, original_name, mime_type, status, rag_total_chunks, rag_done_chunks, rag_error")
        .eq("conversation_id", id)
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(20),
      loadConversationEvidence(supabase, id),
    ]);
  if (!conv) redirect("/chat");

  /**
   * القائمة تُوسم بخطة المستخدم على الخادم: ما يظهر يجب أن يطابق ما يقبله
   * /api/chat، وإلا اختار المستخدم ما سيُرفض أو يُخفَّض.
   */
  const policy = await loadModelPolicy(supabase, userId);
  const minTierById = new Map(policy.models.map((m) => [m.id, m.min_tier]));
  const models: ChatModel[] = listModelOptions().map((o) => {
    const minTier = minTierById.get(o.id) ?? "free";
    return { ...o, minTier, locked: !tierAllows(policy.userTier, minTier) };
  });

  const initialAttachments = (convFiles ?? []).map((f) => ({
    id: f.id,
    name: f.original_name,
    status: f.status,
    mime: f.mime_type,
    ragTotal: f.rag_total_chunks,
    ragDone: f.rag_done_chunks,
    ragError: f.rag_error,
  }));

  const candidates = [conv.model_id, prefs?.default_model_id];
  const initialModelId =
    candidates.find((c) => c && models.some((m) => m.id === c)) ??
    models.find((m) => !m.locked)?.id ??
    null;

  const initialMessages = (rows ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const meta = (m.metadata ?? {}) as {
        sources?: unknown;
        completion?: { status?: string; reason?: string | null; notice?: boolean };
        evidenceSegmentationVersion?: unknown;
        evidenceLayout?: unknown;
      };
      // حالة الاكتمال (v0.7.0 RC8): تأتي من القاعدة وحدها — لا localStorage.
      // غيابها يعني رَدًّا مكتملًا، فالرسائل القديمة تُعرض كما كانت تمامًا.
      const status = meta.completion?.status;
      /**
       * الأدلة على ردود المساعد وحدها، والرسائل القديمة تحصل على
       * `citations: []` و`evidence: null` — أي «لا أدلة» صراحةً بدل حقلٍ غائب
       * تفرّقه الواجهة عن الفارغ. رسالة المستخدم لا تحمل استشهادًا أصلًا.
       */
      const isAssistant = m.role === "assistant";
      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        citations: isAssistant ? (evidence.byMessage.get(m.id) ?? []) : [],
        evidence: isAssistant ? evidenceSummaryFromMetadata(m.metadata) : null,
        /**
         * ★ التخطيط المخزَّن (v0.9.2) — نفس ما بُثّ لحظة التوليد.
         *
         * يُقرأ بـ`readEvidenceLayout` لا بتحويل نوع: `metadata` حقل JSONB
         * حرّ، وصفٌّ قديم قد يحمل أي شيء. وغيابه في رسالة قديمة يعطي
         * `segmentationVersion: null` — وهي إشارة «حلّل كما في السابق»،
         * لا إشارة عطل.
         */
        segmentationVersion: isAssistant
          ? typeof meta.evidenceSegmentationVersion === "number"
            ? meta.evidenceSegmentationVersion
            : null
          : null,
        evidenceLayout: isAssistant ? readEvidenceLayout(meta.evidenceLayout) : null,
        sources: Array.isArray(meta.sources)
          ? (meta.sources as import("@/components/chat/chat-view").MsgSource[])
          : undefined,
        completion:
          status && status !== "complete"
            ? {
                status: status as import("@/components/chat/chat-view").MsgCompletionStatus,
                noticeInText: meta.completion?.notice === true,
              }
            : undefined,
      };
    });

  return (
    <ChatView
      key={id}
      conversationId={id}
      initialMessages={initialMessages}
      initialTitle={conv.title}
      models={models}
      initialModelId={initialModelId}
      greetingName={profile?.display_name ?? ""}
      initialAttachments={initialAttachments}
      devMode={process.env.NODE_ENV !== "production"}
    />
  );
}
