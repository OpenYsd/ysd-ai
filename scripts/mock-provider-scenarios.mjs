#!/usr/bin/env node
/**
 * مزوّد SSE وهمي بسيناريوهات حتمية (v0.7.0 RC8) — للتحقق التشغيلي وحده.
 *
 *   node mock-provider-scenarios.mjs <port>
 *
 * اختيار السيناريو **بكلمات عربية خالصة** داخل رسالة المستخدم. لا نستخدم
 * علامات لاتينية مثل __test_mode لأن أي رمز لاتيني في نص المستخدم يؤثر في
 * كشف اللغة المتوقّعة، فيلوّث ما نقيسه أصلًا.
 *
 * /عدادات  يقرأ العدادات · /تصفير يُصفّرها. خارج صورة الإنتاج تمامًا:
 * الملف في scripts/ ولا يُستورد من أي مسار تطبيق، والمزوّد لا يُستخدم إلا
 * حين يُضبط YSD_TEST_PROVIDER_URL خلف بوابة YSD_ENABLE_TEST_PROVIDER.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8080);

const stats = {
  provider_calls: 0,
  active_sockets: 0,
  client_aborted: 0,
  chunks_sent: 0,
  released: false,
  requests_by_scenario: {},
};

/** استجابات ممسوكة تنتظر أمر /إطلاق — لإثبات القفل أثناء بثّ حيّ فعلًا */
const held = new Set();

/** كلمات عربية تختار السيناريو — لا حرف لاتيني فيها */
const SCENARIOS = {
  "سيناريو-سياج-مشطور": "split_fence_complete",
  "سيناريو-حارس-بعد-كود": "guard_after_code",
  "سيناريو-مهلة-قبل-نص": "timeout_before_text",
  "سيناريو-مهلة-أثناء-البث": "timeout_midstream",
  "سيناريو-مهلة-بعد-إغلاق": "timeout_after_closed",
  "سيناريو-انقطاع-المزود": "provider_disconnect",
  "سيناريو-عادي": "normal_complete",
  "سيناريو-متابعة-ناجحة": "continuation_success",
  "سيناريو-متابعة-فاشلة": "continuation_failure",
  "سيناريو-ممسوك-مفتوح": "hold_open_after_first_chunk",
};

function pickScenario(prompt) {
  for (const [key, name] of Object.entries(SCENARIOS)) {
    if (prompt.includes(key)) return name;
  }
  return "normal_complete";
}

/** انقسام السياج عمدًا: نهاية الجزء الأول + بداية الثاني تصنع ``` كاملة */
const SPLIT_CHUNKS = [
  "**الدالة**\n\n`",
  "``python\nimport requests",
  "\n\ndef fetch_user(user_id):",
  "\n    response = requests.get(url)\n    return response.json()\n```",
];

const GUARD_CHUNKS = [
  "هذا شرح عربي للدالة المطلوبة.\n\n",
  "```python\ndef fetch_user(user_id):\n    return requests.get(url).json()\n```\n\n",
  "ثم قال bajo el sol وانتهى الأمر تمامًا.",
];

const MIDSTREAM_CHUNKS = ["**مثال**\n\n```python\nimport requests"];
const AFTER_CLOSED_CHUNKS = ["**مثال**\n\n```python\nx = 1\n```\n\nشرح عربي بعد الكتلة"];
const DISCONNECT_CHUNKS = ["**الحل**\n\n```python\ndef fetch_user(user_id):"];
/** تكملة عربية نظيفة — تُعطى للنداء الثاني في سيناريو المتابعة الناجحة */
const CONT_OK_CHUNKS = ["وبهذا تكتمل الفكرة بعبارة عربية سليمة تمامًا."];

const NORMAL_CHUNKS = [
  "هذه إجابة عربية قصيرة ومكتملة عن السؤال المطروح.",
];

const sse = (text) =>
  `data: ${JSON.stringify({ model: "mock/scenarios", choices: [{ delta: { content: text } }] })}\n\n`;

const server = http.createServer((req, res) => {
  if (req.url === "/عدادات" || req.url === encodeURI("/عدادات")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url === "/تصفير" || req.url === encodeURI("/تصفير")) {
    stats.provider_calls = 0;
    stats.active_sockets = 0;
    stats.client_aborted = 0;
    stats.chunks_sent = 0;
    stats.released = false;
    stats.requests_by_scenario = {};
    res.writeHead(200).end("ok");
    return;
  }

  /** يُطلق الاستجابات الممسوكة: تُكمل بثّها ثم done ثم إغلاق */
  if (req.url === "/إطلاق" || req.url === encodeURI("/إطلاق")) {
    stats.released = true;
    const n = held.size;
    for (const fn of held) fn();
    held.clear();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ released: n }));
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    stats.provider_calls++;
    stats.active_sockets++;
    let prompt = "";
    try {
      const j = JSON.parse(body);
      /**
       * السيناريو يُقرأ من **آخر رسالة مستخدم** وحدها، لا من سلسلة الرسائل
       * كاملة: الطلب الثاني في المحادثة يحمل تاريخها، فكان يطابق كلمة سيناريو
       * التبادل السابق ويعيد سلوكه — فيظهر تبادل مكتمل بعلامة نقص خاطئة.
       */
      const msgs = j.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      prompt = lastUser?.content ?? "";
    } catch {}
    const scenario = pickScenario(prompt);
    stats.requests_by_scenario[scenario] = (stats.requests_by_scenario[scenario] ?? 0) + 1;

    let closed = false;
    /**
     * الإغلاق يُرصد من **الاستجابة** لا من الطلب: req.on("close") يُطلق في
     * Node عند اكتمال جسم الطلب اعتياديًا لا عند إجهاض العميل، فربطه هنا كان
     * يُعلن الاتصال مغلقًا قبل بثّ أي دفعة.
     */
    const onClose = () => {
      if (closed) return;
      closed = true;
      stats.active_sockets = Math.max(0, stats.active_sockets - 1);
      stats.client_aborted++;
      console.log(JSON.stringify({ ev: "closed", scenario, active: stats.active_sockets }));
    };
    res.on("close", () => {
      if (!res.writableEnded) onClose(); // إغلاق مبكر = إجهاض عميل
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const finish = () => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      if (!closed) {
        closed = true;
        stats.active_sockets = Math.max(0, stats.active_sockets - 1);
      }
    };

    const emit = (chunks, after) => {
      let i = 0;
      const t = setInterval(() => {
        if (closed) {
          clearInterval(t);
          return;
        }
        if (i >= chunks.length) {
          clearInterval(t);
          after();
          return;
        }
        res.write(sse(chunks[i]));
        stats.chunks_sent++;
        i++;
      }, 40);
    };

    switch (scenario) {
      case "split_fence_complete":
        emit(SPLIT_CHUNKS, finish);
        break;
      case "guard_after_code":
        emit(GUARD_CHUNKS, finish);
        break;
      case "continuation_success":
        // النداء الأول يسرّب؛ والثاني (المتابعة) يعطي تكملة عربية نظيفة
        emit(
          stats.requests_by_scenario[scenario] === 1 ? GUARD_CHUNKS : CONT_OK_CHUNKS,
          finish,
        );
        break;
      case "continuation_failure":
        // النداءان يسرّبان معًا ⇒ تُرفض المتابعة ويُعلَّم الرد ناقصًا
        emit(GUARD_CHUNKS, finish);
        break;
      /**
       * دفعة واحدة ثم **إمساك** الاتصال مفتوحًا بلا done وبلا إغلاق، حتى يصل
       * أمر /إطلاق. هذا وحده يجعل الحاجز قاطعًا: active_sockets=1 حقيقية أثناء
       * النقرة الثانية، فيصير إثبات القفل أثناء بثّ حيّ لا استنتاجًا.
       */
      case "hold_open_after_first_chunk":
        res.write(sse("**بداية**\n\nجزء أول من الرد "));
        stats.chunks_sent++;
        held.add(() => {
          if (closed) return;
          res.write(sse("وبقيته بعد الإطلاق بعبارة عربية مكتملة."));
          stats.chunks_sent++;
          finish();
        });
        break;
      case "timeout_before_text":
        // اتصال مفتوح بلا أي نص — حتى تنتهي مهلة التطبيق
        break;
      case "timeout_midstream":
        emit(MIDSTREAM_CHUNKS, () => {
          /* صمت متعمّد: لا finish — ينتظر المهلة */
        });
        break;
      case "timeout_after_closed":
        emit(AFTER_CLOSED_CHUNKS, () => {
          /* صمت بعد كتلة مغلقة */
        });
        break;
      case "provider_disconnect":
        // يبث جزءًا ثم يقطع الاتصال فجأة بلا [DONE] ولا finish_reason
        emit(DISCONNECT_CHUNKS, () => {
          res.destroy();
          onClose();
        });
        break;
      default:
        emit(NORMAL_CHUNKS, finish);
    }
  });
});

server.listen(port, "0.0.0.0", () =>
  console.log(JSON.stringify({ ev: "listening", port })),
);
