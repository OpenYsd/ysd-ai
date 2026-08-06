import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  citationFromEvent,
  citationFromRow,
  citationKey,
  evidenceSummaryFromMetadata,
  groupCitationsByMessage,
  mergeCitations,
  sortCitations,
  type CitationEvent,
  type ClientCitation,
  type EvidenceRow,
} from "@/lib/evidence/client-citation";

/**
 * توحيد عقد الاستشهاد (v0.9.0، الإيداع السابع).
 *
 * السؤال المركزي: هل ينتج الطريقان — البثّ الحيّ وإعادة التحميل — **نفس
 * الكائن**؟ اختلافٌ في حقل واحد يعني أن المرجع يظهر بشكل بعد الإرسال وبشكل
 * آخر بعد التحديث، وهو عطبٌ يراه المستخدم ولا يكشفه اختبار وحدة لأي طرف وحده.
 */

const row = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  source_id: "src-1",
  message_id: "msg-1",
  segment_index: 0,
  marker: 1,
  chunk_id: "chunk-1",
  file_id: "file-1",
  chunk_index: 3,
  file_name: "تقرير.pdf",
  page_number: 7,
  quote: "اقتباس حرفي من المصدر",
  quote_start: 10,
  quote_end: 31,
  verification: "exact",
  source_available: true,
  ...over,
});

const event = (over: Partial<CitationEvent> = {}): CitationEvent => ({
  type: "citation",
  segmentIndex: 0,
  marker: 1,
  chunkId: "chunk-1",
  fileId: "file-1",
  chunkIndex: 3,
  fileName: "تقرير.pdf",
  pageNumber: 7,
  quote: "اقتباس حرفي من المصدر",
  quoteStart: 10,
  quoteEnd: 31,
  verification: "exact",
  sourceAvailable: true,
  ...over,
});

describe("(٣١) الطريقان ينتجان الكائن نفسه", () => {
  it("كل الحقول متطابقة عدا sourceId", () => {
    const fromReload = citationFromRow(row());
    const fromLive = citationFromEvent(event());

    expect(Object.keys(fromLive).sort()).toEqual(Object.keys(fromReload).sort());
    expect({ ...fromLive, sourceId: "src-1" }).toEqual(fromReload);
  });

  /**
   * `sourceId` يُعرف بعد الحفظ وحده — الصفّ يُنشأ داخل الدالة ولا تُعيد
   * معرّفاته. ولا أثر لذلك: مفتاح التمييز لا يستعمله.
   */
  it("sourceId غائب في البثّ الحيّ وحاضر بعد التحميل", () => {
    expect(citationFromEvent(event()).sourceId).toBeNull();
    expect(citationFromRow(row()).sourceId).toBe("src-1");
  });

  it("verification تُضبط على القيمتين المعروفتين وحدهما", () => {
    expect(citationFromRow(row({ verification: "normalized" })).verification).toBe("normalized");
    expect(citationFromRow(row({ verification: "شيء آخر" })).verification).toBe("exact");
    expect(citationFromEvent(event({ verification: "unverified" })).verification).toBe("exact");
  });
});

describe("(٣٢) الترتيب ثابت", () => {
  it("الفقرة ثم الرقم", () => {
    const list = [
      citationFromRow(row({ segment_index: 1, marker: 2 })),
      citationFromRow(row({ segment_index: 0, marker: 7 })),
      citationFromRow(row({ segment_index: 1, marker: 1 })),
      citationFromRow(row({ segment_index: 0, marker: 2 })),
    ];
    expect(sortCitations(list).map((c) => `${c.segmentIndex}:${c.marker}`)).toEqual([
      "0:2", "0:7", "1:1", "1:2",
    ]);
  });

  it("الترتيب رقميّ لا نصّي", () => {
    const list = [
      citationFromRow(row({ segment_index: 0, marker: 10 })),
      citationFromRow(row({ segment_index: 0, marker: 2 })),
    ];
    // ترتيب نصّي كان سيضع "10" قبل "2"
    expect(sortCitations(list).map((c) => c.marker)).toEqual([2, 10]);
  });

  it("الترتيب لا يعدّل المصفوفة الأصلية", () => {
    const list = [
      citationFromRow(row({ marker: 5 })),
      citationFromRow(row({ marker: 1 })),
    ];
    const before = list.map((c) => c.marker);
    sortCitations(list);
    expect(list.map((c) => c.marker)).toEqual(before);
  });
});

describe("(٣٣) لا تكرار", () => {
  it("SSE ثم إعادة تحميل ⇒ استشهاد واحد", () => {
    const live = [citationFromEvent(event())];
    const reloaded = [citationFromRow(row())];

    const merged = mergeCitations(live, reloaded);
    expect(merged).toHaveLength(1);
    // الأحدث يفوز: نسخة القاعدة أصدق
    expect(merged[0]!.sourceId).toBe("src-1");
  });

  it("إعادة الجلب مرارًا لا تُراكم", () => {
    let acc: ClientCitation[] = [];
    for (let i = 0; i < 5; i++) acc = mergeCitations(acc, [citationFromRow(row())]);
    expect(acc).toHaveLength(1);
  });

  /**
   * المفتاح `(الفقرة، الرقم)` لا `sourceId`: الأخير غائب حيًّا، فالتمييز به
   * كان سيُبقي النسختين معًا — استشهادين لمرجع واحد.
   */
  it("المفتاح لا يعتمد على sourceId", () => {
    expect(citationKey(citationFromEvent(event()))).toBe(citationKey(citationFromRow(row())));
  });

  it("مراجع مختلفة تبقى مختلفة", () => {
    const merged = mergeCitations(
      [citationFromRow(row({ marker: 1 }))],
      [citationFromRow(row({ marker: 2 })), citationFromRow(row({ segment_index: 1, marker: 1 }))],
    );
    expect(merged.map((c) => `${c.segmentIndex}:${c.marker}`)).toEqual(["0:1", "0:2", "1:1"]);
  });

  it("الدمج يُعيد الترتيب المعتمد", () => {
    const merged = mergeCitations(
      [citationFromRow(row({ segment_index: 2, marker: 1 }))],
      [citationFromRow(row({ segment_index: 0, marker: 9 }))],
    );
    expect(merged.map((c) => c.segmentIndex)).toEqual([0, 2]);
  });
});

describe("(٣٤) المصادر المحذوفة", () => {
  it("chunkId وfileId فارغان مدعومان — والاقتباس يبقى", () => {
    const c = citationFromRow(
      row({ chunk_id: null, file_id: null, source_available: false, file_name: "لقطة.pdf" }),
    );
    expect(c.chunkId).toBeNull();
    expect(c.fileId).toBeNull();
    expect(c.sourceAvailable).toBe(false);
    // اللقطة تحلّ محلّ الحيّ، والاقتباس التاريخي لم يُمَسّ
    expect(c.fileName).toBe("لقطة.pdf");
    expect(c.quote).toBe("اقتباس حرفي من المصدر");
  });

  it("النصّ الفارغ يُعامل معاملة الغياب", () => {
    expect(citationFromRow(row({ chunk_id: "" })).chunkId).toBeNull();
    expect(citationFromEvent(event({ fileId: "" })).fileId).toBeNull();
  });

  it("pageNumber فارغة مدعومة", () => {
    expect(citationFromRow(row({ page_number: null })).pageNumber).toBeNull();
  });

  it("sourceAvailable لا تصير true إلا بالقيمة true", () => {
    for (const v of [undefined, null, 0, "", "true", 1]) {
      expect(citationFromRow(row({ source_available: v as never })).sourceAvailable).toBe(false);
    }
  });
});

describe("(٣٥) ★ relevance لا مكان لها في النوع", () => {
  it("غائبة عن مخرَج الطريقين", () => {
    expect(citationFromRow(row())).not.toHaveProperty("relevance");
    expect(citationFromEvent(event())).not.toHaveProperty("relevance");
  });

  /** حقلٌ مدسوس في الصفّ لا يُنسخ: المُحوِّل يبني كائنًا صريحًا لا ينشر المدخل */
  it("relevance مدسوسة في المدخل لا تعبر", () => {
    const sneaky = { ...row(), relevance: 0.87 } as EvidenceRow;
    const c = citationFromRow(sneaky);
    expect(c).not.toHaveProperty("relevance");
    expect(JSON.stringify(c)).not.toContain("0.87");
  });

  /**
   * ★ حارس الأنواع: `relevance` غير مُعلَنة في `ClientCitation`، فإسنادها
   * خطأ ترجمة لا سهو مراجعة. والحارس النصّي يمنع إعادتها.
   */
  it("النوع لا يُعلن relevance ولا الوحدة تذكرها", () => {
    const src = readFileSync(
      join(process.cwd(), "lib", "evidence", "client-citation.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
    expect(code).not.toMatch(/relevance/i);
  });

  it("ولا تظهر في توقيع الدالة المجمّعة", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "0033_message_evidence_read_rpcs.sql"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const fn = sql.slice(sql.indexOf("function public.get_conversation_evidence"));
    const signature = fn.slice(0, fn.indexOf("as $$"));
    expect(signature).not.toMatch(/relevance/);
  });
});

describe("ملخّص الأدلة من metadata", () => {
  it("(١٣) الرسائل القديمة ⇒ null", () => {
    expect(evidenceSummaryFromMetadata(null)).toBeNull();
    expect(evidenceSummaryFromMetadata({})).toBeNull();
    expect(evidenceSummaryFromMetadata({ sources: [] })).toBeNull();
    expect(evidenceSummaryFromMetadata({ evidence: null })).toBeNull();
    expect(evidenceSummaryFromMetadata({ evidence: "نص" })).toBeNull();
    expect(evidenceSummaryFromMetadata({ evidence: [] })).toBeNull();
  });

  it("(١٤) الرسائل المدعومة ⇒ العقد النهائي", () => {
    const summary = evidenceSummaryFromMetadata({
      model_id: "x",
      evidence: {
        supported: true,
        supportedSegments: 2,
        unsupportedSegments: [2, 3],
        sourcesCount: 2,
        version: 1,
      },
    });
    expect(summary).toEqual({
      supported: true,
      supportedSegments: 2,
      unsupportedSegments: [2, 3],
      sourcesCount: 2,
      version: 1,
    });
  });

  it("القيم المشوّهة تُطبَّع بلا رمي", () => {
    const summary = evidenceSummaryFromMetadata({
      evidence: {
        supported: "yes",
        supportedSegments: "2",
        unsupportedSegments: [1, "x", null, 2.7],
        sourcesCount: null,
      },
    });
    expect(summary).toEqual({
      supported: false,
      supportedSegments: 0,
      unsupportedSegments: [1, 2],
      sourcesCount: 0,
      version: 1,
    });
  });
});

describe("تجميع الصفوف بالرسالة", () => {
  it("يفصل الرسائل ويرتّب داخل كلٍّ منها", () => {
    const grouped = groupCitationsByMessage([
      row({ message_id: "m2", segment_index: 1, marker: 1 }),
      row({ message_id: "m1", segment_index: 0, marker: 3 }),
      row({ message_id: "m2", segment_index: 0, marker: 9 }),
      row({ message_id: "m1", segment_index: 0, marker: 1 }),
    ]);

    expect([...grouped.keys()].sort()).toEqual(["m1", "m2"]);
    expect(grouped.get("m1")!.map((c) => c.marker)).toEqual([1, 3]);
    expect(grouped.get("m2")!.map((c) => `${c.segmentIndex}:${c.marker}`)).toEqual(["0:9", "1:1"]);
  });

  it("رسالة بلا معرّف تُهمل ولا تُسقط الباقي", () => {
    const grouped = groupCitationsByMessage([
      row({ message_id: "" }),
      row({ message_id: "m1" }),
    ]);
    expect([...grouped.keys()]).toEqual(["m1"]);
  });

  it("مصفوفة فارغة ⇒ خريطة فارغة", () => {
    expect(groupCitationsByMessage([]).size).toBe(0);
  });
});
