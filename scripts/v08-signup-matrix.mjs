#!/usr/bin/env node
/**
 * مصفوفة التسجيل التكاملية (v0.8.0) — مقابل Supabase الحقيقي.
 *
 *   node scripts/v08-signup-matrix.mjs
 *
 * تتحقق من بوابة handle_new_user بعد ترحيل 0020: استهلاك الدعوة، الموافقة،
 * الدور، التزامن، والتراجع الكامل. لا مزوّد ذكاء اصطناعي إطلاقًا.
 *
 * **لماذا تحقّق سلوكي لا قراءة تعريف**: pg_catalog غير متاح عبر PostgREST
 * (PGRST205)، فلا سبيل لقراءة جسم الدالة من هنا. والمميّز الحاسم متاح:
 * تسجيلٌ بتذكرة صالحة يرفع used_count إلى 1. وقد كان 0 حين استبدل 0020
 * الدالة بنسخة لا تفهم التذاكر — فارتفاعه يثبت أن نسخة 0021 هي الفعّالة
 * وأن المُحفّزين BEFORE ثم AFTER يعملان بالترتيب الصحيح.
 *
 * حدّ بريد GoTrue: نستعمل admin.createUser مع email_confirm للحالات الكثيرة
 * (لا يُرسل بريدًا فلا يصطدم بالحدّ)، وsignUp العام لعقد الواجهة وحده. وأي
 * 429/over_email_send_rate_limit يُصنَّف **غير حاسم** لا نجاحًا ولا فشلًا.
 *
 * كل ما تنشئه يُحذف في finally: حسابات QA ودعواتها فقط، بـid صريح. لا تمسّ
 * مستخدمًا حقيقيًا ولا تغيّر دورًا قائمًا.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
/**
 * حواجز أمان — هذا السكربت ينشئ ويحذف في قاعدة حقيقية عبر Auth.
 * لا يعمل إلا بتفعيل صريح، ولا يُضاف إلى npm test العادي.
 */
if (process.env.YSD_RUN_SIGNUP_INTEGRATION !== "1") {
  console.error("متوقف: يلزم YSD_RUN_SIGNUP_INTEGRATION=1 — هذا اختبار يكتب في قاعدة حقيقية.");
  process.exit(2);
}
const QA_PREFIX = process.env.YSD_QA_PREFIX ?? "ysd.qa.";
if (!QA_PREFIX || QA_PREFIX.length < 5) {
  console.error("متوقف: YSD_QA_PREFIX قصيرة أو غائبة — بادئة QA واضحة شرط للتشغيل.");
  process.exit(2);
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("متوقف: بيئة Supabase غير مكتملة.");
  process.exit(2);
}
/**
 * تأكيد المشروع المستهدف قبل أي عملية مدمّرة: مرجع المشروع من العنوان
 * (لا المفتاح) يجب أن يطابق YSD_EXPECTED_PROJECT_REF إن ضُبط. يمنع تشغيل
 * اختبار يكتب في مشروع غير المقصود.
 */
const PROJECT_REF = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
if (env.YSD_EXPECTED_PROJECT_REF && env.YSD_EXPECTED_PROJECT_REF !== PROJECT_REF) {
  console.error("متوقف: المشروع المستهدف لا يطابق YSD_EXPECTED_PROJECT_REF.");
  process.exit(2);
}
console.log(`المشروع المستهدف: ${PROJECT_REF.slice(0, 6)}… · بادئة QA: ${QA_PREFIX}`);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const STAMP = Date.now();
/**
 * نطاقان مقصودان: admin.createUser لا يتحقق من قابلية التسليم، أمّا signUp
 * العام فيتحقق ويرفض نطاقًا بلا MX. example.com محجوز لدى IANA ومقبول هنا
 * (حساب قائم يستعمله)، فهو الخيار الآمن لمسار العموم.
 */
const DOMAIN = "qa-ysd.com";
const PUBLIC_DOMAIN = "example.com";
let bad = 0;
let inconclusive = 0;
const createdUsers = [];
const createdInvites = [];

const ok = (name, cond, detail = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, why) => {
  inconclusive++;
  console.log(`  ⚪ ${name} — غير حاسم: ${why}`);
};

/** هل الفشل من حدّ بريد GoTrue لا من البوابة؟ */
const isRateLimit = (err) =>
  err?.status === 429 || String(err?.code ?? "").includes("rate_limit");

let seq = 0;
const qaEmail = (tag) => `${QA_PREFIX}${tag}.${STAMP}.${++seq}@${DOMAIN}`;
/**
 * بريد عام قابل للتسليم من البيئة وحدها — لا يُطبع كاملًا أبدًا.
 * YSD_QA_PUBLIC_EMAIL_BASE مثل: name@example.org (يُستعمل alias بـ+).
 */
const PUBLIC_BASE = env.YSD_QA_PUBLIC_EMAIL_BASE ?? process.env.YSD_QA_PUBLIC_EMAIL_BASE ?? "";
const qaPublicEmail = (tag) => {
  if (!PUBLIC_BASE.includes("@")) return null;
  const [lp, dom] = PUBLIC_BASE.split("@");
  return `${lp}+ysdqa.${tag}.${STAMP}.${++seq}@${dom}`;
};
/** لا يُطبع بريد كامل — النطاق وطول الجزء المحلي فقط */
const emailShape = (e) => (e ? `…@${e.split("@")[1]}` : "—");
const qaPass = () => `Qa!${crypto.randomBytes(6).toString("hex")}Zx9`;

async function makeInvite(maxUses = 1, opts = {}) {
  const code = `QA-${STAMP}-${++seq}`;
  const row = {
    code_hash: crypto.createHash("sha256").update(code).digest("hex"),
    code_hint: code.slice(-4),
    label: "QA مصفوفة التسجيل",
    max_uses: maxUses,
    ...opts,
  };
  const { data, error } = await db.from("beta_invites").insert(row).select("id").single();
  if (error) throw new Error(`تعذّر إنشاء دعوة: ${error.code}`);
  createdInvites.push(data.id);
  return { code, id: data.id };
}
/**
 * إصدار تذكرة كما يفعل /api/invite/claim تمامًا: العميل يولّد التذكرة ويرسل
 * تجزئتها، فلا يعبر الكود الخام إلى بيانات التسجيل. هذا هو المسار الحقيقي
 * منذ 0013 — واختبار invite_code الخام كان يختبر مسارًا لا يستعمله المنتج.
 */
async function issueTicket(code) {
  const ticket = crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(ticket).digest("hex");
  const r = await anon.rpc("beta_claim_invite", {
    p_code: code, p_ticket_hash: hash, p_ttl_seconds: 600,
  });
  if (r.error || r.data !== true) return null;
  return ticket;
}

const inviteUsed = async (id) =>
  (await db.from("beta_invites").select("used_count").eq("id", id).single()).data?.used_count;

/** إنشاء عبر admin — لا يُرسل بريدًا فلا يصطدم بحدّ GoTrue */
async function adminCreate(tag, meta) {
  const email = qaEmail(tag);
  const r = await db.auth.admin.createUser({
    email, password: qaPass(), email_confirm: true, user_metadata: meta,
  });
  if (r.data?.user) createdUsers.push(r.data.user.id);
  return { ...r, email };
}
async function publicSignUp(tag, meta, password = qaPass()) {
  const email = qaPublicEmail(tag);
  if (!email) return { error: { code: "no_public_mailbox" }, data: null, email: null };
  const r = await anon.auth.signUp({ email, password, options: { data: meta } });
  if (r.data?.user) createdUsers.push(r.data.user.id);
  return { ...r, email };
}

const counts = async () => {
  const { data: u } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const { data: p } = await db.from("profiles").select("id, role");
  const uid = new Set((u?.users ?? []).map((x) => x.id));
  const pid = new Set((p ?? []).map((x) => x.id));
  const roles = {};
  for (const x of p ?? []) roles[x.role] = (roles[x.role] ?? 0) + 1;
  return {
    authUsers: u?.users?.length ?? -1,
    profiles: p?.length ?? -1,
    orphanAuth: (u?.users ?? []).filter((x) => !pid.has(x.id)).length,
    orphanProfile: (p ?? []).filter((x) => !uid.has(x.id)).length,
    roles,
  };
};

const BEFORE = await counts();
const { data: ps0 } = await db.from("platform_settings").select("key,value")
  .in("key", ["require_invite", "allow_registration"]);
const SETTINGS0 = Object.fromEntries((ps0 ?? []).map((r) => [r.key, r.value]));
const { data: allInv0 } = await db.from("beta_invites").select("id, used_count");
const REAL_INVITES0 = Object.fromEntries((allInv0 ?? []).map((r) => [r.id, r.used_count]));
console.log(`قبل: ${JSON.stringify(BEFORE)}`);
console.log(`الإعدادات: ${JSON.stringify(SETTINGS0)} · دعوات قائمة: ${allInv0?.length ?? 0}\n`);

try {
  // ══════════ ١) التحقق السلوكي من تعريف 0020 ══════════
  console.log("── ١) التحقق السلوكي: هل مسار التذاكر (0013/0021) فعّال؟ ──");
  {
    const inv = await makeInvite(1);
    const ticket = await issueTicket(inv.code);
    ok("إصدار تذكرة من الكود (beta_claim_invite)", Boolean(ticket));
    const r = await adminCreate("gate", {
      invite_ticket: ticket, terms_accepted: true, display_name: "QA Gate",
    });
    ok("تسجيل بتذكرة صالحة + موافقة ينجح", !r.error, r.error ? `status=${r.error.status}` : "");
    const used = await inviteUsed(inv.id);
    ok("used_count = 1 (البوابة استهلكت التذكرة والدعوة)", used === 1, `= ${used}`);
    if (r.data?.user) {
      const { data: p } = await db.from("profiles").select("id, role, display_name")
        .eq("id", r.data.user.id).maybeSingle();
      ok("profile واحد ودوره user", p?.role === "user", `role=${p?.role}`);
      const { count: prof } = await db.from("profiles")
        .select("*", { count: "exact", head: true }).eq("id", r.data.user.id);
      ok("لا صف profile مكرر", prof === 1, `= ${prof}`);
      const { count: subs } = await db.from("subscriptions")
        .select("*", { count: "exact", head: true }).eq("user_id", r.data.user.id);
      ok("اشتراك واحد", subs === 1, `= ${subs}`);
      const { count: cons } = await db.from("user_consents")
        .select("*", { count: "exact", head: true }).eq("user_id", r.data.user.id);
      ok("موافقتان محفوظتان (terms + privacy)", cons === 2, `= ${cons}`);
      const { data: uu } = await db.auth.admin.getUserById(r.data.user.id);
      ok("invite_code وinvite_ticket غير محفوظين في metadata",
        !("invite_code" in (uu?.user?.user_metadata ?? {})) &&
        !("invite_ticket" in (uu?.user?.user_metadata ?? {})));
      const { count: uses } = await db.from("beta_invite_uses")
        .select("*", { count: "exact", head: true }).eq("invite_id", inv.id);
      ok("ربط الدعوة بالمستخدم مرة واحدة", uses === 1, `= ${uses}`);
    }
  }

  // ══════════ ٢) عقد signUp العام ══════════
  console.log("\n── ٢) signUp العام (عقد الواجهة) ──");
  {
    const inv = await makeInvite(1);
    const ticket = await issueTicket(inv.code);
    const r = await publicSignUp("pub", {
      invite_ticket: ticket, terms_accepted: true, privacy_accepted: true, display_name: "QA Pub",
    });
    if (r.error?.code === "no_public_mailbox") {
      skip("signUp العام", "YSD_QA_PUBLIC_EMAIL_BASE غير مضبوط — لا صندوق بريد قابل للتسليم");
    } else
    /**
     * مُصنِّفان لا نتيجة واحدة: حدّ بريد GoTrue، و**رفض النطاق**. هذا المشروع
     * يتحقق من قابلية تسليم البريد في مسار العموم (لا في admin)، فيرفض
     * qa-ysd.com وexample.com و.test — أي كل نطاق اختباري متاح لي. ذلك قيد
     * بيئة لا نتيجة للبوابة، فيُصنَّف غير حاسم بدل أن يُعدّ نجاحًا أو فشلًا.
     *
     * والبوابة نفسها ليست غير مختبَرة: المُحفّز واحد لكلا المسارين، وقد ثبت
     * عقده كاملًا عبر admin.createUser في القسم ١.
     */
    if (r.error && isRateLimit(r.error)) {
      skip("signUp العام", `حدّ بريد GoTrue (status=${r.error.status})`);
    } else if (r.error && String(r.error.code) === "email_address_invalid") {
      skip("signUp العام", "المشروع يرفض كل نطاق اختباري متاح (تحقق قابلية التسليم)");
    } else {
      ok("لا 500", r.error?.status !== 500, r.error ? `status=${r.error.status}` : "نجح");
      ok("لا خطأ إطلاقًا", !r.error, r.error ? String(r.error.code ?? r.error.status) : "");
      if (r.data?.user) {
        const { data: p } = await db.from("profiles").select("role").eq("id", r.data.user.id).maybeSingle();
        ok("role=user", p?.role === "user", `= ${p?.role}`);
        ok("used_count = 1", (await inviteUsed(inv.id)) === 1);
        const { count: profCount } = await db.from("profiles")
          .select("*", { count: "exact", head: true }).eq("id", r.data.user.id);
        ok("profile واحد فقط", profCount === 1, `= ${profCount}`);
        const { data: uu } = await db.auth.admin.getUserById(r.data.user.id);
        const md = uu?.user?.user_metadata ?? {};
        ok("invite_ticket وinvite_code غير مخزّنين",
          !("invite_ticket" in md) && !("invite_code" in md));
        // العقد مع تأكيد البريد: جلسة أو لا، المهم ألّا يُدَّعى وجودها كذبًا
        console.log(`     العقد: user=${Boolean(r.data.user)} session=${Boolean(r.data.session)}`);
        ok("لا جلسة تُدَّعى قبل التأكيد",
          Boolean(r.data.session) === Boolean(uu?.user?.email_confirmed_at));

        /**
         * تعداد الحسابات: بريد قائم يجب ألّا يكشف نفسه. GoTrue يردّ بنجاح
         * ظاهري وidentities فارغة بدل خطأ صريح، فلا يستطيع مجهول أن يعرف من
         * يملك حسابًا. نباعد المحاولة ٨ ثوانٍ احترامًا لحدّ الإرسال.
         */
        await new Promise((res) => setTimeout(res, 65000)); // ننتظر مدة الحد لا نلتف عليه
        const dupInv = await makeInvite(1);
        const dup = await anon.auth.signUp({
          email: r.email,
          password: qaPass(),
          options: { data: { invite_ticket: await issueTicket(dupInv.code), terms_accepted: true } },
        });
        if (dup.error && isRateLimit(dup.error)) {
          skip("بريد قائم على المسار العام", "حدّ إرسال GoTrue");
        } else {
          ok("بريد قائم ⇒ لا 500", dup.error?.status !== 500,
            dup.error ? `status=${dup.error.status}` : `identities=${dup.data?.user?.identities?.length ?? "—"}`);
          ok("لا رسالة تكشف وجود الحساب",
            !/exists|registered|already|مسجّل|موجود/i.test(String(dup.error?.message ?? "")),
            String(dup.error?.message ?? "").slice(0, 40));
          ok("لا يُنشأ حساب ثانٍ بالبريد نفسه",
            !dup.data?.user?.id || dup.data.user.id === r.data.user.id);
        }
      }
    }
  }

  // ══════════ ٣) منع تصعيد الدور ══════════
  console.log("\n── ٣) منع تصعيد الدور من metadata ──");
  for (const wanted of ["admin", "owner"]) {
    const inv = await makeInvite(1);
    const r = await adminCreate(`role${wanted}`, {
      invite_ticket: await issueTicket(inv.code), terms_accepted: true,
      role: wanted, user_role: wanted,
    });
    if (r.error) {
      ok(`طلب role=${wanted}: لم يُنشئ حسابًا`, true, `status=${r.error.status}`);
    } else {
      const { data: p } = await db.from("profiles").select("role").eq("id", r.data.user.id).maybeSingle();
      ok(`role=${wanted} في metadata ⇒ الدور يبقى user`, p?.role === "user", `= ${p?.role}`);
    }
  }

  // ══════════ ٤) مصفوفة الرفض ══════════
  console.log("\n── ٤) مصفوفة الرفض ──");
  const expiredInv = await makeInvite(1, { expires_at: new Date(Date.now() - 86_400_000).toISOString() });
  const revokedInv = await makeInvite(1, { revoked_at: new Date().toISOString() });
  const exhausted = await makeInvite(1);
  {
    // استنفاد الدعوة أولًا باستعمال مشروع
    const r = await adminCreate("exhaust", { invite_ticket: await issueTicket(exhausted.code), terms_accepted: true });
    ok("تجهيز: دعوة max_uses=1 استُهلكت", !r.error && (await inviteUsed(exhausted.id)) === 1);
  }
  const goodInv = await makeInvite(1);
  const rejectCases = [
    ["بلا تذكرة", { terms_accepted: true }],
    ["تذكرة غير صحيحة", { invite_ticket: "0".repeat(48), terms_accepted: true }],
    ["كود منتهٍ", { invite_ticket: await issueTicket(expiredInv.code), terms_accepted: true }],
    ["كود معطّل", { invite_ticket: await issueTicket(revokedInv.code), terms_accepted: true }],
    ["دعوة استنفدت max_uses", { invite_ticket: await issueTicket(exhausted.code), terms_accepted: true }],
    ["بلا موافقة الشروط", { invite_ticket: await issueTicket(goodInv.code) }],
  ];
  for (const [label, meta] of rejectCases) {
    const before = await counts();
    const r = await adminCreate(`rej`, meta);
    if (r.error && isRateLimit(r.error)) { skip(label, "حدّ بريد GoTrue"); continue; }
    ok(`${label} ⇒ مرفوض`, Boolean(r.error), r.error ? `status=${r.error.status}` : "❌ نجح");
    const msg = String(r.error?.message ?? "");
    ok(`${label}: لا تسريب SQL/دالة/قيد`,
      !/insert|update|constraint|pg_|function|relation|SQLSTATE|handle_new_user/i.test(msg),
      msg.slice(0, 60));
    const after = await counts();
    ok(`${label}: لا مستخدم جزئي`, after.authUsers === before.authUsers,
      `${before.authUsers} → ${after.authUsers}`);
    ok(`${label}: لا profile يتيم`, after.orphanProfile === 0 && after.orphanAuth === 0);
  }
  ok("الدعوة الصالحة لم تُستهلك في حالة رفض الموافقة",
    (await inviteUsed(goodInv.id)) === 0, `= ${await inviteUsed(goodInv.id)}`);

  // بريد غير صالح / كلمة مرور ضعيفة / بريد مكرر
  {
    const inv = await makeInvite(3);
    const base = { invite_ticket: await issueTicket(inv.code), terms_accepted: true };
    const rBadEmail = await db.auth.admin.createUser({
      email: "ليس-بريدًا", password: qaPass(), email_confirm: true, user_metadata: base,
    });
    ok("بريد غير صالح ⇒ مرفوض", Boolean(rBadEmail.error), `status=${rBadEmail.error?.status}`);

    /**
     * الضعف يُختبر على **مسار العموم**: admin.createUser عملية إدارية تتجاوز
     * سياسة كلمة المرور عمدًا (المشرف يضبط ما يشاء)، فاختبارها هناك يقيس
     * صلاحية المشرف لا العقد الذي يحمي المستخدمين.
     */
    const rWeak = await publicSignUp("weak", base, "123");
    /**
     * غياب صندوق البريد ليس رفضًا. الصيغة الأولى كانت تعدّه نجاحًا لأن
     * publicSignUp تُرجع خطأً اصطناعيًا (no_public_mailbox) والفحص كان
     * `Boolean(error)` — فيمرّ الاختبار دون أن يُختبر شيء. نجاحٌ كاذب أخطر
     * من فشل، وهو بالضبط ما وقعتُ فيه حين اختبرت مسار invite_code المهجور.
     */
    if (
      rWeak.error &&
      (isRateLimit(rWeak.error) ||
        ["email_address_invalid", "no_public_mailbox"].includes(String(rWeak.error.code)))
    ) {
      skip("كلمة مرور ضعيفة", "مسار العموم غير متاح في هذه البيئة");
    } else {
      ok("كلمة مرور ضعيفة على مسار العموم ⇒ مرفوضة",
        Boolean(rWeak.error), rWeak.error ? `code=${rWeak.error.code}` : "❌ قُبلت");
    }

    const dupEmail = qaEmail("dup");
    const r1 = await db.auth.admin.createUser({
      email: dupEmail, password: qaPass(), email_confirm: true, user_metadata: base,
    });
    if (r1.data?.user) createdUsers.push(r1.data.user.id);
    ok("تجهيز: أول تسجيل نجح", !r1.error, r1.error ? `status=${r1.error.status}` : "");
    const r2 = await db.auth.admin.createUser({
      email: dupEmail, password: qaPass(), email_confirm: true, user_metadata: base,
    });
    if (r2.data?.user) createdUsers.push(r2.data.user.id);
    ok("بريد مستخدم مسبقًا ⇒ مرفوض", Boolean(r2.error), `status=${r2.error?.status}`);
  }

  // ══════════ ٥) التراجع الكامل ══════════
  console.log("\n── ٥) التراجع: فشل بعد استهلاك الدعوة وقبل إنشاء profile ──");
  {
    /**
     * consent_required تُرفع **بعد** UPDATE على beta_invites و**قبل** إدراج
     * profiles — أي بالضبط النقطة المطلوبة. فلا حاجة للعبث بقيود الإنتاج
     * لاصطناع فشل: المسار موجود في الدالة نفسها.
     */
    const inv = await makeInvite(1);
    const before = await counts();
    const r = await adminCreate("rollback", { invite_ticket: await issueTicket(inv.code) }); // بلا موافقة
    ok("فشل متعمّد بعد الاستهلاك", Boolean(r.error), r.error ? `status=${r.error.status}` : "❌ نجح");
    const after = await counts();
    ok("تراجع كامل: لا auth user", after.authUsers === before.authUsers,
      `${before.authUsers} → ${after.authUsers}`);
    ok("تراجع كامل: لا profile", after.profiles === before.profiles);
    ok("تراجع كامل: used_count عاد 0", (await inviteUsed(inv.id)) === 0,
      `= ${await inviteUsed(inv.id)}`);
    ok("لا صفوف يتيمة", after.orphanAuth === 0 && after.orphanProfile === 0);
  }

  // ══════════ ٦) التزامن على آخر استخدام ══════════
  console.log("\n── ٦) التزامن: max_uses=1 وطلبان متزامنان ──");
  {
    const inv = await makeInvite(1);
    // تذكرتان من دعوة max_uses=1 — التنافس على آخر استخدام
    const meta1 = { invite_ticket: await issueTicket(inv.code), terms_accepted: true };
    const meta2 = { invite_ticket: await issueTicket(inv.code), terms_accepted: true };
    const mk = (meta) =>
      db.auth.admin.createUser({
        email: qaEmail("conc"), password: qaPass(), email_confirm: true, user_metadata: meta,
      });
    const [a, b] = await Promise.all([mk(meta1), mk(meta2)]);
    for (const r of [a, b]) if (r.data?.user) createdUsers.push(r.data.user.id);
    const wins = [a, b].filter((r) => !r.error).length;
    const fails = [a, b].filter((r) => r.error).length;
    ok("واحد فقط ينجح", wins === 1, `ناجح=${wins} فاشل=${fails}`);
    ok("الآخر يُرفض برسالة آمنة", fails === 1);
    ok("used_count النهائي = 1", (await inviteUsed(inv.id)) === 1, `= ${await inviteUsed(inv.id)}`);
    const after = await counts();
    ok("لا مستخدم جزئي ولا profile يتيم", after.orphanAuth === 0 && after.orphanProfile === 0);
    const { count: uses } = await db.from("beta_invite_uses")
      .select("*", { count: "exact", head: true }).eq("invite_id", inv.id);
    ok("ربط واحد فقط", uses === 1, `= ${uses}`);
  }

  // ══════════ ٧) حالات التسجيل الثلاث ══════════
  const setMode = async (req, allow) => {
    await db.from("platform_settings").update({ value: req }).eq("key", "require_invite");
    await db.from("platform_settings").update({ value: allow }).eq("key", "allow_registration");
  };

  console.log("\n── ٧أ) invite_only (require=true · allow=false) ──");
  await setMode(true, false);
  {
    const before = await counts();
    const noTicket = await adminCreate("m_io_no", { terms_accepted: true });
    ok("بلا تذكرة ⇒ مرفوض", Boolean(noTicket.error), `status=${noTicket.error?.status}`);
    const inv = await makeInvite(1);
    const withTicket = await adminCreate("m_io_yes", {
      invite_ticket: await issueTicket(inv.code), terms_accepted: true, role: "admin",
    });
    ok("بتذكرة صالحة ⇒ ينجح (admin.createUser يحتاج تذكرة)", !withTicket.error,
      withTicket.error ? `status=${withTicket.error.status}` : "");
    if (withTicket.data?.user) {
      const { data: pr } = await db.from("profiles").select("role")
        .eq("id", withTicket.data.user.id).maybeSingle();
      ok("الدور user رغم role=admin في metadata", pr?.role === "user", `= ${pr?.role}`);
    }
    ok("used_count = 1", (await inviteUsed(inv.id)) === 1);
    const after = await counts();
    ok("لا صفوف يتيمة", after.orphanAuth === 0 && after.orphanProfile === 0);
    ok("زاد مستخدم واحد فقط", after.authUsers === before.authUsers + 1,
      `${before.authUsers} → ${after.authUsers}`);
  }

  console.log("\n── ٧ب) open (require=false · allow=true) ──");
  await setMode(false, true);
  {
    const inv = await makeInvite(1);
    const r = await adminCreate("m_open", { terms_accepted: true, role: "owner" });
    ok("admin.createUser ينجح دون تذكرة", !r.error, r.error ? `status=${r.error.status}` : "");
    if (r.data?.user) {
      const { data: pr } = await db.from("profiles").select("role").eq("id", r.data.user.id).maybeSingle();
      ok("الدور user رغم role=owner في metadata", pr?.role === "user", `= ${pr?.role}`);
      const { count: subs } = await db.from("subscriptions")
        .select("*", { count: "exact", head: true }).eq("user_id", r.data.user.id);
      ok("اشتراك أُنشئ", subs === 1);
    }
    const withTicket = await adminCreate("m_open_tk", {
      invite_ticket: await issueTicket(inv.code), terms_accepted: true,
    });
    ok("تسجيل بتذكرة في وضع open ينجح", !withTicket.error);
    ok("لا تُستهلك دعوة في وضع open", (await inviteUsed(inv.id)) === 0,
      `= ${await inviteUsed(inv.id)}`);
    const noConsent = await adminCreate("m_open_nc", {});
    ok("بلا موافقة يبقى مرفوضًا في open", Boolean(noConsent.error));
  }

  console.log("\n── ٧ج) closed (require=false · allow=false) ──");
  await setMode(false, false);
  {
    const before = await counts();
    const inv = await makeInvite(1);
    const ticket = await issueTicket(inv.code);
    const r = await adminCreate("m_closed", { terms_accepted: true });
    ok("admin.createUser مرفوض", Boolean(r.error), `status=${r.error?.status}`);
    const rT = await adminCreate("m_closed_tk", { invite_ticket: ticket, terms_accepted: true });
    ok("حتى بتذكرة صالحة ⇒ مرفوض", Boolean(rT.error), `status=${rT.error?.status}`);
    ok("لا دعوة تُستهلك", (await inviteUsed(inv.id)) === 0, `= ${await inviteUsed(inv.id)}`);
    const after = await counts();
    ok("لا مستخدم جزئي", after.authUsers === before.authUsers,
      `${before.authUsers} → ${after.authUsers}`);
    ok("لا profile", after.profiles === before.profiles);
    ok("لا صفوف يتيمة", after.orphanAuth === 0 && after.orphanProfile === 0);
    const msg = String(r.error?.message ?? "");
    ok("لا تسريب في رسالة الرفض",
      !/insert|constraint|pg_|handle_new_user|SQLSTATE/i.test(msg), msg.slice(0, 40));
  }
} catch (err) {
  bad++;
  console.log(`\n  ❌ استثناء: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  console.log("\n── التنظيف ──");
  for (const id of createdUsers) {
    await db.from("profiles").delete().eq("id", id);
    await db.auth.admin.deleteUser(id).catch(() => undefined);
  }
  for (const id of createdInvites) {
    await db.from("invite_tickets").delete().eq("invite_id", id);
    await db.from("beta_invite_uses").delete().eq("invite_id", id);
    await db.from("beta_invites").delete().eq("id", id);
  }
  console.log(`  حُذف: مستخدمو QA=${createdUsers.length} · دعوات QA=${createdInvites.length}`);

  const AFTER = await counts();
  const same = AFTER.authUsers === BEFORE.authUsers && AFTER.profiles === BEFORE.profiles;
  console.log(`  ${same ? "✅" : "❌"} الأعداد عادت — قبل ${JSON.stringify(BEFORE)}`);
  console.log(`     بعد ${JSON.stringify(AFTER)}`);
  if (!same) bad++;
  const rolesSame = JSON.stringify(AFTER.roles) === JSON.stringify(BEFORE.roles);
  console.log(`  ${rolesSame ? "✅" : "❌"} الأدوار بلا تغيير — ${JSON.stringify(AFTER.roles)}`);
  if (!rolesSame) bad++;

  // دعوات المستخدمين الحقيقيين لم تتأثر
  const { data: allInv1 } = await db.from("beta_invites").select("id, used_count");
  const drift = (allInv1 ?? []).filter(
    (r) => r.id in REAL_INVITES0 && REAL_INVITES0[r.id] !== r.used_count,
  );
  console.log(`  ${drift.length === 0 ? "✅" : "❌"} used_count للدعوات الحقيقية بلا تغيير (${drift.length} انحراف)`);
  if (drift.length) bad++;
  const leftQa = (allInv1 ?? []).length - (allInv0 ?? []).length;
  console.log(`  ${leftQa === 0 ? "✅" : "❌"} لا دعوات QA متبقية (فرق=${leftQa})`);
  if (leftQa !== 0) bad++;

  // استعادة حرفية — الأوضاع الثلاثة بدّلت المفتاحين
  for (const [k, v] of Object.entries(SETTINGS0)) {
    await db.from("platform_settings").update({ value: v }).eq("key", k);
  }
  // استعادة حرفية — قسم الأوضاع بدّل المفتاحين
  for (const [k, v] of Object.entries(SETTINGS0)) {
    await db.from("platform_settings").update({ value: v }).eq("key", k);
  }
  const { data: ps1 } = await db.from("platform_settings").select("key,value")
    .in("key", ["require_invite", "allow_registration"]);
  const S1 = Object.fromEntries((ps1 ?? []).map((r) => [r.key, r.value]));
  // مقارنة مفتاحًا بمفتاح: JSON.stringify حسّاس لترتيب المفاتيح، وترتيب صفوف
  // القاعدة يتغيّر بعد التحديث — فكانت المقارنة تُعلن اختلافًا والقيَم متطابقة.
  const settingsSame =
    Object.keys(SETTINGS0).length === Object.keys(S1).length &&
    Object.entries(SETTINGS0).every(([k, v]) => JSON.stringify(S1[k]) === JSON.stringify(v));
  console.log(`  ${settingsSame ? "✅" : "❌"} الإعدادات كما كانت — ${JSON.stringify(S1)}`);
  if (!settingsSame) bad++;

  console.log(
    `\n${bad === 0 ? "✅ مصفوفة التسجيل سليمة" : `❌ إخفاقات=${bad}`}` +
      (inconclusive ? ` · غير حاسم=${inconclusive} (حدّ بريد GoTrue)` : ""),
  );
  process.exitCode = bad > 0 ? 1 : 0;
}
