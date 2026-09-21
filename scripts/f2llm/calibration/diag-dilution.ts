/** Diagnostic: how does the chunk's content mix affect the query↔chunk cosine? (F2LLM via the app provider) */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "../../../lib/rag/chunking";
import { getEmbeddingProvider } from "../../../lib/rag/embeddings";

const src = readFileSync(join(process.cwd(), "scripts", "rag-calibrate.mjs"), "utf8");
const DOC = /const DOC = `([\s\S]*?)`;/.exec(src)![1]!;
const provider = getEmbeddingProvider();
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const chunks = chunkText(DOC).map((c) => c.content);
const sentences = DOC.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 20);
const qs = ["ما هو رمز الدعم الفني الرسمي؟", "كم الحد الأقصى لحجم الملف في الباقة المجانية؟", "كم عدد الباقات المتاحة في المنصة؟", "هل تشارك المنصة ملفات المستخدمين مع جهات خارجية؟", "ما هي عاصمة اليابان؟"];
console.log("chunks:", chunks.length, chunks.map((c) => c.length));
const cv = await provider.embedPassages(chunks);
const sv = await provider.embedPassages(sentences);
for (const q of qs) {
  const qv = await provider.embedQuery(q);
  const whole = cv.map((v) => dot(qv, v).toFixed(3));
  const bySent = sv.map((v, i) => ({ s: dot(qv, v), t: sentences[i]!.slice(0, 40) })).sort((a, b) => b.s - a.s)[0]!;
  console.log(q.padEnd(52), "chunk:", whole.join(","), "| best sentence:", bySent.s.toFixed(3), JSON.stringify(bySent.t));
}
