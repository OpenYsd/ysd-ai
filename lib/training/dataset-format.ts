import "server-only";

import { createHash } from "node:crypto";

/**
 * الصيغة المعياريّة لعيّنة تدريب YSD (v0.9.6، المرحلة 3A).
 *
 * ── لماذا «معياريّة» ولماذا تُبنى باليد ──
 *
 * لأن البصمة وعدٌ بإعادة الإنتاج: نفس العيّنات ⇒ نفس البايتات ⇒ نفس
 * البصمة، اليوم وبعد سنة وعلى آلةٍ أخرى. وذلك لا يقوم على `JSON.stringify`
 * لكائنٍ حرفيّ: ترتيبُ مفاتيحه عَرَضٌ من ترتيب كتابته، يبقى ما بقي السطر
 * ويتغيّر أوّل ما يُعاد ترتيبه في مراجعة. فتصير كل البصمات القديمة خاطئة
 * بلا أن يمسّ أحدٌ عيّنةً واحدة.
 *
 * فالترتيب هنا **مفروض**: تُبنى السلسلة حرفًا حرفًا بترتيبٍ مكتوب.
 *
 * ── وما لا يُطبَّع ──
 *
 * نصُّ العيّنة. وهذا فرقٌ جوهريّ عن بصمة المرشّح: تلك تُطبِّع لتسأل «هل
 * هذا هو النصّ نفسه؟»، وهذه تسأل «ماذا سيقرأ المدرِّب بالضبط؟». وتطبيعُ ما
 * يُدرَّب عليه يعني تعليمَ النموذج نصًّا لم يكتبه أحد.
 */

/** نسخة الصيغة — تُرفع إن تغيّر شكل العيّنة، فلا تُقارن بصمتان لشكلين */
export const DATASET_FORMAT_VERSION = "ysd-chat-v1";

export interface DatasetSample {
  userText: string;
  assistantText: string;
}

/**
 * ★ يُسلسِل عيّنةً — بمفاتيح مرتّبةٍ فرضًا لا عَرَضًا.
 *
 * الشكل:
 *   {"messages":[{"role":"user","content":…},{"role":"assistant","content":…}]}
 *
 * ولا موجّه نظام، ولا سياق استرجاع، ولا داخليّات أدوات، ولا وقت تشغيل:
 * العيّنة سؤالٌ وجوابه. وكلّ ما يُضاف إليها يُعلَّم للنموذج بوصفه جزءًا
 * من الجواب.
 */
export function serializeSample(sample: DatasetSample): string {
  /**
   * `JSON.stringify` على **سلسلةٍ واحدة** — لا على كائن.
   *
   * فهو هنا يؤدّي وظيفةً واحدة لا خيار فيها: تهريب المحارف بحسب JSON.
   * ولا رأي له في ترتيبٍ ولا في مفتاح.
   */
  const q = (s: string) => JSON.stringify(s);
  const user = `{"role":"user","content":${q(sample.userText)}}`;
  const assistant = `{"role":"assistant","content":${q(sample.assistantText)}}`;
  return `{"messages":[${user},${assistant}]}`;
}

/**
 * ★ بصمة العيّنة — على بايتات الصيغة، لا على النصّ.
 *
 * وتُحسب على السطر بلا فاصل السطر: الفاصل تفصيلُ الوعاء (JSONL) لا جزءٌ
 * من العيّنة. فلو أدخلناه، لَتغيّرت البصمة إن غيّرنا الوعاء يومًا.
 */
export function hashSample(sample: DatasetSample): string {
  return createHash("sha256").update(serializeSample(sample), "utf8").digest("hex");
}

/**
 * ★ بايتات الأثر — JSONL: سطرٌ لكل عيّنة، وفاصلٌ بعد كلّ سطرٍ بما فيه الأخير.
 *
 * والفاصل `\n` لا `\r\n`: هذا نصٌّ يقرؤه مدرِّب لا مُحرِّرُ ويندوز. وتركُه
 * لبيئة البناء يجعل الأثر يختلف بايتًا بين آلتين لا بين مجموعتين.
 *
 * والترميز UTF-8 بلا BOM: علامةُ الترتيب بايتاتٌ في أوّل الملفّ تصير جزءًا
 * من السطر الأول عند القراءة السطريّة.
 *
 * ★ ولا يُستدعى هذا في المرحلة 3A على بيانات حقيقية.
 *
 * لأن كتابة النصّ إلى ملفٍّ تحتاج مكانًا آمنًا يُكتب فيه — ولا يوجد بعد
 * دلوٌ خاصٌّ بأثر التدريب. فالدالّة تُبنى وتُختبر على أمثلةٍ اصطناعية،
 * والتخزين الدائم شرطُ المرحلة 3B.
 */
export function buildArtifactBytes(samples: readonly DatasetSample[]): Buffer {
  const lines = samples.map((s) => `${serializeSample(s)}\n`);
  return Buffer.from(lines.join(""), "utf8");
}

export interface ManifestItem {
  order: number;
  candidateId: string;
  sampleHash: string;
}

export interface DatasetManifest {
  formatVersion: string;
  sampleCount: number;
  items: ManifestItem[];
}

/**
 * ★ بصمة البيان — على الترتيب والهوّيات والبصمات، ولا شيء غيرها.
 *
 * ── وما استُبعد عمدًا ──
 *
 * **الطوابع الزمنية**: بناءان لنفس العيّنات في وقتين يجب أن يتّفقا. وطابعٌ
 * في المادّة يجعل كل بناءٍ فريدًا، فتضيع القدرة على قول «هاتان المجموعتان
 * واحدة».
 *
 * **ورقم الإصدار**: لأن السؤال الذي تجيبه البصمة هو «ما محتوى هذه
 * المجموعة؟» لا «ما اسمها؟». ومجموعتان بمحتوًى واحد وبرقمين مختلفين
 * تتساوى بصمتاهما — وذلك مفيد: يكشف أن إصدارًا جديدًا لم يُضف شيئًا.
 *
 * ── والترتيب جزءٌ من الهوّية ──
 *
 * فترتيبٌ مختلف ⇒ بصمةٌ مختلفة. وهذا عقدٌ مقصود لا سهو: ترتيبُ العيّنات
 * يؤثّر في التدريب، ومجموعةٌ رُتّبت غير ترتيبها ليست هي. وليس ثمّة خطرُ
 * اختلافٍ عَرَضيّ: الترتيب مشتقٌّ حتميًّا من `(created_at, id)`.
 */
export function hashManifest(manifest: DatasetManifest): string {
  const head = `${manifest.formatVersion}\n${manifest.sampleCount}\n`;
  const body = manifest.items
    .map((it) => `${it.order}\t${it.candidateId}\t${it.sampleHash}`)
    .join("\n");
  return createHash("sha256").update(`${head}${body}`, "utf8").digest("hex");
}

/**
 * ★ يبني البيان من عيّنات مرتّبة — حتميًّا.
 *
 * والمُدخَل مرتَّبٌ سلفًا: الترتيب قرارُ طبقة البناء (`created_at` ثم `id`)،
 * ولا تُعيد هذه الوحدة ترتيب شيء. فوظيفتها الصياغة لا الاختيار.
 */
export function buildDatasetManifest(
  entries: readonly { candidateId: string; sample: DatasetSample }[],
  formatVersion: string = DATASET_FORMAT_VERSION,
): { manifest: DatasetManifest; manifestHash: string } {
  const items: ManifestItem[] = entries.map((e, index) => ({
    order: index,
    candidateId: e.candidateId,
    sampleHash: hashSample(e.sample),
  }));
  const manifest: DatasetManifest = {
    formatVersion,
    sampleCount: items.length,
    items,
  };
  return { manifest, manifestHash: hashManifest(manifest) };
}
