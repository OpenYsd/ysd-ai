/**
 * فحص جودة العربية للنماذج المجانية المرشحة على OpenRouter.
 * بث حقيقي + قياس نسب الأحرف (عربي/لاتيني/سيريلي/CJK) — لا يطبع أي مفتاح.
 * التشغيل: node scripts/probe-arabic-models.mjs [model1 model2 ...]
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-4-31b-it:free",
      "openai/gpt-oss-120b:free",
    ];

const SYSTEM =
  "أنت YSD AI، مساعد ذكي احترافي تابع لمنصة YSD AI Studio.\nأجب دائمًا بلغة المستخدم.\nعندما يكتب المستخدم بالعربية، استخدم العربية فقط، باستثناء أسماء التقنيات والأكواد عند الحاجة.\nلا تخلط العربية مع لغات أخرى.";

function ratios(text) {
  let arabic = 0, latin = 0, cyrillic = 0, cjk = 0, total = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (!/\p{L}/u.test(ch)) continue;
    total++;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f)) arabic++;
    else if (c <= 0x024f) latin++;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  return { total, arabic, latin, cyrillic, cjk };
}

for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 160,
        temperature: 0.3,
        top_p: 0.9,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "عرّفني بنفسك باختصار، ثم اذكر ثلاث نصائح لتعلم البرمجة." },
        ],
      }),
    });

    if (!res.ok || !res.body) {
      console.log(`${model}\n  ✗ HTTP ${res.status}`);
      continue;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", actualModel = "", chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:") || t.includes("[DONE]")) continue;
        try {
          const j = JSON.parse(t.slice(5).trim());
          if (j.model) actualModel = j.model;
          const d = j.choices?.[0]?.delta?.content;
          if (d) { text += d; chunks++; }
        } catch {}
      }
    }

    const r = ratios(text);
    const pct = (n) => (r.total ? Math.round((n / r.total) * 100) : 0);
    console.log(`${model}`);
    console.log(`  model field: ${actualModel} | chunks=${chunks} | ${Date.now() - t0}ms | letters=${r.total}`);
    console.log(`  arabic=${pct(r.arabic)}% latin=${pct(r.latin)}% cyrillic=${pct(r.cyrillic)}% cjk=${pct(r.cjk)}%`);
    console.log(`  sample: ${text.slice(0, 120).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`${model}\n  ✗ ${e.message}`);
  }
}
