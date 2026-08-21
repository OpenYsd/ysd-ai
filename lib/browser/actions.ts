import "server-only";
import { z } from "zod";
import { appOrigin } from "./crypto";
import { BROWSER_ACTIONS, type BrowserActionName } from "./schema";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const proposalSchemas: Record<BrowserActionName, z.ZodTypeAny> = {
  find_tab: z.object({ query: z.string().min(1).max(256) }).strict(),
  open_tab: z.object({ url: z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u)) }).strict(),
  create_workspace: z.object({
    name: z.string().min(1).max(80),
    query: z.string().min(1).max(256),
  }).strict(),
  move_tabs: z.object({
    query: z.string().min(1).max(256),
    targetWorkspace: z.string().min(1).max(80),
  }).strict(),
};

const envelope = z.object({
  type: z.literal("browser_action_proposal"),
  action: z.enum(BROWSER_ACTIONS),
  arguments: z.unknown(),
}).strict();

export interface BrowserActionProposal {
  version: 1;
  id: string;
  action: BrowserActionName;
  sourceOrigin: string;
  tabSnapshotId: string;
  workspaceSnapshotId: string;
  createdAtUtc: string;
  arguments: unknown;
}

export function sanitizeActionProposal(
  raw: unknown,
  tabSnapshotId = "",
  workspaceSnapshotId = "",
  requestId?: string,
): BrowserActionProposal | null {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return null;
  const args = proposalSchemas[parsed.data.action].safeParse(parsed.data.arguments);
  if (!args.success) return null;
  return {
    version: 1,
    id: requestId && id.safeParse(requestId).success ? requestId : crypto.randomUUID().replace(/-/g, ""),
    action: parsed.data.action,
    sourceOrigin: appOrigin(),
    tabSnapshotId,
    workspaceSnapshotId,
    createdAtUtc: new Date().toISOString(),
    arguments: args.data,
  };
}

export function parseStructuredAssistantOutput(
  text: string,
  tabSnapshotId = "",
  workspaceSnapshotId = "",
  requestId?: string,
) {
  const marker = "```ysd-browser-action\n";
  const start = text.lastIndexOf(marker);
  if (start < 0 || (start > 0 && text[start - 1] !== "\n")) {
    return { message: text.trim(), action: null as BrowserActionProposal | null };
  }
  const before = text.slice(0, start).trim();
  const rest = text.slice(start + marker.length);
  const end = rest.indexOf("\n```");
  if (end < 0) return { message: text.trim(), action: null as BrowserActionProposal | null };
  try {
    return {
      message: before,
      action: sanitizeActionProposal(
        JSON.parse(rest.slice(0, end)),
        tabSnapshotId,
        workspaceSnapshotId,
        requestId,
      ),
    };
  } catch {
    return { message: before || text.trim(), action: null as BrowserActionProposal | null };
  }
}
