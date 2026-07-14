/**
 * توليد ملفات اختبار حقيقية: PDF عربي متعدد الصفحات + DOCX عربي.
 * PDF عبر pdf-lib + خط Windows العربي (arial.ttf).
 * DOCX عبر jszip (بنية Word أدنى صحيحة).
 * التشغيل: node scripts/make-fixtures.mjs  → يكتب في scripts/.fixtures/
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import JSZip from "jszip";

const OUT = new URL("./.fixtures/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// ===== PDF: 3 صفحات، حقيقة فريدة لكل صفحة =====
// حقائق عربية خالصة لكل صفحة (يُتجنّب اللاتيني لأن pdf-lib يعكسه داخل RTL)
const PDF_PAGES = [
  {
    title: "الصفحة الأولى - المنتج",
    body: "اسم المنتج الرئيسي في النظام هو الصقر الذهبي، وهو مخصص للمؤسسات الكبيرة فقط.",
  },
  {
    title: "الصفحة الثانية - الإدارة",
    body: "اسم المدير التنفيذي للمنصة هو ريم الفيصل، وهي المسؤولة عن القرارات الاستراتيجية.",
  },
  {
    title: "الصفحة الثالثة - المواعيد",
    body: "الموعد النهائي لإطلاق النسخة التجارية هو الثلاثون من شهر نوفمبر لعام ألفين وستة وعشرين.",
  },
];

const fontBytes = readFileSync("C:/Windows/Fonts/arial.ttf");
const pdf = await PDFDocument.create();
pdf.registerFontkit(fontkit);
const font = await pdf.embedFont(fontBytes, { subset: true });

for (const p of PDF_PAGES) {
  const page = pdf.addPage([595, 842]); // A4
  // نرسم بترتيب منطقي؛ الاستخراج يعتمد ToUnicode لا الاتجاه البصري
  page.drawText(p.title, { x: 60, y: 780, size: 20, font });
  page.drawText(p.body, { x: 60, y: 720, size: 14, font });
  page.drawText("YSD AI Internal Document", { x: 60, y: 60, size: 10, font });
}
const pdfBytes = await pdf.save();
writeFileSync(new URL("doc-ar.pdf", OUT), pdfBytes);
console.log(`PDF: ${PDF_PAGES.length} صفحات، ${pdfBytes.length} بايت`);

// ===== DOCX: محتوى عربي بحقائق فريدة =====
const DOCX_PARAS = [
  "وثيقة سياسات منصة YSD AI الرسمية.",
  "رقم الترخيص التشغيلي للمنصة هو LIC-9087-YSD ويجب ذكره في المراسلات الرسمية.",
  "مدة الاشتراك الافتراضية في الباقة المجانية هي ثلاثون يومًا قابلة للتجديد.",
  "الحد الأقصى لعدد المشاريع في الباقة المجانية هو خمسة مشاريع لكل مستخدم.",
  "تلتزم المنصة بحماية خصوصية المستخدمين وعدم مشاركة بياناتهم مع أطراف خارجية.",
];
const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
);
zip.file(
  "_rels/.rels",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
);
const paras = DOCX_PARAS.map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join("");
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paras}</w:body></w:document>`,
);
const docxBytes = await zip.generateAsync({ type: "nodebuffer" });
writeFileSync(new URL("doc-ar.docx", OUT), docxBytes);
console.log(`DOCX: ${DOCX_PARAS.length} فقرات، ${docxBytes.length} بايت`);
