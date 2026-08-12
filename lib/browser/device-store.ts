import "server-only";
import { getAdminClient } from "@/lib/supabase/admin";
import { randomCode, sha256Hex, userCode } from "./crypto";
import { DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS } from "./schema";

type Status = "pending" | "approved" | "denied" | "consumed";

export interface DeviceRecord {
  deviceCodeHash: string;
  userCode: string;
  clientId: string;
  codeChallenge: string;
  state: string;
  status: Status;
  userId: string | null;
  expiresAt: string;
  lastPollAt: string | null;
  pollCount: number;
}

const memory = new Map<string, DeviceRecord>();

function sweep() {
  const now = Date.now();
  for (const [key, value] of memory) {
    if (new Date(value.expiresAt).getTime() <= now) memory.delete(key);
  }
}

export async function createDeviceAuthorization(input: {
  clientId: string;
  codeChallenge: string;
  state: string;
}) {
  sweep();
  const deviceCode = randomCode(64);
  const deviceCodeHash = sha256Hex(deviceCode);
  const record: DeviceRecord = {
    deviceCodeHash,
    userCode: userCode(),
    clientId: input.clientId,
    codeChallenge: input.codeChallenge,
    state: input.state,
    status: "pending",
    userId: null,
    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000).toISOString(),
    lastPollAt: null,
    pollCount: 0,
  };

  const admin = getAdminClient();
  if (admin) {
    const { error } = await admin.from("browser_device_authorizations").insert({
      device_code_hash: record.deviceCodeHash,
      user_code: record.userCode,
      client_id: record.clientId,
      code_challenge: record.codeChallenge,
      state: record.state,
      status: record.status,
      expires_at: record.expiresAt,
      poll_count: 0,
    });
    if (!error) return { deviceCode, record, storage: "db" as const };
    console.warn(`[browser-auth] device_store=memory reason=${error.code ?? "db_error"}`);
  }

  memory.set(deviceCodeHash, record);
  return { deviceCode, record, storage: "memory" as const };
}

function mapRow(row: Record<string, unknown>): DeviceRecord {
  return {
    deviceCodeHash: String(row.device_code_hash),
    userCode: String(row.user_code),
    clientId: String(row.client_id),
    codeChallenge: String(row.code_challenge),
    state: String(row.state),
    status: String(row.status) as Status,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    expiresAt: String(row.expires_at),
    lastPollAt: typeof row.last_poll_at === "string" ? row.last_poll_at : null,
    pollCount: Number(row.poll_count) || 0,
  };
}

export async function getDeviceByUserCode(userCodeValue: string): Promise<DeviceRecord | null> {
  const admin = getAdminClient();
  if (admin) {
    const { data, error } = await admin
      .from("browser_device_authorizations")
      .select("*")
      .eq("user_code", userCodeValue)
      .maybeSingle();
    if (!error && data) return mapRow(data as Record<string, unknown>);
  }
  sweep();
  return [...memory.values()].find((r) => r.userCode === userCodeValue) ?? null;
}

export async function getDeviceByCode(deviceCode: string): Promise<DeviceRecord | null> {
  const hash = sha256Hex(deviceCode);
  const admin = getAdminClient();
  if (admin) {
    const { data, error } = await admin
      .from("browser_device_authorizations")
      .select("*")
      .eq("device_code_hash", hash)
      .maybeSingle();
    if (!error && data) return mapRow(data as Record<string, unknown>);
  }
  sweep();
  return memory.get(hash) ?? null;
}

export async function markUserDecision(record: DeviceRecord, userId: string, decision: "approve" | "deny") {
  const status: Status = decision === "approve" ? "approved" : "denied";
  const admin = getAdminClient();
  if (admin) {
    await admin
      .from("browser_device_authorizations")
      .update({ status, user_id: userId, authorized_at: new Date().toISOString() })
      .eq("device_code_hash", record.deviceCodeHash)
      .eq("status", "pending");
  }
  const existing = memory.get(record.deviceCodeHash);
  if (existing) memory.set(record.deviceCodeHash, { ...existing, status, userId });
}

export async function recordPoll(record: DeviceRecord) {
  const now = new Date();
  const admin = getAdminClient();
  if (admin) {
    await admin
      .from("browser_device_authorizations")
      .update({ poll_count: record.pollCount + 1, last_poll_at: now.toISOString() })
      .eq("device_code_hash", record.deviceCodeHash);
  }
  const existing = memory.get(record.deviceCodeHash);
  if (existing) memory.set(record.deviceCodeHash, { ...existing, pollCount: existing.pollCount + 1, lastPollAt: now.toISOString() });
}

export async function consumeDevice(record: DeviceRecord) {
  const admin = getAdminClient();
  if (admin) {
    await admin
      .from("browser_device_authorizations")
      .update({ status: "consumed", consumed_at: new Date().toISOString() })
      .eq("device_code_hash", record.deviceCodeHash)
      .eq("status", "approved");
  }
  const existing = memory.get(record.deviceCodeHash);
  if (existing) memory.set(record.deviceCodeHash, { ...existing, status: "consumed" });
}

export function isExpired(record: DeviceRecord) {
  return new Date(record.expiresAt).getTime() <= Date.now();
}

export function shouldSlowDown(record: DeviceRecord) {
  if (!record.lastPollAt) return false;
  return Date.now() - new Date(record.lastPollAt).getTime() < DEVICE_POLL_INTERVAL_SECONDS * 1000;
}
