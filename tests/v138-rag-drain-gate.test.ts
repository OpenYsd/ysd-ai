import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * بوّابة التصريف — الإخفاق الحيّ: عدّة طلبات تجهيزٍ متوازية أعادت تشغيل خادم
 * التجربة (512 MB) فتوقّفت الوظائف بنبضٍ ميّت.
 *
 * ★ المقيس: تصريفٌ واحدٌ في آنٍ واحد، والطلبُ الثاني يعود فورًا دون أن يلتقط
 *   وظيفة — ووظيفتُه مُدرجةٌ قبل ذلك في الطابور، فلا تضيع.
 */

const jobs = vi.hoisted(() => ({
  claimRagJob: vi.fn(),
  enqueueRagJob: vi.fn(),
  getLatestJobForFile: vi.fn(),
}));

vi.mock("@/lib/rag/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rag/jobs")>();
  return { ...real, claimRagJob: jobs.claimRagJob, enqueueRagJob: jobs.enqueueRagJob, getLatestJobForFile: jobs.getLatestJobForFile };
});

import { activeDrainCount, MAX_CONCURRENT_DRAINS, tryAcquireDrainSlot } from "@/lib/rag/drain-gate";
import { deferredDrainCount, drainOwnJobs, MAX_DEFERRED_DRAINS } from "@/lib/rag/worker";

const fakeSupabase = {} as never;

beforeEach(() => {
  jobs.claimRagJob.mockReset();
  jobs.enqueueRagJob.mockReset();
  jobs.getLatestJobForFile.mockReset();
});

afterEach(() => {
  expect(activeDrainCount()).toBe(0);
});

describe("★ (١) البوّابة نفسها", () => {
  it("★ ★ ★ مكانٌ واحد: الثاني يُرفض حتى يُحرَّر الأوّل، والتحرير آمنٌ للتكرار", () => {
    expect(MAX_CONCURRENT_DRAINS).toBe(1);
    const release = tryAcquireDrainSlot();
    expect(release).not.toBeNull();
    expect(tryAcquireDrainSlot()).toBeNull();
    release!();
    release!();
    expect(activeDrainCount()).toBe(0);
    const again = tryAcquireDrainSlot();
    expect(again).not.toBeNull();
    again!();
  });
});

describe("★ (٢) drainOwnJobs — الإخفاق الحيّ: تصريفان متوازيان", () => {
  it("★ ★ ★ التصريف الثاني أثناء الأوّل يعود «مشغول» فورًا ولا يلتقط شيئًا", async () => {
    let finishClaim!: (v: null) => void;
    jobs.claimRagJob.mockImplementationOnce(() => new Promise((r) => (finishClaim = r)));

    const first = drainOwnJobs(fakeSupabase, { workerId: "req:first" });
    const second = await drainOwnJobs(fakeSupabase, { workerId: "req:second" });

    expect(second).toEqual({ processed: 0, lastStatus: null, busy: true });
    expect(jobs.claimRagJob).toHaveBeenCalledTimes(1);
    expect(jobs.claimRagJob).toHaveBeenCalledWith(fakeSupabase, "req:first");

    finishClaim(null);
    await expect(first).resolves.toEqual({ processed: 0, lastStatus: null, busy: false });
  });

  /**
   * ★ ولا يُنسى — مقيسٌ على staging: وظيفةٌ أُدرجت والبوّابةُ مشغولة انتظرت
   *   أربعَ دقائق حتى جاء طلبٌ تالٍ، وتنفيذُها سبعُ ثوانٍ.
   */
  it("★ ★ ★ ولا يُنسى: المؤجَّلُ يُعاد حين تتحرّر البوّابة — بجلسة صاحبه، بلا طلبٍ لاحق", async () => {
    const clientA = { user: "a" } as never;
    const clientB = { user: "b" } as never;
    let finishClaim!: (v: null) => void;
    jobs.claimRagJob.mockImplementationOnce(() => new Promise((r) => (finishClaim = r)));
    jobs.claimRagJob.mockResolvedValue(null);

    const first = drainOwnJobs(clientA, { workerId: "req:a" });
    const second = await drainOwnJobs(clientB, { workerId: "req:b" });
    expect(second.busy).toBe(true);
    expect(deferredDrainCount()).toBe(1);
    expect(jobs.claimRagJob).not.toHaveBeenCalledWith(clientB, "req:b");

    finishClaim(null);
    await first;
    await vi.waitFor(() => expect(jobs.claimRagJob).toHaveBeenCalledWith(clientB, "req:b"));
    await vi.waitFor(() => expect(activeDrainCount()).toBe(0));
    expect(deferredDrainCount()).toBe(0);
  });

  it("★ ★ ★ وقائمةُ الانتظار محدودة، ولا تتكرّر الجلسةُ نفسُها فيها", async () => {
    let finishClaim!: (v: null) => void;
    jobs.claimRagJob.mockImplementationOnce(() => new Promise((r) => (finishClaim = r)));
    jobs.claimRagJob.mockResolvedValue(null);
    const first = drainOwnJobs({ user: "holder" } as never, { workerId: "req:holder" });
    const same = { user: "same" } as never;
    await drainOwnJobs(same, { workerId: "req:s1" });
    await drainOwnJobs(same, { workerId: "req:s2" });
    expect(deferredDrainCount()).toBe(1);
    for (let i = 0; i < MAX_DEFERRED_DRAINS + 4; i++) await drainOwnJobs({ user: `u${i}` } as never, { workerId: `req:${i}` });
    expect(deferredDrainCount()).toBe(MAX_DEFERRED_DRAINS);
    finishClaim(null);
    await first;
    await vi.waitFor(() => expect(deferredDrainCount()).toBe(0));
    await vi.waitFor(() => expect(activeDrainCount()).toBe(0));
  });

  it("★ ★ ★ وتصريفٌ ينهار يُحرّر البوّابة — لا تبقى مغلقةً بعد خطأ", async () => {
    jobs.claimRagJob.mockRejectedValueOnce(new Error("db down"));
    await expect(drainOwnJobs(fakeSupabase, { workerId: "req:x" })).rejects.toThrow("db down");
    jobs.claimRagJob.mockResolvedValueOnce(null);
    await expect(drainOwnJobs(fakeSupabase, { workerId: "req:y" })).resolves.toMatchObject({ busy: false });
  });
});

describe("★ (٣) مسار /rag: الوظيفة تُدرج أوّلًا، والبوّابة المشغولة ⇒ 202 «في الطابور»", () => {
  const USER = "11111111-1111-4111-8111-111111111111";
  const FILE = "22222222-2222-4222-8222-222222222222";

  function client() {
    const builder = () => {
      const q: { cols?: string } = {};
      const b = {
        select(cols?: string) { q.cols = cols; return b; },
        eq() { return b; },
        is() { return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: async () => ({ data: { id: FILE, status: "ready", mime_type: "text/plain", extracted_text: "نصٌّ للتجهيز", rag_content_hash: null } }),
        single: async () => ({ data: { id: FILE, status: "ready", mime_type: "text/plain" } }),
      };
      return b;
    };
    return { auth: { getUser: async () => ({ data: { user: { id: USER } } }) }, from: builder };
  }

  it("★ ★ ★ enqueue قبل التصريف، و202 queued:true حين تصريفٌ آخر جارٍ", async () => {
    vi.resetModules();
    const drain = vi.fn(async () => ({ processed: 0, lastStatus: null, busy: true }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
    vi.doMock("@/lib/rate-limit-distributed", () => ({ BUCKET_RAG_RUN: "rag_run", consumeRateLimit: async () => ({ allowed: true }) }));
    vi.doMock("@/lib/rag/worker", () => ({ drainOwnJobs: drain, LEASE_SECONDS: 120 }));
    jobs.enqueueRagJob.mockResolvedValue({ job: { id: "j1", status: "queued" }, created: true });
    jobs.getLatestJobForFile.mockResolvedValue({ id: "j1", status: "queued" });

    const { POST } = await import("@/app/api/files/[id]/rag/route");
    const res = await POST(new Request("http://x/api/files/f/rag", { method: "POST" }) as never, { params: Promise.resolve({ id: FILE }) });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: boolean; job: { status: string } };
    expect(body.queued).toBe(true);
    expect(body.job.status).toBe("queued");
    expect(jobs.enqueueRagJob).toHaveBeenCalledTimes(1);
    // الوظيفة في الطابور (مصدر الحقيقة) قبل أيّ محاولة تصريف — فلا تضيع حين تكون البوّابة مشغولة
    expect(jobs.enqueueRagJob.mock.invocationCallOrder[0]!).toBeLessThan(drain.mock.invocationCallOrder[0]!);

    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("@/lib/rate-limit-distributed");
    vi.doUnmock("@/lib/rag/worker");
  });
});
