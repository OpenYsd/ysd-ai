import { parseEvidenceMarkers } from "@/lib/evidence/marker-parser";

/**
 * ربط `segmentIndex` بمواضعه في Markdown (v0.9.0، الإيداع الثامن).
 *
 * ── لماذا لا يُقسَّم النصّ ──
 *
 * أبسط ما يخطر: `split("\n\n")` ثم عرض كل جزء وحده. وهو يكسر Markdown فعلًا لا
 * احتمالًا: القائمة «الفضفاضة» (بسطر فارغ بين عناصرها) قائمةٌ **واحدة** في
 * Markdown وفقرتان عند مُحلِّلنا — فالتقسيم يحوّلها إلى قائمتين، ويبدأ ترقيم
 * الثانية من واحد. والجداول وblockquotes وأسوار الشيفرة تنكسر بالمثل.
 *
 * ── الطريقة المستعملة ──
 *
 * لا يُمسّ النصّ إطلاقًا. تُوسَم **عُقد المستوى الأعلى** في شجرة mdast بسمة
 * `data-ysd-segment`، فتصل إلى العنصر المعروض ويقرأها المكوّن.
 *
 * والربط عبر أرقام الأسطر: `lineSegments` من المُحلِّل يقول لأي فقرة ينتمي كل
 * سطر، و`node.position.start.line` يقول أين تبدأ كل عقدة. فالتقسيم تعريفٌ
 * واحد في مكان واحد، ولا يمكن للواجهة أن تفترق عنه.
 *
 * ── ولماذا العقدة الأخيرة وحدها ──
 *
 * الفقرة الواحدة قد تُنتج عدة عقد (فقرة نصّية يليها سياج شيفرة بلا سطر فارغ).
 * ووسمُها كلها يُنتج صفّ أزرار مكرّرًا. فيُوسم آخرها: الزرّ يقع بعد الكتلة
 * كاملةً، وهو موضعه الطبيعي في القراءة.
 */

/** عقدة mdast — ما نحتاجه منها فقط */
interface MdastNode {
  type: string;
  position?: { start?: { line?: number }; end?: { line?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

interface MdastRoot {
  children?: MdastNode[];
}

/** سمة الوسم — يقرأها المكوّن من خصائص العنصر */
export const SEGMENT_ATTR = "data-ysd-segment";

/**
 * يبني إضافة remark تُوسم بها عقد المستوى الأعلى.
 *
 * `lineSegments` يأتي من `parseEvidenceMarkers` على **نفس النصّ** المعروض.
 */
export function remarkEvidenceSegments(lineSegments: (number | null)[]) {
  return function transformer(tree: MdastRoot): void {
    const children = Array.isArray(tree.children) ? tree.children : [];

    // آخر عقدة لكل فقرة — هي وحدها التي تُوسم
    const lastNodeForSegment = new Map<number, MdastNode>();
    for (const node of children) {
      const line = node.position?.start?.line;
      if (typeof line !== "number") continue;
      const segment = lineSegments[line - 1]; // mdast يعدّ من 1
      if (segment === null || segment === undefined) continue;
      lastNodeForSegment.set(segment, node);
    }

    for (const [segment, node] of lastNodeForSegment) {
      node.data = node.data ?? {};
      node.data.hProperties = {
        ...(node.data.hProperties ?? {}),
        [SEGMENT_ATTR]: String(segment),
      };
    }
  };
}

/**
 * يقرأ رقم الفقرة من خصائص عنصر معروض.
 *
 * يُعيد `null` لغير الموسوم — أي لكل عقدة ليست آخر عقدة في فقرتها، ولكل عقدة
 * داخلية. وبذلك لا يتكرر الصفّ ولا يظهر داخل عنصر قائمة أو خلية جدول.
 */
export function readSegmentAttr(props: Record<string, unknown>): number | null {
  return parseSegment(props[SEGMENT_ATTR]);
}

function parseSegment(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** عقدة hast — ما نحتاجه منها فقط */
interface HastElement {
  properties?: Record<string, unknown>;
  children?: HastElement[];
}

/**
 * يقرأ رقم الفقرة من عقدة hast — **وعبر ابنها الأول عند اللزوم**.
 *
 * سياج الشيفرة عقدة `code` في mdast تتحوّل إلى `<pre><code>`. و`hProperties`
 * تُوضع على الداخلي (`code`) لا على الغلاف (`pre`)، فقراءةُ خصائص `pre` وحدها
 * كانت تُعيد لا شيء ويسقط صفّ الأزرار عن كل كتلة شيفرة. (كشفه الاختبار.)
 */
export function readSegmentFromNode(node: unknown): number | null {
  const el = node as HastElement | undefined;
  if (!el || typeof el !== "object") return null;

  const own = el.properties;
  if (own) {
    const direct = parseSegment(own[SEGMENT_ATTR] ?? own["dataYsdSegment"]);
    if (direct !== null) return direct;
  }

  const first = Array.isArray(el.children) ? el.children[0] : undefined;
  const childProps = first?.properties;
  if (!childProps) return null;
  return parseSegment(childProps[SEGMENT_ATTR] ?? childProps["dataYsdSegment"]);
}

/**
 * تقسيم النصّ المعروض إلى فقرات.
 *
 * يُستدعى على **النصّ النظيف المحفوظ** (بلا علامات). والتقسيم يبقى مطابقًا
 * لما حُسب وقت الإجابة: إزالة العلامات لا تُنشئ سطرًا فارغًا ولا تمحوه، وما
 * تُفرغه من فقرات يسقط في المرورين معًا — فتتطابق الأرقام.
 */
export function segmentLinesFor(text: string): (number | null)[] {
  return parseEvidenceMarkers(text).lineSegments;
}
