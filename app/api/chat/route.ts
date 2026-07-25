import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getRequestContext, TIMING_HEADER } from "@/lib/auth/request-context";
import { chatRequestSchema } from "@/lib/validation/chat";
import { resolveProviderForModel } from "@/lib/ai/registry";
import { FREE_MODEL_CHAIN } from "@/lib/ai/free-models";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import {
  ambiguousCandidates,
  buildEntityContext,
  confidentEntities,
} from "@/lib/ai/entity-aliases";
import { detectUserGrounding } from "@/lib/ai/grounding-guard";
import {
  buildSourcesContext,
  NO_MATCH_HINT,
  retrieveSnippets,
  type RetrievedSnippet,
} from "@/lib/rag/retrieval";
import { gatherChatContext, mergeServerTiming } from "@/lib/chat/context";
import { claimRequest, recordRequestMessage } from "@/lib/chat/idempotency";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_TITLE = "محادثة جديدة";

/** Rate limiting بسيط داخل الذاكرة — يُستبدل بـ Redis/Upstash في الإنتاج */
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(userId: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now > b.resetAt) {
    buckets.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export async function POST(req: NextRequest) {
  const tStart = Date.now();
  // request_id من الوسيط (أو مولّد احتياطيًا) — للربط في السجلات، بلا أي بيانات شخصية
  const requestId = req.headers.get("x-ysd-request-id") ?? crypto.randomUUID();
  const supabase = await createClient();

  // 1) المصادقة والحالة — من سياق الوسيط المُتحقَّق (ترويسات x-ysd-* المختومة).
  //    يُسقط رحلتَي getUser + profiles؛ ولو غاب السياق يسقط getRequestContext إلى
  //    تحقّق شبكي كامل (fallback آمن — لا ثقة بترويسة ناقصة).
  const tAuth = Date.now();
  const ctx = await getRequestContext(await headers(), supabase);
  const authMs = Date.now() - tAuth;
  if (!ctx) return json({ error: "انتهت جلستك. سجّل الدخول من جديد.", code: "auth_expired" }, 401);
  const userId = ctx.userId;

  // 2) Rate limiting
  if (!rateLimit(userId)) return json({ error: "تجاوزت حد الطلبات، حاول بعد قليل." }, 429);

  // 2ب) حالة الحساب — نفس الفحص والرسائل (banned يمنعه الوسيط أيضًا؛ دفاع مزدوج)
  if (ctx.status === "banned")
    return json({ error: "حسابك موقوف. تواصل مع إدارة المنصة." }, 403);
  if (ctx.status === "ai_suspended")
    return json({ error: "استخدام الذكاء الاصطناعي معلّق لحسابك. تواصل مع إدارة المنصة." }, 403);

  // 3) التحقق من المدخلات
  const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات الطلب غير صحيحة." }, 400);
  const { conversationId, modelId, message, editMessageId, regenerate, clientRequestId } =
    parsed.data;

  // 4+5) التحقّق: الملكية وحدّ الاستهلاك — مستقلان، فيُنفَّذان بالتوازي.
  //      الترتيب الأمني ونفس رسائل الخطأ محفوظان: الملكية (404) تُفحص قبل الحد (403).
  const [{ data: conv }, { data: allowed }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, title, project_id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .single(),
    supabase.rpc("check_usage_allowed", { p_user_id: userId }),
  ]);
  if (!conv) return json({ error: "المحادثة غير موجودة." }, 404);
  if (allowed === false) return json({ error: "وصلت إلى حد الاستهلاك في باقتك الحالية." }, 403);

  // تعليمات المشروع الخاصة تُضاف إلى موجه النظام
  let systemPrompt = SYSTEM_PROMPT;
  if (conv.project_id) {
    const { data: proj } = await supabase
      .from("projects")
      .select("custom_instructions")
      .eq("id", conv.project_id)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (proj?.custom_instructions) {
      systemPrompt = `${SYSTEM_PROMPT}\n\nتعليمات خاصة من صاحب المشروع:\n${proj.custom_instructions}`;
    }
  }

  // 6) اختيار الموفر عبر الطبقة الموحدة
  const provider = resolveProviderForModel(modelId);
  if (!provider) return json({ error: "النموذج المطلوب غير متاح." }, 400);

  // 7) تجهيز الرسائل حسب نوع العملية
  let userMessageId: string | null = null;
  // عنوان تلقائي مؤجَّل — يُدمج في تحديث المحادثة المتوازي بدل استعلام منفصل
  let newTitle: string | null = null;

  if (editMessageId) {
    // تعديل رسالة مستخدم سابقة: حدّث النص واحذف (ناعمًا) كل ما بعدها
    const { data: target } = await supabase
      .from("messages")
      .select("id, role, created_at")
      .eq("id", editMessageId)
      .eq("conversation_id", conversationId)
      .is("deleted_at", null)
      .single();
    if (!target || target.role !== "user")
      return json({ error: "الرسالة غير موجودة." }, 404);

    await supabase
      .from("messages")
      .update({ content: message })
      .eq("id", editMessageId);
    await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .gt("created_at", target.created_at)
      .is("deleted_at", null);
    userMessageId = editMessageId;
  } else if (regenerate) {
    // إعادة توليد: احذف (ناعمًا) الردود التالية لآخر رسالة مستخدم
    const { data: lastUser } = await supabase
      .from("messages")
      .select("id, created_at")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!lastUser) return json({ error: "لا توجد رسالة لإعادة التوليد." }, 400);

    await supabase
      .from("messages")
      .update({ deleted_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .gt("created_at", lastUser.created_at)
      .is("deleted_at", null);
    userMessageId = lastUser.id;
  } else {
    // رسالة جديدة — بحارس ازدواج: الطلب نفسه (client_request_id) لا يُحفظ مرتين
    // مهما تكرر إرساله من نقر مزدوج أو إعادة اتصال.
    const claim = claimRequest(userId, clientRequestId);
    if (!claim.isNew) {
      console.log(`[chat] rid=${requestId} duplicate_request=true`);
      return json(
        {
          error: "هذه الرسالة أُرسلت بالفعل.",
          code: "duplicate_request",
          userMessageId: claim.previousUserMessageId,
        },
        409,
      );
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content: message })
      .select("id")
      .single();
    if (insertErr || !inserted) return json({ error: "تعذّر حفظ الرسالة." }, 500);
    userMessageId = inserted.id;
    recordRequestMessage(userId, clientRequestId, userMessageId);

    // عنوان تلقائي من أول رسالة — يُدمج في تحديث المحادثة المتوازي أدناه
    if (conv.title === DEFAULT_TITLE && message) {
      newTitle = message.length > 60 ? `${message.slice(0, 60)}…` : message;
    }
  }

  // ===== الموازاة: بعد ضمان حفظ رسالة المستخدم (أعلاه)، ننفّذ الاستعلامات
  // المستقلة معًا بدل تسلسلها. لا نبدأ المزوّد قبل هذه النقطة. Promise.allSettled
  // حتى لا يُسقط فشلُ عملية غير حرجة العملياتِ الحرجة. =====
  //   (أ) سياق المحادثة (حرج — سلوك حالي: فشل ⇒ سياق فارغ)
  //   (ب) معرّفات ملفات السياق (حرج — سلوك حالي: فشل ⇒ لا RAG)
  //   (ج) تحديث المحادثة (updated_at/model_id/title) — **غير حرج**
  //   (د) تحديث نشاط المشروع — **غير حرج**
  const convUpdate: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    model_id: modelId,
  };
  if (newTitle) convUpdate.title = newTitle;

  const { history, contextFileIds, dbMs } = await gatherChatContext(supabase, {
    conversationId,
    userId,
    projectId: conv.project_id,
    convUpdate,
    requestId,
  });

  // RAG: استرجاع مقاطع الملفات (بعد توفّر السياق ومعرّفات الملفات معًا)
  let ragSnippets: RetrievedSnippet[] = [];
  let ragSearchedNoMatch = false;
  let ragMs = 0;
  const tRag = Date.now();
  const queryText =
    message ?? [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (queryText && contextFileIds.length > 0) {
    try {
      const outcome = await retrieveSnippets(supabase, queryText, contextFileIds);
      ragSnippets = outcome.snippets;
      // بُحث في ملفات جاهزة لكن بلا تطابق واثق → نلمّح للنموذج بالتصريح
      ragSearchedNoMatch = outcome.searched && outcome.snippets.length === 0;
    } catch (err) {
      // فشل الاسترجاع لا يمنع المحادثة — تُكمل بدون مصادر
      console.error(`[rag] retrieval failed: ${(err as Error).message?.slice(0, 80)}`);
    }
    ragMs = Date.now() - tRag;
  }
  if (ragSnippets.length > 0) {
    // كتلة منفصلة مُسوَّرة — الموجه الأساسي لا يتغير ومحتوى الملفات ليس تعليمات
    systemPrompt = `${systemPrompt}\n\n${buildSourcesContext(ragSnippets)}`;
  } else if (ragSearchedNoMatch) {
    systemPrompt = `${systemPrompt}\n\n${NO_MATCH_HINT}`;
  }

  // إسناد التفاصيل المتخصصة: مصادر المستخدم أولًا، ثم سياقه الصريح. معرفة
  // النموذج وحدها ليست إسنادًا — فالتفاصيل غير الموثقة تُمنع في الوضع المحمي.
  const grounding: NonNullable<Parameters<typeof provider.streamChat>[0]["grounding"]> =
    ragSnippets.length > 0
      ? { source: "rag" }
      : detectUserGrounding(queryText)
        ? { source: "user_context" }
        : { source: "none" };

  // أسماء الكيانات بالنقحرة («الدن رينق» = Elden Ring): سياق داخلي في الموجّه
  // وحده — رسالة المستخدم المحفوظة والمعروضة والمُرسلة لا تتغير بحرف.
  const entities = confidentEntities(queryText);
  const ambiguous = ambiguousCandidates(queryText);
  if (entities.length > 0) {
    systemPrompt = `${systemPrompt}\n\n${buildEntityContext(entities)}`;
  }
  if (ambiguous.length > 0) {
    // التباس في الاسم → سؤال توضيح واحد بدل التخمين أو الخلط
    systemPrompt =
      `${systemPrompt}\n\nالاسم في رسالة المستخدم يحتمل أكثر من عمل ` +
      `(${ambiguous.map((a) => a.canonical).join(" / ")}). لا تخمّن ولا تخلط بينها: ` +
      `اطرح سؤال توضيح واحدًا قصيرًا لتحديد المقصود.`;
  }
  if (entities.length > 0 || ambiguous.length > 0) {
    // سجل آمن: الأسماء الموحّدة فقط — لا نص المستخدم
    console.log(
      `[chat] rid=${requestId} entities=${entities.map((e) => e.canonical).join(",") || "none"} ` +
        `ambiguous=${ambiguous.map((a) => a.canonical).join(",") || "none"}`,
    );
  }

  // 9) بث الرد عبر SSE
  const encoder = new TextEncoder();
  let assistantText = "";
  // النموذج الفعلي الذي أجاب (قد يختلف عن المنطقي مثل ysd/free)
  let actualModelId: string | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // enqueue آمن — قد ينقطع العميل أثناء البث
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* العميل أغلق الاتصال */
        }
      };

      // مصادر الرد — للعرض تحت الإجابة (similarity في وضع التطوير فقط)
      if (ragSnippets.length > 0) {
        send({
          type: "sources",
          sources: ragSnippets.map((s) => ({
            fileId: s.fileId,
            fileName: s.fileName,
            pageNumber: s.pageNumber,
            snippet: s.content.slice(0, 180),
            ...(process.env.NODE_ENV !== "production"
              ? { similarity: s.similarity }
              : {}),
          })),
        });
      }

      // قياس المزوّد داخل نفس الطلب — أرقام فقط، بلا محتوى ولا مفاتيح
      const tProvider = Date.now();
      let providerFirstByteMs = -1;
      let totalFirstTokenMs = -1;
      // v0.6.5: الوضع المختار وزمن الحالة وعدد إعادات التوليد — أرقام فقط
      let statusMs = -1;
      let answerMode: "general" | "protected" = "general";
      let regenerations = 0;
      let emptyCompletions = 0;
      let groundingSource: string = grounding.source;
      let protectedDetailBlocked = false;
      let shortCircuit = false;
      let providerCalls = -1;

      try {
        for await (const chunk of provider.streamChat({
          modelId,
          messages: history,
          systemPrompt,
          grounding,
          signal: req.signal,
        })) {
          if (chunk.type === "text" && chunk.text) {
            if (providerFirstByteMs < 0) {
              providerFirstByteMs = Date.now() - tProvider;
              totalFirstTokenMs = Date.now() - tStart;
            }
            assistantText += chunk.text;
            send({ type: "text", text: chunk.text });
          } else if (chunk.type === "status" && chunk.text) {
            // حالة تحقّق قصيرة — تُعرض فورًا ولا تُحفظ ضمن نص الرد
            if (statusMs < 0) statusMs = Date.now() - tProvider;
            send({ type: "status", text: chunk.text });
          } else if (chunk.type === "meta" && chunk.model) {
            actualModelId = chunk.model;
            if (chunk.mode) answerMode = chunk.mode;
            if (typeof chunk.regenerations === "number") regenerations = chunk.regenerations;
            if (typeof chunk.emptyCompletions === "number") emptyCompletions = chunk.emptyCompletions;
            // حقول داخلية فقط — تُسجَّل ولا تُرسل للعميل
            if (chunk.groundingSource) groundingSource = chunk.groundingSource;
            if (typeof chunk.protectedDetailBlocked === "boolean") {
              protectedDetailBlocked = chunk.protectedDetailBlocked;
            }
            if (typeof chunk.shortCircuit === "boolean") shortCircuit = chunk.shortCircuit;
            if (typeof chunk.providerCalls === "number") providerCalls = chunk.providerCalls;
            // معرّف النموذج فقط — لا مفاتيح ولا محتوى حساس
            send({ type: "meta", model: chunk.model });
          } else if (chunk.type === "usage" && chunk.usage) {
            await supabase.from("usage_events").insert({
              user_id: userId,
              conversation_id: conversationId,
              model_id: actualModelId ?? modelId,
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
            });
          } else if (chunk.type === "error") {
            // الرمز يسمح للواجهة بعرض رسالة مناسبة لكل حالة بدل «تعذر الاتصال»
            send({ type: "error", error: chunk.error, code: chunk.errorCode ?? "unknown" });
          }
        }

        // حفظ رد المساعد (كاملًا أو جزئيًا عند الإيقاف) — مع مصادره إن وجدت
        let assistantMessageId: string | null = null;
        // لا تُحفظ رسالة مساعد فارغة أو مسافات فقط
        if (assistantText.trim()) {
          const insertRow: Record<string, unknown> = {
            conversation_id: conversationId,
            role: "assistant",
            content: assistantText,
            model_id: actualModelId ?? modelId,
          };
          // عمود metadata يأتي مع migration 0007 — لا نرسله إلا عند وجود مصادر
          if (ragSnippets.length > 0) {
            insertRow.metadata = {
              sources: ragSnippets.map((s) => ({
                fileId: s.fileId,
                fileName: s.fileName,
                pageNumber: s.pageNumber,
                snippet: s.content.slice(0, 180),
              })),
            };
          }
          const { data: saved } = await supabase
            .from("messages")
            .insert(insertRow)
            .select("id")
            .single();
          assistantMessageId = saved?.id ?? null;
        }
        send({ type: "done", userMessageId, assistantMessageId });

        // سجل آمن مرتبط بـrequest_id فقط — أرقام ومعرّف نموذج، بلا محتوى/بريد/توكن.
        // fallback_count = ترتيب النموذج الفعلي في السلسلة (كم نموذجًا سبقه فشلًا/تخطيًا).
        const idx = FREE_MODEL_CHAIN.indexOf(actualModelId ?? "");
        const fallbackCount = idx > 0 ? idx : 0;
        console.log(
          `[chat] rid=${requestId} model=${actualModelId ?? modelId} fallback_count=${fallbackCount} ` +
            `mode=${answerMode} regeneration_count=${regenerations} ` +
            `empty_completion_count=${emptyCompletions} status_ms=${statusMs} ` +
            `grounding_source=${groundingSource} protected_detail_blocked=${protectedDetailBlocked} ` +
            `protected_short_circuit=${shortCircuit} provider_calls=${providerCalls} ` +
            `auth_ms=${authMs} database_ms=${dbMs} rag_ms=${ragMs} ` +
            `provider_first_byte_ms=${providerFirstByteMs} ` +
            `total_first_text_ms=${totalFirstTokenMs} total_response_ms=${Date.now() - tStart}`,
        );
      } catch (err) {
        console.error("[chat] stream failed:", err);
        send({ type: "error", error: "حدث خطأ أثناء توليد الرد.", code: "unknown" });
      } finally {
        try {
          controller.close();
        } catch {
          /* مغلق مسبقًا */
        }
      }
    },
  });

  // زمن التطبيق قبل نداء المزوّد (auth+conv+usage+insert+db+RAG) — قياس آمن.
  const appBeforeProviderMs = Date.now() - tStart;
  console.log(`[chat] rid=${requestId} app_before_provider_ms=${appBeforeProviderMs}`);

  // Server-Timing مدموجة: قياسات الوسيط (auth/profile/settings) + database +
  // app_before_provider. ملاحظة فيزيائية: provider_first_byte و total_first_token
  // يُعرفان بعد إرسال هذه الترويسة (أثناء البث)، فمكانهما السجل الآمن لا الترويسة.
  const serverTiming = mergeServerTiming(req.headers.get(TIMING_HEADER) ?? "", [
    `database;dur=${dbMs}`,
    `app_before_provider;dur=${appBeforeProviderMs}`,
  ]);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-ysd-request-id": requestId,
      "Server-Timing": serverTiming,
    },
  });
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
