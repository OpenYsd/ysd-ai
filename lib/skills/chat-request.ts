import "server-only";

/**
 * حلّ معامل `skill` في صفحة المحادثة — على الخادم وحده (المرحلة 3B).
 *
 * المعامل نصٌّ من رابطٍ قد يصنعه أيّ أحد، فيُعامل كمدخلٍ غير موثوق: شكلُه يُفحص قبل البحث،
 * ثم يُحلّ على السجلّ المدمج المتحقَّق منه، ثم على سياسة الصلاحيات نفسها التي تعرضها صفحة
 * المهارة. لا يعبر إلى العميل إلا نتيجةٌ مغلقة — ولا يُعاد المعامل الخام إليه أبدًا.
 */

import { SKILL_ID_PATTERN } from "./manifest";
import { evaluateSkill } from "./permissions";
import { builtInSkillRegistry } from "./registry";
import type { SkillChatRequest } from "./chat-draft";

/** أطول معرّفٍ يقبله البيان — ما زاد عليه مشوَّهٌ قبل أي بحث */
const MAX_SKILL_ID_LENGTH = 48;

/**
 * `null`: لا معامل أصلًا — صفحة المحادثة كما كانت. والمعامل المكرّر (`?skill=a&skill=b`)
 * غامضٌ فيُرفض ولا يُختار أحدهما.
 */
export function resolveSkillChatRequest(raw: string | string[] | undefined): SkillChatRequest | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length > MAX_SKILL_ID_LENGTH || !SKILL_ID_PATTERN.test(raw)) {
    return { ok: false, reason: "unknown" };
  }
  const skill = builtInSkillRegistry().get(raw);
  if (!skill) return { ok: false, reason: "unknown" };
  // مسار المحادثة نصّيٌّ بحت: كل صلاحيات المهارة يجب أن تكون مسموحةً اليوم بلا منح
  if (!evaluateSkill(skill).executable) return { ok: false, reason: "unsupported" };
  return { ok: true, id: skill.id, name: skill.name, instructions: skill.instructions };
}
