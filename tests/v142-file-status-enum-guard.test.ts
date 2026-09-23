import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PENDING_STATUSES } from "@/lib/rag/retrieval";

/**
 * v142 — حارسُ قيم `file_status`: لا قيمةَ في الكود ليست في النوع.
 *
 * ══════════════════════════════════════════════════════════════════
 *  ★ العطلُ الذي وُلد منه — مقيسٌ على staging، لا مفترَض:
 *
 *  `PENDING_STATUSES` حوت "extracting"، وليست في النوع `file_status`.
 *  وPostgREST يحوّل كلَّ قيمةٍ في `in.(...)` إلى النوع، فردّ الاستعلامَ كلَّه
 *  بـ400 / 22P02 في **كلّ** نداءٍ لمسار المحادثة. و`{ data: null, error }` لا
 *  يرمي، فخرج نطاقُ الملفّات فارغًا دائمًا — «لا ملف» لكلّ مرفق. والاختباراتُ
 *  الوحدويّة لم ترَه (قاعدةٌ وهميّة تقبل أيّ نصّ)، ولا حزمةُ الضغط (قاست
 *  نطاقَ `/api/files` لا نطاقَ المحادثة).
 *
 *  فالنوعُ يُقرأ هنا من الترحيلات نفسِها — مصدرِ الحقيقة — لا من نسخةٍ ثانية.
 * ══════════════════════════════════════════════════════════════════
 */

const MIGRATIONS = "supabase/migrations";

function enumValues(typeName: string): Set<string> {
  const values = new Set<string>();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const create = new RegExp(`create type ${typeName} as enum\\s*\\(([^)]*)\\)`, "gi");
    for (const m of sql.matchAll(create)) for (const v of m[1]!.matchAll(/'([^']+)'/g)) values.add(v[1]!);
    const add = new RegExp(`alter type ${typeName} add value(?: if not exists)? '([^']+)'`, "gi");
    for (const m of sql.matchAll(add)) values.add(m[1]!);
  }
  return values;
}

const FILE_STATUS = enumValues("file_status");
const RAG_JOB_STATUS = enumValues("rag_job_status");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("★ قيمُ الحالة في الكود ⊂ النوع في القاعدة", () => {
  it("★ النوعُ مقروءٌ من الترحيلات فعلًا (لا حارسَ فارغ)", () => {
    expect([...FILE_STATUS]).toEqual(
      expect.arrayContaining(["uploaded", "processing", "ready", "chunking", "embedding", "ready_for_rag", "rag_failed", "failed"]),
    );
    expect(RAG_JOB_STATUS.size).toBeGreaterThanOrEqual(4);
  });

  it("★ ★ ★ PENDING_STATUSES و ready_for_rag قيمٌ في file_status — كلُّها", () => {
    const invalid = [...PENDING_STATUSES, "ready_for_rag"].filter((s) => !FILE_STATUS.has(s));
    expect(invalid).toEqual([]);
  });

  it("★ ★ ★ ولا قيمةَ غريبة في أيّ مرشّح `.in(\"status\", [...])` عبر الكود", () => {
    const known = new Set([...FILE_STATUS, ...RAG_JOB_STATUS]);
    // جداولُ أخرى بأنواع حالةٍ خاصّة بها — لا تخصّ مسارَ الملفات
    const otherDomains = /lib[\\/]training[\\/]/;
    const offenders: string[] = [];
    for (const f of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      if (otherDomains.test(f)) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.in\(\s*"status"\s*,\s*\[([^\]]*)\]/g)) {
        for (const v of m[1]!.matchAll(/"([^"]+)"/g)) if (!known.has(v[1]!)) offenders.push(`${f}: ${v[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("★ ★ ★ وما يكتبه مسارُ الملفات في files.status قيمٌ في النوع", () => {
    const writers = ["lib/files/service.ts", "app/api/files/upload/route.ts"];
    const offenders: string[] = [];
    for (const f of writers) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/status:\s*"([^"]+)"/g)) if (!FILE_STATUS.has(m[1]!)) offenders.push(`${f}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
