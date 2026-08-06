import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * حرّاس نصّيون على ترحيلَي الاستشهاد 0032/0033.
 *
 * السلوك الحقيقي يُختبر على PostgreSQL حقيقي (`npm run test:pg:evidence`، 45
 * فحصًا). ما هنا **مكمِّل لا بديل**: يمنع أن يُعاد إدخال نمطٍ خطر في مراجعة
 * لاحقة دون أن يلاحظه أحد — تحديدًا الأنماط التي تمرّ على قاعدةٍ فارغة بلا
 * خطأ وتنكشف متأخّرة.
 */

const MIG = join(process.cwd(), "supabase", "migrations");
const read = (f: string) => readFileSync(join(MIG, f), "utf8");

/**
 * تجريد التعليقات — **بعد توحيد نهايات الأسطر**.
 *
 * `.` في JS لا تطابق `\r`، فعلى ملفٍ بنهايات CRLF لا يطابق `/--.*$/` شيئًا
 * أبدًا، وتصير كل `not.toContain` حارسةً على نصّ غير موجود. (الخلل نفسه
 * صُحّح في خمسة ملفات اختبار في v0.8.1.)
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

const tables = read("0032_message_evidence_tables.sql");
const rpcs = read("0033_message_evidence_read_rpcs.sql");
const writeRpc = read("0034_write_message_evidence_rpc.sql");
const tablesCode = stripComments(tables);
const rpcsCode = stripComments(rpcs);
const writeCode = stripComments(writeRpc);

describe("0032 — جدولا الاستشهاد", () => {
  it("يعلن الجدولين معًا", () => {
    expect(tablesCode).toMatch(/create table if not exists public\.message_sources/i);
    expect(tablesCode).toMatch(/create table if not exists public\.message_citation_segments/i);
  });

  it("marker فريد داخل الرسالة", () => {
    expect(tablesCode).toMatch(/unique\s*\(\s*message_id\s*,\s*marker\s*\)/i);
  });

  it("لا يتكرر المصدر في الفقرة نفسها", () => {
    expect(tablesCode).toMatch(/unique\s*\(\s*message_source_id\s*,\s*segment_index\s*\)/i);
  });

  /**
   * الشرط الجزئي هو جوهر القرار: `unique(message_id, chunk_id, quote)` وحده
   * لا يمنع التكرار عند `chunk_id is null`، وبديلاه الشائعان (UUID صفري أو
   * `coalesce` داخل القيد) يغيّران معنى NULL فيمنعان صفّين مشروعين.
   */
  it("فهرس فريد **جزئي** على (message_id, chunk_id, quote)", () => {
    expect(tablesCode).toMatch(
      /create unique index[\s\S]*?message_sources[\s\S]*?\(\s*message_id\s*,\s*chunk_id\s*,\s*quote\s*\)[\s\S]*?where\s+chunk_id\s+is\s+not\s+null/i,
    );
  });

  it("لا UUID صفري ولا coalesce داخل قيد أو فهرس", () => {
    expect(tablesCode).not.toMatch(/00000000-0000-0000-0000-000000000000/);
    // coalesce/nullif داخل قيد أو فهرس يحوّلان NULL إلى قيمة تُقارَن
    expect(tablesCode).not.toMatch(/(?:check|unique|on\s+public\.\w+)\s*\([^)]*coalesce/i);
    expect(tablesCode).not.toMatch(/(?:check|unique|on\s+public\.\w+)\s*\([^)]*nullif/i);
  });

  it("حذف الرسالة يتتالى · وحذف الملف والمقطع يُفرّغ المؤشّر فقط", () => {
    expect(tablesCode).toMatch(
      /message_id[\s\S]{0,80}references public\.messages\(id\) on delete cascade/i,
    );
    expect(tablesCode).toMatch(
      /chunk_id[\s\S]{0,80}references public\.file_chunks\(id\) on delete set null/i,
    );
    expect(tablesCode).toMatch(
      /file_id[\s\S]{0,80}references public\.files\(id\)\s*on delete set null/i,
    );
    expect(tablesCode).toMatch(
      /message_source_id[\s\S]{0,120}references public\.message_sources\(id\) on delete cascade/i,
    );
  });

  it("اللقطات مطلوبة كي لا يضيع التاريخ", () => {
    expect(tablesCode).toMatch(/chunk_index_snapshot\s+integer\s+not null/i);
    expect(tablesCode).toMatch(/file_name_snapshot\s+text\s+not null/i);
  });

  it("حدّ الاقتباس 240 ومداه غير فارغ", () => {
    expect(tablesCode).toMatch(/char_length\(quote\)\s+between\s+1\s+and\s+240/i);
    expect(tablesCode).toMatch(/quote_end\s*>\s*quote_start/i);
  });

  it("relevance محصورة في [0,1] · وmarker في [1,99]", () => {
    expect(tablesCode).toMatch(/relevance\s*>=\s*0\s+and\s+relevance\s*<=\s*1/i);
    expect(tablesCode).toMatch(/marker\s+between\s+1\s+and\s+99/i);
  });

  /** 'unverified' غير موجودة عمدًا: ما لا نثق به لا يُحفظ أصلًا */
  it("verification تقبل exact وnormalized فقط", () => {
    expect(tablesCode).toMatch(/verification in \('exact',\s*'normalized'\)/i);
    expect(tablesCode).not.toMatch(/'unverified'/);
  });

  it("RLS مفعّل ومفروض · وبلا سياسة واحدة", () => {
    for (const t of ["message_sources", "message_citation_segments"]) {
      expect(tablesCode).toMatch(
        new RegExp(`alter table public\\.${t} enable row level security`, "i"),
      );
      expect(tablesCode).toMatch(
        new RegExp(`alter table public\\.${t} force row level security`, "i"),
      );
    }
    expect(tablesCode).not.toMatch(/create policy/i);
  });

  it("لا وصول مباشر لأي دور عميل", () => {
    for (const t of ["message_sources", "message_citation_segments"]) {
      for (const role of ["public", "anon", "authenticated"]) {
        expect(tablesCode).toMatch(
          new RegExp(`revoke all on table public\\.${t} from ${role}`, "i"),
        );
      }
    }
    expect(tablesCode).not.toMatch(/grant\s+(select|insert|update|delete|all)[\s\S]{0,60}to\s+(anon|authenticated)/i);
  });

  it("إضافية بحتة: لا drop ولا alter على جدول قائم", () => {
    expect(tablesCode).not.toMatch(/drop (table|column|function|index)/i);
    // الـalter الوحيدان المسموحان هما RLS على الجدولين الجديدين
    const alters = tablesCode.match(/alter table[^\n;]*/gi) ?? [];
    for (const a of alters) {
      expect(a).toMatch(/message_sources|message_citation_segments/i);
      expect(a).toMatch(/row level security/i);
    }
  });
});

describe("0033 — دالتا القراءة", () => {
  it("تُعلن الدالتين", () => {
    expect(rpcsCode).toMatch(/create or replace function public\.get_message_evidence\(/i);
    expect(rpcsCode).toMatch(/create or replace function public\.get_owned_file_chunk\(/i);
  });

  it("كلتاهما SECURITY DEFINER بمسار بحث مغلق و STABLE", () => {
    const defs = rpcsCode.match(/security definer/gi) ?? [];
    const paths = rpcsCode.match(/set search_path\s*=\s*''/gi) ?? [];
    const stables = rpcsCode.match(/^\s*stable\s*$/gim) ?? [];
    expect(defs).toHaveLength(2);
    expect(paths).toHaveLength(2);
    expect(stables).toHaveLength(2);
  });

  /**
   * ★ النقطة الأمنية المركزية: `SECURITY DEFINER` **يتجاوز RLS بحكم تعريفه**،
   * فالجدولان المغلقان في 0032 لا يحميان شيئًا من داخل الدالة. لا بديل عن
   * فحص `auth.uid()` صراحةً في كل منهما.
   */
  it("كل دالة تفحص الملكية بنفسها عبر auth.uid()", () => {
    const bodies = rpcsCode.split(/create or replace function/i).slice(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatch(/auth\.uid\(\)/);
    }
  });

  /** `messages` بلا `user_id` — القفزة عبر `conversations` إلزامية لا اختيارية */
  it("ملكية الرسالة تُتتبَّع عبر conversations.user_id", () => {
    expect(rpcsCode).toMatch(/join public\.conversations c[\s\S]*?c\.user_id\s*=\s*\(select auth\.uid\(\)\)/i);
    expect(rpcsCode).not.toMatch(/m\.user_id/);
  });

  it("ملكية الملف تُفحص في كلتا الدالتين", () => {
    const checks = rpcsCode.match(/f\.user_id\s*=\s*\(select auth\.uid\(\)\)/gi) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    const softDeletes = rpcsCode.match(/f\.deleted_at is null/gi) ?? [];
    expect(softDeletes.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * `original_name` أُضيف في 0005 **بلا not null**، فقد يكون فارغًا. من دون
   * `file_name` في السلسلة يظهر للمستخدم اسمٌ فارغ بدل اسم ملفه.
   */
  it("اسم الملف يتسلسل original_name ← file_name ← اللقطة", () => {
    expect(rpcsCode).toMatch(/coalesce\(f\.original_name,\s*f\.file_name,\s*ms\.file_name_snapshot\)/i);
    expect(rpcsCode).toMatch(/coalesce\(f\.original_name,\s*f\.file_name\)/i);
  });

  it("الحيّ يُفضَّل على اللقطة في الصفحة والترتيب", () => {
    expect(rpcsCode).toMatch(/coalesce\(fc\.chunk_index,\s*ms\.chunk_index_snapshot\)/i);
    expect(rpcsCode).toMatch(/coalesce\(fc\.page_number,\s*ms\.page_number_snapshot\)/i);
  });

  it("الترتيب segment_index ثم marker", () => {
    expect(rpcsCode).toMatch(/order by seg\.segment_index,\s*ms\.marker/i);
  });

  it("نافذة الجوار محدودة بـ0..2 وبترتيب المقطع", () => {
    expect(rpcsCode).toMatch(/p_neighbors between 0 and 2/i);
    expect(rpcsCode).toMatch(/fc\.chunk_index between/i);
    expect(rpcsCode).toMatch(/order by fc\.chunk_index/i);
  });

  /**
   * `coalesce` **تركيبٌ في المُحلِّل لا دالة في الفهرس**؛ تأهيلها بـ`pg_catalog.`
   * يجعل الدالة تُنشَأ بلا خطأ ثم تنهار عند **أول نداء حيّ**. (درس v0.8.1،
   * كشفه اختبار PostgreSQL الحقيقي وحده.)
   */
  it("لا تُؤهَّل تراكيب المُحلِّل بـpg_catalog", () => {
    for (const c of ["coalesce", "nullif", "least", "greatest", "extract"]) {
      expect(rpcsCode).not.toMatch(new RegExp(`pg_catalog\\.${c}\\s*\\(`, "i"));
    }
  });

  it("بلا SQL ديناميكي", () => {
    expect(rpcsCode).not.toMatch(/\bexecute\s+(format|'|")/i);
    expect(rpcsCode).not.toMatch(/\bquote_ident\b|\bquote_literal\b/i);
  });

  /** رسالة خطأ تفرّق بين «مدى خاطئ» و«ليس لك»؛ الصمت لا يفرّق */
  it("لا raise: من لا يملك يحصل على صفر صفوف بلا رسالة", () => {
    expect(rpcsCode).not.toMatch(/\braise\s+(exception|notice|warning)/i);
  });

  it("الصلاحيات: سحب من public وanon · منح لـauthenticated وservice_role", () => {
    const sigs = [
      "public\\.get_message_evidence\\(uuid\\)",
      "public\\.get_owned_file_chunk\\(uuid, uuid, integer\\)",
    ];
    for (const sig of sigs) {
      expect(rpcsCode).toMatch(new RegExp(`revoke all on function ${sig} from public`, "i"));
      expect(rpcsCode).toMatch(new RegExp(`revoke all on function ${sig} from anon`, "i"));
      expect(rpcsCode).toMatch(new RegExp(`grant execute on function ${sig} to authenticated`, "i"));
      expect(rpcsCode).toMatch(new RegExp(`grant execute on function ${sig} to service_role`, "i"));
    }
  });

  it("لا يمنح 0033 وصولًا مباشرًا إلى الجدولين", () => {
    expect(rpcsCode).not.toMatch(/grant[\s\S]{0,60}on table/i);
  });
});

describe("0034 — دالة الكتابة", () => {
  it("SECURITY DEFINER بمسار مغلق وبلا SQL ديناميكي", () => {
    expect(writeCode).toMatch(/create or replace function public\.replace_message_evidence\(/i);
    expect(writeCode).toMatch(/security definer/i);
    expect(writeCode).toMatch(/set search_path\s*=\s*''/i);
    expect(writeCode).not.toMatch(/\bexecute\s+(format|'|")/i);
    expect(writeCode).not.toMatch(/\bquote_ident\b|\bquote_literal\b/i);
  });

  /**
   * الدالة تكتب باسم مستخدم يُمرَّر معرّفه وسيطًا. فمنحها لـ`authenticated`
   * يجعل `p_user_id` حقلًا يتحكّم به العميل — أي انتحالًا بمكالمة واحدة.
   */
  it("service_role وحده — والسحب من الثلاثة صريح", () => {
    const sig = "public\\.replace_message_evidence\\(uuid, uuid, jsonb, jsonb, jsonb\\)";
    for (const role of ["public", "anon", "authenticated"]) {
      expect(writeCode).toMatch(new RegExp(`revoke all on function ${sig} from ${role}`, "i"));
    }
    expect(writeCode).toMatch(new RegExp(`grant execute on function ${sig} to service_role`, "i"));
    expect(writeCode).not.toMatch(new RegExp(`grant execute on function ${sig} to (anon|authenticated)`, "i"));
  });

  it("يقفل صفّ الرسالة ويتتبّع الملكية عبر conversations", () => {
    expect(writeCode).toMatch(/for update of m/i);
    expect(writeCode).toMatch(/join public\.conversations c on c\.id = m\.conversation_id/i);
    expect(writeCode).toMatch(/v_owner <> p_user_id/i);
    expect(writeCode).not.toMatch(/m\.user_id/);
  });

  /** المخطط الفعلي: النوع enum من 0001، والعمود `metadata` من 0007 */
  it("يقارن الدور بالنوع الفعلي ويكتب في العمود الفعلي", () => {
    expect(writeCode).toMatch(/'assistant'::public\.message_role/i);
    expect(writeCode).toMatch(/update public\.messages\s+set metadata/i);
    expect(writeCode).not.toMatch(/set\s+meta\s*=/i);
  });

  it("metadata تُدمج ولا تُستبدل", () => {
    expect(writeCode).toMatch(/metadata\s*=\s*coalesce\(metadata,\s*'\{\}'::jsonb\)\s*\|\|/i);
  });

  /**
   * ★ اللقطات تُشتقّ ولا تُقرأ من الحمولة. لو قُبل `file_name_snapshot` من
   * التطبيق لأمكن حفظ اقتباس منسوب إلى ملفٍ لا يحويه، ويبقى في التاريخ بعد
   * حذف الملف بلا ما يكشفه.
   */
  it("لا يقرأ لقطة ولا معرّف ملف من الحمولة", () => {
    for (const field of [
      "file_id", "file_name_snapshot", "page_number_snapshot", "chunk_index_snapshot",
    ]) {
      expect(writeCode).not.toMatch(new RegExp(`->>\\s*'${field}'`, "i"));
    }
    // وتُشتقّ من المقطع وملفه
    expect(writeCode).toMatch(/join public\.file_chunks fc on fc\.id = \(s ->> 'chunk_id'\)::uuid/i);
    expect(writeCode).toMatch(/join public\.files f on f\.id = fc\.file_id/i);
    expect(writeCode).toMatch(/f\.user_id = p_user_id/i);
    expect(writeCode).toMatch(/coalesce\(f\.original_name,\s*f\.file_name\)/i);
  });

  it("الحذف والإدراج داخل كتلة واحدة لها exception", () => {
    const guarded = /begin[\s\S]*?delete from public\.message_sources[\s\S]*?insert into public\.message_sources[\s\S]*?exception/i;
    expect(writeCode).toMatch(guarded);
  });

  it("يلتقط 23505 و23514 و23503 ويعيد رمزًا عامًا", () => {
    expect(writeCode).toMatch(/unique_violation/i);
    expect(writeCode).toMatch(/check_violation/i);
    expect(writeCode).toMatch(/foreign_key_violation/i);
    expect(writeCode).toMatch(/evidence_validation_failed/);
    expect(writeCode).toMatch(/when others then[\s\S]{0,120}evidence_write_failed/i);
  });

  /**
   * PostgreSQL يضع الصفّ المخالف — ومعه الاقتباس — في `DETAIL`. إخراجه يحوّل
   * كل مخالفة قيد إلى تسريب لمحتوى ملف المستخدم.
   */
  it("لا يُخرج SQLERRM ولا DETAIL ولا HINT ولا الصفّ", () => {
    expect(writeCode).not.toMatch(/\bSQLERRM\b/i);
    expect(writeCode).not.toMatch(/PG_EXCEPTION_DETAIL/i);
    expect(writeCode).not.toMatch(/PG_EXCEPTION_HINT/i);
    expect(writeCode).not.toMatch(/returned_sqlstate/i);
    expect(writeCode).not.toMatch(/\braise\s+(notice|warning|log|info)/i);
  });

  it("لا يفرّق بين «غير موجودة» و«ليست لك» و«ليست ردَّ مساعد»", () => {
    const codes = writeCode.match(/evidence_not_writable/g) ?? [];
    expect(codes).toHaveLength(1); // مسار خروج واحد للحالات الثلاث
  });

  it("يفرض سقف المصادر وحدود القيم داخل القاعدة", () => {
    expect(writeCode).toMatch(/c_max_sources constant integer := 4/i);
    expect(writeCode).toMatch(/not between 1 and 99/i);
    expect(writeCode).toMatch(/char_length\(s ->> 'quote'\) not between 1 and 240/i);
    expect(writeCode).toMatch(/'relevance'\)::numeric not between 0 and 1/i);
    expect(writeCode).toMatch(/'verification'\) not in \('exact', 'normalized'\)/i);
  });

  it("إضافي بحت: لا drop ولا alter table", () => {
    expect(writeCode).not.toMatch(/drop (table|column|function|index|type)/i);
    expect(writeCode).not.toMatch(/alter table/i);
  });
});

describe("0034 — تشديدات الحمولة", () => {
  it("p_summary يجب أن يكون كائنًا", () => {
    // `->` على غير الكائن يُعيد null صامتًا، فتمرّ حمولة مشوّهة كملخّص فارغ
    expect(writeCode).toMatch(
      /jsonb_typeof\(p_summary\)\s+is distinct from\s+'object'/i,
    );
  });

  it("سقوف بنيوية على العدد لا على القيم وحدها", () => {
    expect(writeCode).toMatch(/c_max_segment_links constant integer := 256/i);
    expect(writeCode).toMatch(/c_max_unsupported\s+constant integer := 256/i);
    expect(writeCode).toMatch(/c_max_segment_index constant integer := 4095/i);
    // ومفروضة فعلًا لا معلَنة فقط
    expect(writeCode).toMatch(/v_segment_links > c_max_segment_links/i);
    expect(writeCode).toMatch(/v_count > c_max_unsupported/i);
    expect(writeCode).toMatch(/not between 0 and c_max_segment_index/i);
  });

  /**
   * `'NaN'` قيمة **مشروعة** في numeric وتمرّ من كل مقارنة مدى بلا اعتراض.
   * الحارس النصّي دفاعٌ في العمق خلف فحص النوع.
   */
  it("أرقام JSON غير الصالحة مرفوضة صراحةً", () => {
    const guards = writeCode.match(/in \('NaN', 'Infinity', '-Infinity'\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(6);
    for (const field of ["marker", "quote_start", "quote_end", "relevance"]) {
      expect(writeCode).toMatch(
        new RegExp(`\\(s ->> '${field}'\\)\\s+in \\('NaN'`, "i"),
      );
    }
  });

  it("الإزاحات أعداد صحيحة لا كسور", () => {
    for (const field of ["quote_start", "quote_end"]) {
      expect(writeCode).toMatch(
        new RegExp(`\\(s ->> '${field}'\\)::numeric <> trunc`, "i"),
      );
    }
    expect(writeCode).toMatch(/\(g ->> 'segment_index'\)::numeric <> trunc/i);
    expect(writeCode).toMatch(/\(u #>> '\{\}'\)::numeric <> trunc/i);
  });

  it("لا تكرار داخل unsupportedSegments", () => {
    expect(writeCode).toMatch(
      /select u #>> '\{\}' as v[\s\S]{0,160}group by 1 having count\(\*\) > 1/i,
    );
  });

  /**
   * ★ التناقض الذي لا تستطيع القاعدة حلّه: أحد الطرفين خاطئ ولا سبيل لمعرفة
   * أيّهما، وقبولُه يُنتج فقرةً تحمل استشهادًا ووسم «غير مدعومة» معًا.
   */
  it("فقرة مدعومة لا تكون في unsupportedSegments", () => {
    expect(writeCode).toMatch(
      /from jsonb_array_elements\(v_unsupported\) as u[\s\S]{0,200}g ->> 'segment_index' = \(u #>> '\{\}'\)/i,
    );
  });

  it("حقل نصّي ضخم مرفوض", () => {
    expect(writeCode).toMatch(/char_length\(s ->> 'chunk_id'\) > 64/i);
  });

  it("كل تشديد يعود بالرمز العام نفسه", () => {
    // لا رمز جديد يفرّق بين أسباب الرفض فيصير مِسبارًا
    const codes = new Set(writeCode.match(/'evidence_[a-z_]+'/g) ?? []);
    expect([...codes].sort()).toEqual([
      "'evidence_not_writable'",
      "'evidence_validation_failed'",
      "'evidence_write_failed'",
    ]);
  });
});

describe("الخصوصية: لا محتوى ملفات خارج الجدولين", () => {
  /**
   * الاقتباس ومحتوى المقطع واسم الملف بيانات مستخدم. أي مسار يضعها في
   * `observability_events` أو في سجل يحوّل السجلات نفسها إلى نسخة من ملفاته.
   */
  it("لا تذكر الترحيلات observability ولا log", () => {
    for (const sql of [tablesCode, rpcsCode, writeCode]) {
      expect(sql).not.toMatch(/observability_events/i);
      expect(sql).not.toMatch(/\braise\s+log\b/i);
    }
  });

  it("0032 و0033 لا يكتبان صفًّا واحدًا", () => {
    for (const sql of [tablesCode, rpcsCode]) {
      expect(sql).not.toMatch(/\binsert\s+into\b/i);
      expect(sql).not.toMatch(/\bupdate\s+public\./i);
      expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    }
  });

  /** 0034 يكتب بحكم غرضه — لكن في جدولَي الأدلة و`messages.metadata` وحدها */
  it("0034 لا يكتب في جدول خارج نطاق الأدلة", () => {
    const writes = writeCode.match(/(?:insert into|delete from|update)\s+public\.\w+/gi) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).toMatch(/message_sources|message_citation_segments|messages/i);
    }
  });
});
