import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chatRequestSchema } from "@/lib/validation/chat";
import { resolveProviderForModel } from "@/lib/ai/registry";
import type { ChatMessage } from "@/lib/ai/types";
import {
  buildSourcesContext,
  getContextFileIds,
  NO_MATCH_HINT,
  retrieveSnippets,
  type RetrievedSnippet,
} from "@/lib/rag/retrieval";

export const runtime = "nodejs";
export const maxDuration = 120;

const DEFAULT_TITLE = "محادثة جديدة";
const SYSTEM_PROMPT = `أنت YSD AI، مساعد ذكي احترافي تابع لمنصة YSD AI Studio.
أجب دائمًا بلغة آخر رسالة كتبها المستخدم، حتى لو كانت المحادثة بدأت بلغة أخرى.
عندما يكتب المستخدم بالعربية، استخدم العربية فقط، باستثناء أسماء التقنيات والأكواد عند الحاجة.
عندما يكتب بالإنجليزية أو لغة أخرى، أجب بتلك اللغة.
لا تخلط العربية مع لغات أخرى.
لا تخترع اسم منشئ أو شركة أو معلومات شخصية.
لا تدّعِ أنك طورت المنتج.
اكتب بإجابة واضحة ومنظمة ومباشرة.`;

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
  const supabase = await createClient();

  // 1) المصادقة — على الخادم دائمًا
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "غير مصرح" }, 401);

  // 2) Rate limiting
  if (!rateLimit(user.id)) return json({ error: "تجاوزت حد الطلبات، حاول بعد قليل." }, 429);

  // 3) التحقق من المدخلات
  const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "بيانات الطلب غير صحيحة." }, 400);
  const { conversationId, modelId, message, editMessageId, regenerate } = parsed.data;

  // 4) التحقق من ملكية المحادثة (RLS يحمي أيضًا — دفاع مزدوج ضد IDOR)
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, title, project_id")
    .eq("id", conversationId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();
  if (!conv) return json({ error: "المحادثة غير موجودة." }, 404);

  // تعليمات المشروع الخاصة تُضاف إلى موجه النظام
  let systemPrompt = SYSTEM_PROMPT;
  if (conv.project_id) {
    const { data: proj } = await supabase
      .from("projects")
      .select("custom_instructions")
      .eq("id", conv.project_id)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (proj?.custom_instructions) {
      systemPrompt = `${SYSTEM_PROMPT}\n\nتعليمات خاصة من صاحب المشروع:\n${proj.custom_instructions}`;
    }
  }

  // 5) التحقق من حدود الاستهلاك
  const { data: allowed } = await supabase.rpc("check_usage_allowed", { p_user_id: user.id });
  if (allowed === false) return json({ error: "وصلت إلى حد الاستهلاك في باقتك الحالية." }, 403);

  // 6) اختيار الموفر عبر الطبقة الموحدة
  const provider = resolveProviderForModel(modelId);
  if (!provider) return json({ error: "النموذج المطلوب غير متاح." }, 400);

  // 7) تجهيز الرسائل حسب نوع العملية
  let userMessageId: string | null = null;

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
    // رسالة جديدة
    const { data: inserted, error: insertErr } = await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content: message })
      .select("id")
      .single();
    if (insertErr || !inserted) return json({ error: "تعذّر حفظ الرسالة." }, 500);
    userMessageId = inserted.id;

    // عنوان تلقائي من أول رسالة
    if (conv.title === DEFAULT_TITLE && message) {
      const title = message.length > 60 ? `${message.slice(0, 60)}…` : message;
      await supabase.from("conversations").update({ title }).eq("id", conversationId);
    }
  }

  // تحديث آخر نشاط للمحادثة والمشروع المرتبط
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString(), model_id: modelId })
    .eq("id", conversationId);
  if (conv.project_id) {
    await supabase
      .from("projects")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", conv.project_id)
      .eq("user_id", user.id);
  }

  // 8) جلب سياق المحادثة (آخر 30 رسالة)
  const { data: historyRows } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(30);

  const history: ChatMessage[] = (historyRows ?? []).map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }));

  // RAG: استرجاع مقاطع الملفات المرتبطة بالمحادثة/المشروع (الجاهزة فقط)
  let ragSnippets: RetrievedSnippet[] = [];
  let ragSearchedNoMatch = false;
  const queryText =
    message ?? [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (queryText) {
    try {
      const contextFileIds = await getContextFileIds(
        supabase,
        user.id,
        conversationId,
        conv.project_id,
      );
      if (contextFileIds.length > 0) {
        const outcome = await retrieveSnippets(supabase, queryText, contextFileIds);
        ragSnippets = outcome.snippets;
        // بُحث في ملفات جاهزة لكن بلا تطابق واثق → نلمّح للنموذج بالتصريح
        ragSearchedNoMatch = outcome.searched && outcome.snippets.length === 0;
      }
    } catch (err) {
      // فشل الاسترجاع لا يمنع المحادثة — تُكمل بدون مصادر
      console.error(`[rag] retrieval failed: ${(err as Error).message?.slice(0, 80)}`);
    }
  }
  if (ragSnippets.length > 0) {
    // كتلة منفصلة مُسوَّرة — الموجه الأساسي لا يتغير ومحتوى الملفات ليس تعليمات
    systemPrompt = `${systemPrompt}\n\n${buildSourcesContext(ragSnippets)}`;
  } else if (ragSearchedNoMatch) {
    systemPrompt = `${systemPrompt}\n\n${NO_MATCH_HINT}`;
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

      try {
        for await (const chunk of provider.streamChat({
          modelId,
          messages: history,
          systemPrompt,
          signal: req.signal,
        })) {
          if (chunk.type === "text" && chunk.text) {
            assistantText += chunk.text;
            send({ type: "text", text: chunk.text });
          } else if (chunk.type === "meta" && chunk.model) {
            actualModelId = chunk.model;
            // معرّف النموذج فقط — لا مفاتيح ولا محتوى حساس
            send({ type: "meta", model: chunk.model });
          } else if (chunk.type === "usage" && chunk.usage) {
            await supabase.from("usage_events").insert({
              user_id: user.id,
              conversation_id: conversationId,
              model_id: actualModelId ?? modelId,
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
            });
          } else if (chunk.type === "error") {
            send({ type: "error", error: chunk.error });
          }
        }

        // حفظ رد المساعد (كاملًا أو جزئيًا عند الإيقاف) — مع مصادره إن وجدت
        let assistantMessageId: string | null = null;
        if (assistantText) {
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
      } catch (err) {
        console.error("[chat] stream failed:", err);
        send({ type: "error", error: "حدث خطأ أثناء توليد الرد." });
      } finally {
        try {
          controller.close();
        } catch {
          /* مغلق مسبقًا */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
