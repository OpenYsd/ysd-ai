/**
 * تسجيل Google بالدعوة (v0.8.0) — ترحيل 0024.
 *
 * ثلاث طبقات، وكلٌّ منها تمسك ما لا تمسكه الأخرى:
 *
 *   ١) **بنيوية على نصّ SQL** — من أي حقل يُقرأ المزوّد، وهل الشروط داخل
 *      WHERE أم قبله. دالةٌ تقرأ الحقل الخطأ تتصرّف تصرّفًا سليمًا في كل حالة
 *      اختبار ثم تنهار أمام مهاجم؛ ولا يظهر ذلك إلا في النصّ.
 *
 *   ٢) **محاكاة تنفيذية** لدلالات العبارات الذرّية — تُنفَّذ عليها حالات
 *      التزامن وإعادة الاستخدام والتراجع. المحاكاة تحترم أن الشرط والكتابة في
 *      عبارة واحدة، فطلبان لا يفوزان معًا.
 *
 *   ٣) **تطابق الهاش** بين TypeScript وSQL — لو تباعد التطبيعان لصار كل تصريح
 *      غير قابل للاستهلاك: يُنشأ بهاش ويُبحث عنه بهاش آخر. عطلٌ صامت لا يظهر
 *      في أي اختبار وحدة لأي طرف بمفرده.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emailHash, looksLikeEmail, normalizeEmail } from "../lib/auth/google-invite";

const MIGRATION = fs.readFileSync(
  path.resolve("supabase/migrations/0024_google_invite_registration.sql"),
  "utf8",
);
/** يجرّد التعليقات — ذكر النمط في شرحٍ مقصود ولا يعني استعماله */
const sql = MIGRATION.replace(/\r\n/g, "\n")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

// ════════════════════════════════════════════════════════════
//  محاكاة القاعدة — دلالات ذرّية لا نيّات
// ════════════════════════════════════════════════════════════

interface Invite {
  id: string;
  codeHash: string;
  maxUses: number;
  usedCount: number;
  revoked: boolean;
  expiresAt: number | null;
}
interface Authorization {
  id: string;
  emailHash: string;
  inviteId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

class Db {
  invites: Invite[] = [];
  auths: Authorization[] = [];
  uses: { inviteId: string; userId: string }[] = [];
  profiles: string[] = [];
  consents: { userId: string }[] = [];
  now = 1_000_000;
  private seq = 0;

  addInvite(p: Partial<Invite> & { code: string }): Invite {
    const inv: Invite = {
      id: `inv-${++this.seq}`,
      codeHash: sha256(p.code),
      maxUses: p.maxUses ?? 1,
      usedCount: p.usedCount ?? 0,
      revoked: p.revoked ?? false,
      expiresAt: p.expiresAt ?? null,
    };
    this.invites.push(inv);
    return inv;
  }

  /** يطابق `select … for update` في الدالة: الصف الصالح وحده */
  private liveInvite(codeHash: string): Invite | undefined {
    return this.invites.find(
      (i) =>
        i.codeHash === codeHash &&
        !i.revoked &&
        (i.expiresAt === null || i.expiresAt > this.now) &&
        i.usedCount < i.maxUses,
    );
  }

  /** مرآة public.google_signup_authorize — لا تمسّ used_count إطلاقًا */
  authorize(code: string, email: string, ttl = 600): boolean {
    if (!code || code.length < 8) return false;
    const eh = emailHash(email);
    if (!looksLikeEmail(email)) return false;

    const inv = this.liveInvite(sha256(code.trim()));
    if (!inv) return false;

    /**
     * (٣) ألغِ تصاريح هذا البريد النشطة على **كل** الدعوات لا هذه وحدها.
     *
     * التقييد بالدعوة كان يترك البريد الواحد يحجز مقعدًا في دعوتين — وهو
     * السباق الذي لا يمنعه قفل صفّ الدعوة أصلًا. والفهرس الفريد الجزئي في
     * 0024 يجعل هذا ثابتًا في القاعدة لا عادةً في الشيفرة.
     */
    for (const a of this.auths) {
      if (a.emailHash === eh && !a.consumedAt && !a.revokedAt) {
        a.revokedAt = this.now;
      }
    }

    // (٤) المستهلَك + المحجوز ≤ max_uses
    const reserved = this.auths.filter(
      (a) => a.inviteId === inv.id && !a.consumedAt && !a.revokedAt && a.expiresAt > this.now,
    ).length;
    if (inv.usedCount + reserved >= inv.maxUses) return false;

    /**
     * الفهرس الفريد الجزئي مُحاكًى صراحةً: تصريح نشط واحد لكل بريد **عبر كل
     * الدعوات**. لو خرقه الإدراج لأُعيد `false` كما تفعل `unique_violation`
     * في 0024 — ونؤكّده هنا كي لا تمرّ محاكاةٌ على خرقٍ تمنعه القاعدة.
     */
    const stillActive = this.auths.some(
      (a) => a.emailHash === eh && !a.consumedAt && !a.revokedAt,
    );
    if (stillActive) return false;

    this.auths.push({
      id: `auth-${++this.seq}`,
      emailHash: eh,
      inviteId: inv.id,
      createdAt: this.now,
      expiresAt: this.now + ttl * 1000,
      consumedAt: null,
      revokedAt: null,
    });
    return true;
  }

  /** ثابت القاعدة: لا بريد له تصريحان نشطان — يُفحص بعد كل عملية */
  assertOneActivePerEmail(): void {
    const seen = new Set<string>();
    for (const a of this.auths) {
      if (a.consumedAt || a.revokedAt) continue;
      if (seen.has(a.emailHash)) {
        throw new Error(`خرق الفهرس الفريد: تصريحان نشطان لنفس البريد`);
      }
      seen.add(a.emailHash);
    }
  }

  /**
   * `update … where id = (select … limit 1 for update skip locked) returning`.
   * الشرط والكتابة في عبارة واحدة — فلا نافذة بين القراءة والكتابة.
   */
  consumeAuthorization(eh: string): string | null {
    const a = this.auths
      .filter(
        (x) => x.emailHash === eh && !x.consumedAt && !x.revokedAt && x.expiresAt > this.now,
      )
      .sort((x, y) => y.createdAt - x.createdAt)[0];
    if (!a) return null;
    a.consumedAt = this.now;
    return a.inviteId;
  }

  /** `update beta_invites … where … and used_count < max_uses returning id` */
  consumeInvite(inviteId: string): string | null {
    const inv = this.invites.find(
      (i) =>
        i.id === inviteId &&
        !i.revoked &&
        (i.expiresAt === null || i.expiresAt > this.now) &&
        i.usedCount < i.maxUses,
    );
    if (!inv) return null;
    inv.usedCount += 1;
    return inv.id;
  }

  snapshot() {
    return JSON.stringify({
      invites: this.invites.map((i) => ({ id: i.id, used: i.usedCount })),
      auths: this.auths.map((a) => ({ id: a.id, c: a.consumedAt, r: a.revokedAt })),
      uses: this.uses.length,
      profiles: this.profiles.length,
    });
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Outcome =
  | "created"
  | "invite_required_or_invalid"
  | "consent_required"
  | "registration_closed";

interface NewUser {
  id: string;
  email: string;
  appMetaProvider?: string | null;
  /** يكتبه العميل — يجب ألّا يُقرأ منه المزوّد */
  userMetaProvider?: string | null;
  ticket?: string | null;
  termsAccepted?: boolean;
}

/**
 * مرآة public.handle_new_user في 0024 — **بترتيب الفحوص نفسه**، مع تراجع
 * كامل عند الاستثناء كما تفعل المعاملة.
 */
function handleNewUser(
  db: Db,
  u: NewUser,
  settings: { requireInvite?: boolean | null; allowRegistration?: boolean | null } = {},
): { outcome: Outcome; consentRows: number } {
  /**
   * لقطة تراجع **على الصفوف نفسها** لا على المصفوفات.
   *
   * استبدال المصفوفة يترك كل مرجع قائم يشير إلى الصف المُعدَّل — فيبدو التراجع
   * ناجحًا في الاختبار وفاشلًا في الواقع. وPostgres يتراجع عن الصف ذاته، فوجب
   * أن تفعل المحاكاة مثله.
   */
  const before = {
    invites: db.invites.map((i) => ({ ...i })),
    auths: db.auths.map((a) => ({ ...a })),
    uses: db.uses.length,
    profiles: db.profiles.length,
    consents: db.consents.length,
  };
  const rollback = () => {
    db.invites.length = before.invites.length;
    db.invites.forEach((row, i) => Object.assign(row, before.invites[i]));
    db.auths.length = before.auths.length;
    db.auths.forEach((row, i) => Object.assign(row, before.auths[i]));
    db.uses.length = before.uses;
    db.profiles.length = before.profiles;
    db.consents.length = before.consents;
  };

  const vRequire = settings.requireInvite ?? true;
  const vAllow = settings.allowRegistration ?? false;

  // ← بيانات التطبيق وحدها. userMetaProvider لا يُقرأ إطلاقًا.
  const provider = u.appMetaProvider ?? null;

  let googleSignup = false;
  let authInvite: string | null = null;

  if (provider === "google" && u.email != null) {
    if (vAllow) {
      googleSignup = true;
    } else {
      authInvite = db.consumeAuthorization(emailHash(u.email));
      if (authInvite !== null) googleSignup = true;
    }
  }

  if (!vRequire && !vAllow) {
    rollback();
    return { outcome: "registration_closed", consentRows: 0 };
  }

  let inviteId: string | null = null;

  if (authInvite !== null) {
    inviteId = db.consumeInvite(authInvite);
    if (inviteId === null) {
      rollback(); // التصريح لا يُحرق على محاولة فاشلة
      return { outcome: "invite_required_or_invalid", consentRows: 0 };
    }
  } else if (vRequire && !googleSignup) {
    const ticketInvite = u.ticket ? ticketLookup(u.ticket) : null;
    if (ticketInvite !== null) inviteId = db.consumeInvite(ticketInvite);
  }

  if (vRequire && inviteId === null && !googleSignup) {
    rollback();
    return { outcome: "invite_required_or_invalid", consentRows: 0 };
  }

  const accepted = u.termsAccepted === true;
  if (!accepted && !googleSignup) {
    rollback();
    return { outcome: "consent_required", consentRows: 0 };
  }

  db.profiles.push(u.id);
  if (inviteId !== null) db.uses.push({ inviteId, userId: u.id });
  if (accepted) db.consents.push({ userId: u.id });

  return { outcome: "created", consentRows: accepted ? 2 : 0 };
}

/** تذاكر البريد وكلمة المرور — مبسّطة، تكفي لإثبات أن المسار لم يتغيّر */
const tickets = new Map<string, string>();
function ticketLookup(ticket: string): string | null {
  const inviteId = tickets.get(ticket);
  if (!inviteId) return null;
  tickets.delete(ticket); // أحادية الاستخدام
  return inviteId;
}

// ════════════════════════════════════════════════════════════

const GOOGLE = (email: string, id = "u1") => ({
  id,
  email,
  appMetaProvider: "google" as const,
});

describe("★ 0024 — بنية SQL", () => {
  it("★ المزوّد من raw_app_meta_data وحده", () => {
    expect(sql).toMatch(/v_provider\s*:=\s*new\.raw_app_meta_data->>'provider'/);
    expect(sql).not.toMatch(/raw_user_meta_data->>'provider'/);
  });

  it("★ البريد من new.email لا من بيانات المستخدم", () => {
    expect(sql).toMatch(/normalized_email_hash\(new\.email\)/);
    expect(sql).not.toMatch(/normalized_email_hash\([^)]*raw_user_meta_data/);
  });

  it("★ الشرط مساواة صريحة بـgoogle — لا مزوّد آخر", () => {
    expect(sql).toMatch(/v_provider\s*=\s*'google'/);
  });

  it("★ RLS مفعّل ومفروض وبلا سياسات", () => {
    expect(sql).toMatch(/alter table public\.google_signup_authorizations enable row level security/);
    expect(sql).toMatch(/alter table public\.google_signup_authorizations force row level security/);
    // أي `create policy` على هذا الجدول يفتح ثغرة قراءة
    expect(sql).not.toMatch(/create policy[\s\S]{0,200}google_signup_authorizations/);
  });

  it("★ لا صلاحية جدول لـanon ولا authenticated", () => {
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql).toMatch(
        new RegExp(`revoke all on table public\\.google_signup_authorizations from ${role}`),
      );
    }
    expect(sql).not.toMatch(/grant[^;]*on table public\.google_signup_authorizations/);
  });

  it("★ إنشاء التصريح لا يمسّ used_count", () => {
    const fn = sql.slice(
      sql.indexOf("function public.google_signup_authorize"),
      sql.indexOf("function public.purge_google_signup_authorizations"),
    );
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).not.toMatch(/set\s+used_count/);
    expect(fn).not.toMatch(/used_count\s*=\s*used_count\s*\+/);
  });

  it("★ حجز المقعد داخل قفل الدعوة", () => {
    const fn = sql.slice(sql.indexOf("function public.google_signup_authorize"));
    // القفل يسبق العدّ، والعدّ يسبق الإدراج
    const lock = fn.indexOf("for update");
    const count = fn.indexOf("v_used_count + v_reserved >= v_max_uses");
    const insert = fn.indexOf("insert into public.google_signup_authorizations");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(insert);
  });

  it("★ استهلاك التصريح عبارة واحدة بـskip locked", () => {
    expect(sql).toMatch(
      /update public\.google_signup_authorizations\s*set consumed_at = pg_catalog\.now\(\)\s*where id = \(\s*select id[\s\S]*?for update skip locked\s*\)\s*returning invite_id/,
    );
  });

  it("★ استهلاك الدعوة بكل شروطه داخل WHERE", () => {
    expect(sql).toMatch(
      /update public\.beta_invites\s*set used_count = used_count \+ 1\s*where id = v_auth_invite[\s\S]{0,200}revoked_at is null[\s\S]{0,200}used_count < max_uses[\s\S]{0,80}returning id into v_invite_id/,
    );
  });

  it("★ نفاد الدعوة بعد استهلاك التصريح يرفع استثناءً (تراجع كامل)", () => {
    expect(sql).toMatch(
      /if v_invite_id is null then\s*raise exception 'invite_required_or_invalid'/,
    );
  });

  /** الأسماء مؤهَّلة بالكامل — يفرضه `search_path = ''` (تفاصيله في اختبار التشديدات) */
  it("★ التطبيع lower(btrim(...)) ثم sha256 بأسماء مؤهَّلة", () => {
    expect(sql).toMatch(
      /pg_catalog\.encode\(\s*extensions\.digest\(pg_catalog\.lower\(pg_catalog\.btrim\(p_email\)\), 'sha256'\),\s*'hex'\)/,
    );
  });

  it("★ الدوال محميّة والدالة ممنوحة لـservice_role وحده", () => {
    expect(sql).toMatch(
      /grant execute on function public\.google_signup_authorize\(text, text, int\) to service_role/,
    );
    // ولا يصلها أي دور عميل
    for (const role of ["anon", "authenticated"]) {
      expect(sql, role).toMatch(
        new RegExp(
          `revoke all on function public\\.google_signup_authorize\\(text, text, int\\) from ${role}`,
        ),
      );
    }
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.handle_new_user\\(\\) from ${role}`),
      );
    }
  });
});

describe("★ تطابق الهاش بين TypeScript وSQL", () => {
  it("★ التطبيع نفسه: trim ثم lowercase", () => {
    expect(normalizeEmail("  Foo@Gmail.COM  ")).toBe("foo@gmail.com");
    expect(emailHash("  Foo@Gmail.COM  ")).toBe(emailHash("foo@gmail.com"));
  });

  it("★ متجه معروف — sha256 للبريد المُطبَّع", () => {
    expect(emailHash("Test@Example.com")).toBe(sha256("test@example.com"));
    expect(emailHash("x@y.z")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("★ SQL يستعمل الترتيب نفسه (lower ثم btrim داخلًا)", () => {
    // لو صار SQL `btrim(lower(...))` لبقيت النتيجة نفسها؛ الممنوع إسقاط أحدهما
    expect(sql).toMatch(/pg_catalog\.lower\(pg_catalog\.btrim\(/);
    expect(sql).toMatch(
      /extensions\.digest\(pg_catalog\.lower\(pg_catalog\.btrim\(p_email\)\), 'sha256'\)/,
    );
  });
});

describe("★ المسار السعيد", () => {
  it("★ دعوة صالحة + بريد مطابق ⇒ يُنشأ المستخدم", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 1 });
    expect(db.authorize("INVITE-1234", "tester@gmail.com")).toBe(true);

    const r = handleNewUser(db, GOOGLE("tester@gmail.com"));
    expect(r.outcome).toBe("created");
    expect(db.invites[0]!.usedCount).toBe(1);
    expect(db.uses).toHaveLength(1);
    expect(db.auths[0]!.consumedAt).not.toBeNull();
  });

  it("★ البريد يُطبَّع — اختلاف الحالة والمسافات لا يمنع", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "  Tester@Gmail.com  ");
    expect(handleNewUser(db, GOOGLE("tester@gmail.com")).outcome).toBe("created");
  });

  it("★ مستخدم Google لا يُسجَّل له قبول شروط ⇒ يذهب إلى /accept-terms", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "t@gmail.com");
    const r = handleNewUser(db, GOOGLE("t@gmail.com"));
    expect(r.outcome).toBe("created");
    expect(r.consentRows).toBe(0);
    expect(db.consents).toHaveLength(0);
  });

  it("★ إنشاء التصريح لا يستهلك الدعوة", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 3 });
    db.authorize("INVITE-1234", "a@gmail.com");
    db.authorize("INVITE-1234", "b@gmail.com");
    expect(db.invites[0]!.usedCount).toBe(0);
  });
});

describe("★ الرفض — ولا استهلاك", () => {
  it("★ بريد Google مختلف عن المصرَّح ⇒ رفض بلا أي استهلاك", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "expected@gmail.com");
    const snap = db.snapshot();

    const r = handleNewUser(db, GOOGLE("someone.else@gmail.com"));
    expect(r.outcome).toBe("invite_required_or_invalid");
    expect(db.snapshot()).toBe(snap); // لا عدّاد تغيّر ولا تصريح استُهلك
    expect(db.invites[0]!.usedCount).toBe(0);
  });

  it("★ تصريح منتهٍ ⇒ رفض", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "t@gmail.com", 600);
    db.now += 601_000; // مرّت أكثر من عشر دقائق

    const r = handleNewUser(db, GOOGLE("t@gmail.com"));
    expect(r.outcome).toBe("invite_required_or_invalid");
    expect(db.invites[0]!.usedCount).toBe(0);
  });

  it("★ إعادة استخدام التصريح ⇒ الثاني مرفوض", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 5 });
    db.authorize("INVITE-1234", "t@gmail.com");

    expect(handleNewUser(db, GOOGLE("t@gmail.com", "u1")).outcome).toBe("created");
    expect(handleNewUser(db, GOOGLE("t@gmail.com", "u2")).outcome).toBe(
      "invite_required_or_invalid",
    );
    expect(db.invites[0]!.usedCount).toBe(1); // مرة واحدة لا مرتين
    expect(db.profiles).toEqual(["u1"]);
  });

  it("★ Google جديد بلا تصريح ⇒ رفض", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    const r = handleNewUser(db, GOOGLE("stranger@gmail.com"));
    expect(r.outcome).toBe("invite_required_or_invalid");
    expect(db.invites[0]!.usedCount).toBe(0);
  });

  it("★ تصريح ملغى (بعد إعادة التحقق) لا يصلح", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 2 });
    db.authorize("INVITE-1234", "t@gmail.com");
    const first = db.auths[0]!.id;
    db.authorize("INVITE-1234", "t@gmail.com"); // إعادة المحاولة تُلغي الأول

    expect(db.auths.find((a) => a.id === first)?.revokedAt).not.toBeNull();
    expect(handleNewUser(db, GOOGLE("t@gmail.com")).outcome).toBe("created");
    expect(db.invites[0]!.usedCount).toBe(1); // مقعد واحد لا اثنان
  });

  it("★ الدعوة نفدت بين الحجز والعودة ⇒ رفض بلا حرق التصريح", () => {
    const db = new Db();
    const inv = db.addInvite({ code: "INVITE-1234", maxUses: 1 });
    db.authorize("INVITE-1234", "t@gmail.com");
    inv.usedCount = 1; // استُهلكت من مسار آخر

    const r = handleNewUser(db, GOOGLE("t@gmail.com"));
    expect(r.outcome).toBe("invite_required_or_invalid");
    expect(inv.usedCount).toBe(1); // لم تُزَد
    expect(db.auths[0]!.consumedAt).toBeNull(); // التراجع أعاد التصريح
    expect(db.profiles).toHaveLength(0);
  });
});

describe("★ التزامن وحدود المقاعد", () => {
  /**
   * طلبان متزامنان لنفس التصريح: كلاهما يبحث، ثم كلاهما يحاول الاستهلاك.
   * العبارة الذرّية تعني أن الثاني لا يجد ما يستهلكه.
   */
  it("★ طلبان متزامنان لا يستهلكان المقعد مرتين", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 5 });
    db.authorize("INVITE-1234", "t@gmail.com");

    const a = handleNewUser(db, GOOGLE("t@gmail.com", "u1"));
    const b = handleNewUser(db, GOOGLE("t@gmail.com", "u2"));

    const created = [a, b].filter((r) => r.outcome === "created");
    expect(created).toHaveLength(1);
    expect(db.invites[0]!.usedCount).toBe(1);
    expect(db.uses).toHaveLength(1);
  });

  it("★ max_uses لا يُتجاوز مهما بلغ عدد التصاريح", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 2 });
    // الحجز نفسه يمنع تجاوز المقاعد
    expect(db.authorize("INVITE-1234", "a@gmail.com")).toBe(true);
    expect(db.authorize("INVITE-1234", "b@gmail.com")).toBe(true);
    expect(db.authorize("INVITE-1234", "c@gmail.com")).toBe(false); // المقاعد نفدت

    expect(handleNewUser(db, GOOGLE("a@gmail.com", "u1")).outcome).toBe("created");
    expect(handleNewUser(db, GOOGLE("b@gmail.com", "u2")).outcome).toBe("created");
    expect(handleNewUser(db, GOOGLE("c@gmail.com", "u3")).outcome).toBe(
      "invite_required_or_invalid",
    );
    expect(db.invites[0]!.usedCount).toBe(2);
    expect(db.invites[0]!.usedCount).toBeLessThanOrEqual(db.invites[0]!.maxUses);
  });

  it("★ الحجز يحسب المستهلَك أيضًا لا المحجوز وحده", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 2, usedCount: 1 });
    expect(db.authorize("INVITE-1234", "a@gmail.com")).toBe(true);
    expect(db.authorize("INVITE-1234", "b@gmail.com")).toBe(false); // 1 مستهلَك + 1 محجوز
  });

  /**
   * السباق الذي لا يمنعه قفل صفّ الدعوة: بريد واحد على **دعوتين مختلفتين**.
   * كلٌّ يقفل صفًّا آخر فيتوازيان.
   *
   * ما يُثبَت هنا هو **منطق** الحلّ: الإلغاء يشمل كل الدعوات، والفهرس الفريد
   * يرفض التصريح النشط الثاني. أمّا أن القفل الاستشاري يُسلسِل معاملتين
   * متزامنتين فعلًا فلا يُثبته JavaScript أحادي الخيط — ذلك في
   * scripts/v08-pg-concurrency.mjs باتصالَي PostgreSQL حقيقيين.
   */
  it("★ بريد واحد على دعوتين ⇒ تصريح نشط واحد ومقعد واحد", () => {
    const db = new Db();
    const a = db.addInvite({ code: "CODE-ALPHA-1", maxUses: 1 });
    const b = db.addInvite({ code: "CODE-BETA-22", maxUses: 1 });

    expect(db.authorize("CODE-ALPHA-1", "same@gmail.com")).toBe(true);
    expect(db.authorize("CODE-BETA-22", "same@gmail.com")).toBe(true);
    db.assertOneActivePerEmail();

    const active = db.auths.filter((x) => !x.consumedAt && !x.revokedAt);
    expect(active).toHaveLength(1);
    expect(active[0]!.inviteId).toBe(b.id); // الأحدث يفوز والأول أُلغي
    expect(a.usedCount).toBe(0);
    expect(b.usedCount).toBe(0); // الحجز لا يستهلك
  });

  it("★ مقعد الدعوة الأولى يتحرّر عند التحوّل إلى الثانية", () => {
    const db = new Db();
    db.addInvite({ code: "CODE-ALPHA-1", maxUses: 1 });
    db.addInvite({ code: "CODE-BETA-22", maxUses: 1 });

    db.authorize("CODE-ALPHA-1", "same@gmail.com");
    db.authorize("CODE-BETA-22", "same@gmail.com");

    // مقعد ألفا تحرّر، فيمكن لشخص آخر حجزه
    expect(db.authorize("CODE-ALPHA-1", "another@gmail.com")).toBe(true);
    db.assertOneActivePerEmail();
    expect(db.auths.filter((x) => !x.consumedAt && !x.revokedAt)).toHaveLength(2);
  });

  it("★ التسجيل يستهلك دعوة واحدة فقط بعد التحوّل", () => {
    const db = new Db();
    const a = db.addInvite({ code: "CODE-ALPHA-1", maxUses: 1 });
    const b = db.addInvite({ code: "CODE-BETA-22", maxUses: 1 });
    db.authorize("CODE-ALPHA-1", "same@gmail.com");
    db.authorize("CODE-BETA-22", "same@gmail.com");

    expect(handleNewUser(db, GOOGLE("same@gmail.com")).outcome).toBe("created");
    expect(a.usedCount + b.usedCount).toBe(1);
    expect(db.uses).toHaveLength(1);
  });

  it("★ الثابت محفوظ عبر تسلسل عمليات مختلط", () => {
    const db = new Db();
    db.addInvite({ code: "CODE-ALPHA-1", maxUses: 3 });
    db.addInvite({ code: "CODE-BETA-22", maxUses: 3 });
    const emails = ["a@gmail.com", "b@gmail.com", "a@gmail.com", "c@gmail.com", "b@gmail.com"];
    const codes = ["CODE-ALPHA-1", "CODE-BETA-22"];
    for (let i = 0; i < emails.length; i++) {
      db.authorize(codes[i % 2]!, emails[i]!);
      db.assertOneActivePerEmail(); // بعد كل خطوة لا في النهاية فقط
    }
    expect(db.auths.filter((x) => !x.consumedAt && !x.revokedAt)).toHaveLength(3);
  });

  it("★ إعادة المحاولة لا تستنزف المقاعد", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234", maxUses: 1 });
    for (let i = 0; i < 5; i++) {
      expect(db.authorize("INVITE-1234", "t@gmail.com"), `محاولة ${i}`).toBe(true);
    }
    const active = db.auths.filter((a) => !a.revokedAt && !a.consumedAt);
    expect(active).toHaveLength(1); // واحد نشط لا خمسة
  });

  it("★ دعوة ملغاة أو منتهية لا تُصدر تصريحًا", () => {
    const db = new Db();
    db.addInvite({ code: "REVOKED-1234", revoked: true });
    db.addInvite({ code: "EXPIRED-1234", expiresAt: db.now - 1 });
    expect(db.authorize("REVOKED-1234", "t@gmail.com")).toBe(false);
    expect(db.authorize("EXPIRED-1234", "t@gmail.com")).toBe(false);
    expect(db.auths).toHaveLength(0);
  });
});

describe("★ الحدود الأمنية", () => {
  it("★ ادّعاء provider=google في raw_user_meta_data لا يعمل", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "t@gmail.com");

    const r = handleNewUser(db, {
      id: "u1",
      email: "t@gmail.com",
      appMetaProvider: null,
      userMetaProvider: "google", // ← يكتبه العميل، لا يُقرأ
      termsAccepted: true,
    });
    expect(r.outcome).toBe("invite_required_or_invalid");
    expect(db.auths[0]!.consumedAt).toBeNull();
    expect(db.invites[0]!.usedCount).toBe(0);
  });

  it("★ لا مزوّد آخر يستفيد من التصريح", () => {
    for (const p of ["github", "apple", "azure", "facebook", "email", "GOOGLE", "google "]) {
      const db = new Db();
      db.addInvite({ code: "INVITE-1234" });
      db.authorize("INVITE-1234", "t@gmail.com");
      const r = handleNewUser(db, { id: "u1", email: "t@gmail.com", appMetaProvider: p });
      expect(r.outcome, `المزوّد ${p}`).not.toBe("created");
      expect(db.auths[0]!.consumedAt, `المزوّد ${p}`).toBeNull();
    }
  });

  it("★ صيغة بريد فاسدة تُرفض عند الإصدار", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    for (const bad of ["", "  ", "no-at-sign", "a@b", "a b@c.d", "@x.com", "x@.com"]) {
      expect(db.authorize("INVITE-1234", bad), bad).toBe(false);
    }
    expect(db.auths).toHaveLength(0);
  });

  it("★ كود قصير أو خاطئ لا يُصدر تصريحًا", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    expect(db.authorize("short", "t@gmail.com")).toBe(false);
    expect(db.authorize("WRONG-CODE-99", "t@gmail.com")).toBe(false);
    expect(db.auths).toHaveLength(0);
  });
});

describe("★ ما لم يتغيّر", () => {
  it("★ مسار البريد وكلمة المرور بدعوة صالحة كما هو", () => {
    const db = new Db();
    const inv = db.addInvite({ code: "INVITE-1234" });
    tickets.set("tkt-1", inv.id);

    const r = handleNewUser(db, {
      id: "u1",
      email: "t@example.com",
      appMetaProvider: "email",
      ticket: "tkt-1",
      termsAccepted: true,
    });
    expect(r.outcome).toBe("created");
    expect(r.consentRows).toBe(2); // الموافقة تُسجَّل لهذا المسار
    expect(inv.usedCount).toBe(1);
  });

  it("★ بريد وكلمة مرور بلا دعوة ⇒ مرفوض كما كان", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    expect(
      handleNewUser(db, {
        id: "u1",
        email: "t@example.com",
        appMetaProvider: "email",
        termsAccepted: true,
      }).outcome,
    ).toBe("invite_required_or_invalid");
  });

  it("★ بدعوة وبلا موافقة ⇒ consent_required", () => {
    const db = new Db();
    const inv = db.addInvite({ code: "INVITE-1234" });
    tickets.set("tkt-2", inv.id);
    expect(
      handleNewUser(db, {
        id: "u1",
        email: "t@example.com",
        appMetaProvider: "email",
        ticket: "tkt-2",
        termsAccepted: false,
      }).outcome,
    ).toBe("consent_required");
    expect(inv.usedCount).toBe(0); // التراجع
  });

  it("★ registration_closed يبقى قبل أي استهلاك", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "t@gmail.com");
    const snap = db.snapshot();
    const r = handleNewUser(db, GOOGLE("t@gmail.com"), {
      requireInvite: false,
      allowRegistration: false,
    });
    expect(r.outcome).toBe("registration_closed");
    expect(db.snapshot()).toBe(snap);
  });

  it("★ التسجيل العام لو فُتح: تجاوز بلا استهلاك تصريح (سلوك 0023)", () => {
    const db = new Db();
    db.addInvite({ code: "INVITE-1234" });
    db.authorize("INVITE-1234", "t@gmail.com");
    const r = handleNewUser(db, GOOGLE("t@gmail.com"), { allowRegistration: true });
    expect(r.outcome).toBe("created");
    expect(db.auths[0]!.consumedAt).toBeNull();
    expect(db.invites[0]!.usedCount).toBe(0);
  });
});
