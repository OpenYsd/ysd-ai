/** تحقق أن استخراج النص من PDF/DOCX المولّدين يعمل ويحفظ الصفحات */
import { readFileSync } from "node:fs";

// نستدعي منطق الاستخراج نفسه المستخدم في التطبيق
async function extractPdf(buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => (p ?? "").trim());
  return { pages, totalPages };
}

async function extractDocx(buffer) {
  const mammoth = await import("mammoth");
  const r = await mammoth.extractRawText({ buffer });
  return r.value.trim();
}

const pdfBuf = readFileSync(new URL("./.fixtures/doc-ar.pdf", import.meta.url));
const { pages, totalPages } = await extractPdf(pdfBuf);
console.log(`\n=== PDF ===`);
console.log(`الصفحات: ${totalPages}`);
pages.forEach((p, i) => console.log(`  ص${i + 1}: ${p.slice(0, 90).replace(/\s+/g, " ")}`));
console.log(`ALPHA-1122 في ص1: ${pages[0]?.includes("ALPHA-1122")}`);
console.log(`"ريم الفيصل" في ص2: ${pages[1]?.includes("ريم الفيصل")}`);
console.log(`"نوفمبر" في ص3: ${pages[2]?.includes("نوفمبر")}`);

const docxBuf = readFileSync(new URL("./.fixtures/doc-ar.docx", import.meta.url));
const docxText = await extractDocx(docxBuf);
console.log(`\n=== DOCX ===`);
console.log(`  ${docxText.slice(0, 140).replace(/\s+/g, " ")}`);
console.log(`LIC-9087 موجود: ${docxText.includes("LIC-9087")}`);
console.log(`"ثلاثون يومًا" موجود: ${docxText.includes("ثلاثون")}`);
