/**
 * اختبارات تحسينات الأداء v0.6.4:
 * سياق الطلب المُتحقَّق، منع انتحال x-ysd-*، وكاش platform_settings.
 * لا تلمس شبكة ولا Supabase حقيقيًا — mock نقي.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_HEADERS,
  INTERNAL_HEADER_NAMES,
  getRequestContext,
  stripInternalHeaders,
} from "../lib/auth/request-context";
import {
  _settingsCacheState,
  getCachedSettings,
  invalidateSettingsCache,
} from "../lib/settings";

const UUID = "11111111-2222-4333-8444-555555555555";

// ---------- منع انتحال الترويسات الداخلية ----------
describe("stripInternalHeaders — الحماية ضد الانتحال", () => {
  it("ينزع كل x-ysd-* واردة من العميل", () => {
    const incoming = new Headers({
      "x-ysd-user-id": "victim-id",
      "x-ysd-role": "owner",
      "x-ysd-status": "active",
      "x-ysd-request-id": "forged",
      "content-type": "application/json",
    });
    const clean = stripInternalHeaders(incoming);
    for (const h of INTERNAL_HEADER_NAMES) expect(clean.get(h)).toBeNull();
    // الترويسات الأخرى تبقى
    expect(clean.get("content-type")).toBe("application/json");
  });

  it("لا يعدّل الترويسات الأصلية (يعيد نسخة)", () => {
    const incoming = new Headers({ "x-ysd-role": "owner" });
    stripInternalHeaders(incoming);
    expect(incoming.get("x-ysd-role")).toBe("owner"); // الأصل سليم
  });

  it("القائمة تشمل كل ترويسات x-ysd-* المعروفة", () => {
    expect(INTERNAL_HEADER_NAMES).toContain("x-ysd-user-id");
    expect(INTERNAL_HEADER_NAMES).toContain("x-ysd-role");
    expect(INTERNAL_HEADER_NAMES).toContain("x-ysd-status");
  });
});

// ---------- getRequestContext ----------
function mockSupabase(user: { id: string } | null, profile: { role: string; status: string } | null) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: profile }) }) }),
    })),
  } as never;
}

describe("getRequestContext", () => {
  it("★ المسار السريع: ترويسات صالحة → سياق بلا أي استدعاء شبكي", async () => {
    const sb = mockSupabase(null, null); // لو استُدعي getUser لظهر null
    const h = new Headers({
      [INTERNAL_HEADERS.userId]: UUID,
      [INTERNAL_HEADERS.role]: "user",
      [INTERNAL_HEADERS.status]: "active",
    });
    const ctx = await getRequestContext(h, sb);
    expect(ctx).toEqual({ userId: UUID, role: "user", status: "active" });
    expect((sb as { auth: { getUser: ReturnType<typeof vi.fn> } }).auth.getUser).not.toHaveBeenCalled();
  });

  it("★ userId غير UUID (انتحال محتمل) → لا يُوثق به، يسقط للتحقق الشبكي", async () => {
    const sb = mockSupabase({ id: "real-user" }, { role: "user", status: "active" });
    const h = new Headers({
      [INTERNAL_HEADERS.userId]: "not-a-uuid",
      [INTERNAL_HEADERS.role]: "owner", // محاولة تصعيد
      [INTERNAL_HEADERS.status]: "active",
    });
    const ctx = await getRequestContext(h, sb);
    // النتيجة من الشبكة (real-user/user) لا من الترويسة المزوّرة (owner)
    expect(ctx).toEqual({ userId: "real-user", role: "user", status: "active" });
    expect((sb as { auth: { getUser: ReturnType<typeof vi.fn> } }).auth.getUser).toHaveBeenCalled();
  });

  it("سقوط ترويسة (role مفقود) → تحقق شبكي آمن", async () => {
    const sb = mockSupabase({ id: "u1" }, { role: "user", status: "active" });
    const h = new Headers({ [INTERNAL_HEADERS.userId]: UUID }); // بلا role/status
    const ctx = await getRequestContext(h, sb);
    expect(ctx?.userId).toBe("u1");
    expect((sb as { auth: { getUser: ReturnType<typeof vi.fn> } }).auth.getUser).toHaveBeenCalled();
  });

  it("fallback: لا جلسة → null (غير مصرّح)", async () => {
    const sb = mockSupabase(null, null);
    expect(await getRequestContext(new Headers(), sb)).toBeNull();
  });

  it("fallback: توكن صالح لكن بلا profile (محذوف) → null", async () => {
    const sb = mockSupabase({ id: "u1" }, null);
    expect(await getRequestContext(new Headers(), sb)).toBeNull();
  });

  it("يمرّر الحالة كما هي: banned و ai_suspended", async () => {
    for (const status of ["banned", "ai_suspended", "active"]) {
      const h = new Headers({
        [INTERNAL_HEADERS.userId]: UUID,
        [INTERNAL_HEADERS.role]: "user",
        [INTERNAL_HEADERS.status]: status,
      });
      const ctx = await getRequestContext(h, mockSupabase(null, null));
      expect(ctx?.status).toBe(status);
    }
  });
});

// ---------- كاش platform_settings ----------
function settingsClient(rows: { key: string; value: unknown }[], spy?: ReturnType<typeof vi.fn>) {
  return {
    from: vi.fn(() => ({
      select: () => {
        spy?.();
        return Promise.resolve({ data: rows });
      },
    })),
  } as never;
}

describe("كاش platform_settings", () => {
  beforeEach(() => invalidateSettingsCache());

  it("يقرأ من القاعدة أول مرة ثم من الكاش", async () => {
    const spy = vi.fn();
    const sb = settingsClient([{ key: "maintenance_mode", value: false }], spy);
    await getCachedSettings(sb, 1000);
    await getCachedSettings(sb, 1000);
    await getCachedSettings(sb, 1000);
    expect(spy).toHaveBeenCalledTimes(1); // استعلام واحد فقط
  });

  it("★ ينتهي بعد 30 ثانية فيُعاد الاستعلام", async () => {
    const spy = vi.fn();
    const sb = settingsClient([{ key: "maintenance_mode", value: false }], spy);
    await getCachedSettings(sb, 1000);
    await getCachedSettings(sb, 1000 + 29_000); // ضمن النافذة
    expect(spy).toHaveBeenCalledTimes(1);
    await getCachedSettings(sb, 1000 + 31_000); // بعد الانتهاء
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("★ invalidate يمسح الكاش فورًا (تعديل من لوحة الإدارة)", async () => {
    const spy = vi.fn();
    const sb = settingsClient([{ key: "maintenance_mode", value: true }], spy);
    await getCachedSettings(sb, 1000);
    expect(spy).toHaveBeenCalledTimes(1);
    invalidateSettingsCache();
    expect(_settingsCacheState()).toBeNull();
    await getCachedSettings(sb, 1000); // نفس اللحظة لكن الكاش مُبطَل
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("يحوّل الصفوف إلى خريطة key→value", async () => {
    const sb = settingsClient([
      { key: "maintenance_mode", value: true },
      { key: "require_invite", value: true },
    ]);
    const s = await getCachedSettings(sb, 1000);
    expect(s.maintenance_mode).toBe(true);
    expect(s.require_invite).toBe(true);
  });
});
