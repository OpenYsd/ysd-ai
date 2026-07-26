#!/usr/bin/env node
/**
 * تجهيز حساب اختبار E2E وحالة جلسته (v0.6.6 RC3).
 *
 *   npm run e2e:prepare
 *
 * يقرأ محليًا من .env.e2e.local (أو من البيئة):
 *   YSD_E2E_EMAIL · YSD_E2E_PASSWORD · SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY (من .env.local)
 *
 * ثم: ينشئ حساب اختبار **عاديًا غير إداري** (أو يعيد استخدامه)، ويسجّل دخوله،
 * ويحفظ حالة الجلسة في .playwright/.auth/ysd-e2e.json
 *
 * أمان — قواعد ملزمة في هذا الملف:
 *   • لا يُطبع البريد كاملًا (يُقنَّع)، ولا كلمة المرور، ولا أي token.
 *   • لا يلمس حساب YSD Admin ولا جلسته إطلاقًا.
 *   • يرفض الاستمرار إن كان الحساب إداريًا.
 *   • الملفات الناتجة مستثناة في .gitignore.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

/**
 * يقرأ ملف env بسيطًا دون طباعة أي قيمة.
 * التقسيم بـ/\r?\n/ لا "\n": ملفات ويندوز CRLF، و`.` في JS لا تُطابق `\r`
 * فيفشل `$` ولا يُقرأ إلا سطر واحد (رُصد فعليًا على هذا الجهاز).
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(path.resolve(".env.e2e.local"));
loadEnvFile(path.resolve(".env.local"));

/** يقنّع البريد: a***@d***.com — لا يُطبع كاملًا أبدًا */
const maskEmail = (e) => {
  const [u, d] = String(e).split("@");
  if (!d) return "***";
  return `${u.slice(0, 1)}***@${d.slice(0, 1)}***`;
};

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.YSD_E2E_EMAIL;
const PASSWORD = process.env.YSD_E2E_PASSWORD;

const missing = [
  ["NEXT_PUBLIC_SUPABASE_URL", URL_],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE],
  ["YSD_E2E_EMAIL", EMAIL],
  ["YSD_E2E_PASSWORD", PASSWORD],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error("متغيرات ناقصة (ضعها في .env.e2e.local):");
  for (const k of missing) console.error(`  - ${k}`);
  process.exit(1);
}

const admin = createClient(URL_, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** يجد المستخدم بالبريد عبر صفحات listUsers (بلا طباعة أي بريد) */
async function findUser(email) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.status ?? "?"}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function main() {
  console.log(`[e2e] الحساب: ${maskEmail(EMAIL)}`);

  let user = await findUser(EMAIL);
  if (user) {
    console.log("[e2e] الحساب موجود — إعادة استخدام");
    // اضبط كلمة المرور لتطابق الملف المحلي وأكّد البريد
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`updateUser failed: ${error.status ?? "?"}`);
  } else {
    console.log("[e2e] إنشاء حساب اختبار جديد");
    // المنصّة في بيتا مغلقة: handle_new_user يرفض التسجيل بلا تذكرة دعوة
    // صالحة. نمرّرها في raw_user_meta_data كما يفعل مسار التسجيل المعتمد،
    // بدل تعطيل require_invite عالميًا (وهو ما كان سيفتح التسجيل للجميع).
    // handle_new_user يشترط أيضًا terms_accepted صراحةً (وإلا consent_required)
    // — نفس ما يرسله نموذج التسجيل المعتمد، فيُسجَّل القبول في user_consents.
    const ticket = process.env.YSD_E2E_INVITE_TICKET;
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        terms_accepted: true,
        display_name: "E2E Test",
        ...(ticket ? { invite_ticket: ticket } : {}),
      },
    });
    if (error) {
      const hint = ticket
        ? ""
        : " (بيتا مغلقة؟ مرّر YSD_E2E_INVITE_TICKET بتذكرة صالحة)";
      throw new Error(`createUser failed: ${error.status ?? "?"}${hint}`);
    }
    user = data.user;
  }

  // يجب أن يكون عاديًا وغير إداري — وإلا نتوقف فورًا
  const { data: profile } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();

  if (profile && (profile.role === "admin" || profile.role === "owner")) {
    console.error("[e2e] توقّف: هذا الحساب إداري. استخدم حساب اختبار عاديًا فقط.");
    process.exit(2);
  }
  if (profile && profile.status !== "active") {
    const { error } = await admin.from("profiles").update({ status: "active" }).eq("id", user.id);
    if (error) throw new Error(`activate failed`);
  }
  console.log(`[e2e] الدور: ${profile?.role ?? "user"} · الحالة: ${profile?.status ?? "active"}`);

  // تسجيل الدخول بمفتاح anon (كما يفعل المتصفح) للحصول على جلسة حقيقية
  const pub = createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: signErr } = await pub.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (signErr || !signIn.session) throw new Error(`signIn failed: ${signErr?.status ?? "?"}`);

  // كوكي @supabase/ssr: اسمها sb-<ref>-auth-token وقيمتها base64-<json>
  const ref = new URL(URL_).hostname.split(".")[0];
  const payload = {
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
    expires_at: signIn.session.expires_at,
    expires_in: signIn.session.expires_in,
    token_type: "bearer",
    user: signIn.session.user,
  };
  const cookieValue = `base64-${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}`;

  const baseUrl = process.env.YSD_E2E_BASE_URL ?? "http://localhost:3300";
  const { hostname } = new URL(baseUrl);

  const storageState = {
    cookies: [
      {
        name: `sb-${ref}-auth-token`,
        value: cookieValue,
        domain: hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
        httpOnly: false,
        secure: baseUrl.startsWith("https"),
        sameSite: "Lax",
      },
    ],
    origins: [],
  };

  const outDir = path.resolve(".playwright/.auth");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "ysd-e2e.json");
  fs.writeFileSync(outFile, JSON.stringify(storageState, null, 2), "utf8");

  // لا نطبع أي token — المسار فقط
  console.log(`[e2e] حالة الجلسة حُفظت: .playwright/.auth/ysd-e2e.json`);
  console.log(`[e2e] النطاق: ${hostname}`);
  console.log("");
  console.log("التشغيل (PowerShell):");
  console.log('  $env:YSD_E2E_STORAGE_STATE=".playwright/.auth/ysd-e2e.json"');
  console.log("  npm run test:e2e");
}

main().catch((err) => {
  // رسالة الخطأ فقط بلا أي سر
  console.error(`[e2e] فشل: ${err.message}`);
  process.exit(1);
});
