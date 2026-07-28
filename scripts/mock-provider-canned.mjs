#!/usr/bin/env node
/**
 * مزوّد SSE وهمي بردود ثابتة (v0.7.0 RC7) — لبوابة حتمية لا تعتمد على عشوائية
 * نموذج مجاني. يختار الرد حسب نص الطلب، ويبثّه على دفعات صغيرة كالمزوّد الحقيقي.
 *
 *   node mock-provider-canned.mjs <port>
 *
 * /stats يُرجع عدد النداءات — للتحقق أن كل طلب استدعى المزوّد مرة واحدة، وأن
 * المسارات القصيرة (short-circuit) لم تستدعِه إطلاقًا.
 * /reset يصفّر العدّادات بين المراحل.
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 8080);
const stats = { calls: 0, byKey: {} };

/** نصوص ثابتة: أسيجة زوجية + مصطلحات تقنية خارج السياج + نثر عربي */
const ANSWERS = {
  typescript: `إليك الدالة المطلوبة. لاحظ أن useState غير مستخدم هنا لأنها دالة خالصة.

\`\`\`ts
export function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
\`\`\`

يمكنك تشغيل الاختبارات بعد تحديث package.json.`,

  python: `هذه دالة بايثون تجلب مستخدمًا وترفع استثناءً عند الفشل.

\`\`\`python
def fetch_user(user_id: str) -> dict:
    response = requests.get(f"/api/users/{user_id}", timeout=10)
    response.raise_for_status()
    return response.json()
\`\`\`

ثبّت الاعتمادية عبر pip قبل التشغيل.`,

  sql: `الاستعلام المطلوب يجمع الرسائل لكل مستخدم خلال أسبوع.

\`\`\`sql
select user_id, count(*) as total
from messages
where created_at > now() - interval '7 days'
group by user_id
order by total desc;
\`\`\`

يفضَّل إضافة فهرس على created_at لتسريع النتيجة.`,

  react: `مكوّن بسيط يعتمد على useState لإدارة الحالة.

\`\`\`tsx
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
\`\`\`

ضع الملف في src/app/page.tsx ثم شغّل الخادم.`,

  bash: `هذا السكربت يضغط كل ملفات السجل في المجلد الحالي باستخدام gzip.

\`\`\`bash
for f in *.log; do
  gzip "$f"
done
\`\`\`

لو أردت رفعها بعد الضغط استخدم curl، وتأكد من صلاحيات التنفيذ عبر chmod.`,

  json: `هذا مثال مختصر لملف package.json بوضع صارم.

\`\`\`json
{
  "compilerOptions": { "strict": true, "target": "ES2022" }
}
\`\`\`

احفظه في جذر المشروع.`,

  compiler: `الخطأ يعني أنك مرّرت نصًا حيث يُتوقَّع رقم.

\`\`\`ts
const total: number = Number(value);
\`\`\`

حوّل القيمة قبل التمرير، أو عدّل توقيع الدالة ليقبل string.`,

  arabic: `الفرق أن const لا يُعاد إسنادها بينما let تقبل ذلك.

\`\`\`js
const a = 1;
let b = 2;
b = 3;
\`\`\`

استخدم const افتراضيًا، ولا تلجأ إلى let إلا عند الحاجة الفعلية.`,

  // حالات سلبية — يجب أن تبقى ممنوعة حتى في طلب برمجي
  spanish: `إليك الحل المطلوب.

\`\`\`ts
const x = 1;
\`\`\`

ثم قال bajo el sol وانتهى الأمر تمامًا.`,

  hola: `الكود جاهز.

\`\`\`ts
const y = 2;
\`\`\`

وقال hola amigo في النهاية.`,

  english: `الكود جاهز للاستخدام.

\`\`\`ts
const z = 3;
\`\`\`

ثم كتب this is an unrelated english sentence here وانتهى.`,

  cyrillic: `الشرح كالتالي مع مثال قصير привет للتوضيح الكامل هنا.`,

  chinese: `الشرح كالتالي مع مثال قصير 你好 للتوضيح الكامل هنا.`,
};

function pick(prompt) {
  const p = prompt.toLowerCase();
  if (p.includes("حالةإسبانية")) return ["spanish", ANSWERS.spanish];
  if (p.includes("حالةهولا")) return ["hola", ANSWERS.hola];
  if (p.includes("حالةإنجليزية")) return ["english", ANSWERS.english];
  if (p.includes("حالةسيريلية")) return ["cyrillic", ANSWERS.cyrillic];
  if (p.includes("حالةصينية")) return ["chinese", ANSWERS.chinese];
  if (p.includes("typescript")) return ["typescript", ANSWERS.typescript];
  if (p.includes("بايثون") || p.includes("python")) return ["python", ANSWERS.python];
  if (p.includes("sql") || p.includes("استعلام")) return ["sql", ANSWERS.sql];
  if (p.includes("react") || p.includes("مكوّن")) return ["react", ANSWERS.react];
  if (p.includes("bash") || p.includes("سكربت")) return ["bash", ANSWERS.bash];
  if (p.includes("tsconfig") || p.includes("json")) return ["json", ANSWERS.json];
  if (p.includes("ts2345") || p.includes("الخطأ")) return ["compiler", ANSWERS.compiler];
  return ["arabic", ANSWERS.arabic];
}

const server = http.createServer((req, res) => {
  if (req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url === "/reset") {
    stats.calls = 0;
    stats.byKey = {};
    res.writeHead(200).end("ok");
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    stats.calls++;
    let prompt = "";
    try {
      const j = JSON.parse(body);
      prompt = (j.messages ?? []).map((m) => m.content).join(" ");
    } catch {}
    const [key, answer] = pick(prompt);
    stats.byKey[key] = (stats.byKey[key] ?? 0) + 1;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({ model: "mock/canned", choices: [{ delta: { content: "" } }] })}\n\n`,
    );

    // بثّ على دفعات صغيرة كالمزوّد الحقيقي
    const chunks = answer.match(/[\s\S]{1,24}/g) ?? [];
    let i = 0;
    const t = setInterval(() => {
      if (i >= chunks.length) {
        clearInterval(t);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 50 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          model: "mock/canned",
          choices: [{ delta: { content: chunks[i] } }],
        })}\n\n`,
      );
      i++;
    }, 12);
  });
});

server.listen(port, "0.0.0.0", () =>
  console.log(JSON.stringify({ ev: "listening", port })),
);
