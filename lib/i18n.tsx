"use client";

/**
 * طبقة لغة خفيفة: عربي (RTL) افتراضيًا + إنجليزي (LTR).
 * اللغة تُحفظ في Cookie ليقرأها الخادم ويضبط dir/lang قبل الرسم (بدون وميض).
 */

import { createContext, useCallback, useContext, useState } from "react";

export type Locale = "ar" | "en";

const dict = {
  appName: { ar: "YSD AI", en: "YSD AI" },
  tagline: { ar: "منصة الذكاء العربي", en: "Arabic-first AI platform" },
  newChat: { ar: "محادثة جديدة", en: "New chat" },
  searchPlaceholder: { ar: "بحث في المحادثات", en: "Search conversations" },
  conversations: { ar: "المحادثات", en: "Conversations" },
  noConversations: {
    ar: "لا توجد محادثات بعد.\nابدأ محادثتك الأولى.",
    en: "No conversations yet.\nStart your first chat.",
  },
  projects: { ar: "المشاريع", en: "Projects" },
  files: { ar: "الملفات", en: "Files" },
  settings: { ar: "الإعدادات", en: "Settings" },
  account: { ar: "الحساب والاستهلاك", en: "Account & usage" },
  comingSoon: { ar: "قريبًا", en: "Soon" },
  logout: { ar: "تسجيل الخروج", en: "Sign out" },
  collapseSidebar: { ar: "طي الشريط الجانبي", en: "Collapse sidebar" },
  send: { ar: "إرسال", en: "Send" },
  stop: { ar: "إيقاف", en: "Stop" },
  copy: { ar: "نسخ", en: "Copy" },
  copied: { ar: "✓ تم النسخ", en: "✓ Copied" },
  regenerate: { ar: "إعادة توليد", en: "Regenerate" },
  editMessage: { ar: "تعديل", en: "Edit" },
  save: { ar: "حفظ", en: "Save" },
  cancel: { ar: "إلغاء", en: "Cancel" },
  delete: { ar: "حذف", en: "Delete" },
  rename: { ar: "إعادة تسمية", en: "Rename" },
  confirmDelete: {
    ar: "هل تريد حذف هذه المحادثة؟",
    en: "Delete this conversation?",
  },
  composerPlaceholder: {
    ar: "اكتب رسالتك إلى YSD AI…",
    en: "Message YSD AI…",
  },
  disclaimer: {
    ar: "YSD AI قد يخطئ أحيانًا — تحقق من المعلومات المهمة",
    en: "YSD AI can make mistakes — verify important information",
  },
  welcomeSub: { ar: "وش تحب ننجز اليوم؟", en: "What shall we build today?" },
  greetingMorning: { ar: "صباح الخير", en: "Good morning" },
  greetingEvening: { ar: "مساء الخير", en: "Good evening" },
  sendError: {
    ar: "تعذّر الحصول على رد. تحقق من الاتصال وحاول مرة أخرى.",
    en: "Couldn't get a response. Check your connection and try again.",
  },
  retry: { ar: "إعادة المحاولة", en: "Retry" },
  freeTier: { ar: "الباقة المجانية", en: "Free plan" },
  plusTier: { ar: "باقة Plus", en: "Plus plan" },
  proTier: { ar: "باقة Pro", en: "Pro plan" },
  businessTier: { ar: "باقة الأعمال", en: "Business plan" },
  model: { ar: "النموذج", en: "Model" },
  theme: { ar: "المظهر", en: "Theme" },
  themeDark: { ar: "داكن", en: "Dark" },
  themeLight: { ar: "فاتح", en: "Light" },
  language: { ar: "اللغة", en: "Language" },
  defaultModel: { ar: "النموذج الافتراضي", en: "Default model" },
  displayName: { ar: "الاسم الظاهر", en: "Display name" },
  email: { ar: "البريد الإلكتروني", en: "Email" },
  password: { ar: "كلمة المرور", en: "Password" },
  login: { ar: "تسجيل الدخول", en: "Sign in" },
  loggingIn: { ar: "جارٍ الدخول…", en: "Signing in…" },
  register: { ar: "إنشاء حساب", en: "Create account" },
  registering: { ar: "جارٍ إنشاء الحساب…", en: "Creating account…" },
  forgotPassword: { ar: "نسيت كلمة المرور؟", en: "Forgot password?" },
  resetPassword: { ar: "إعادة تعيين كلمة المرور", en: "Reset password" },
  newPassword: { ar: "كلمة المرور الجديدة", en: "New password" },
  sendResetLink: { ar: "أرسل رابط الاستعادة", en: "Send reset link" },
  resetLinkSent: {
    ar: "إن كان البريد مسجلًا لدينا فستصلك رسالة استعادة خلال دقائق.",
    en: "If this email is registered, a reset link is on its way.",
  },
  noAccount: { ar: "ليس لديك حساب؟", en: "No account?" },
  haveAccount: { ar: "لديك حساب بالفعل؟", en: "Already have an account?" },
  loginFailed: {
    ar: "تعذّر تسجيل الدخول. تحقق من البريد وكلمة المرور.",
    en: "Sign-in failed. Check your email and password.",
  },
  registerFailed: {
    ar: "تعذّر إنشاء الحساب. جرّب بريدًا آخر أو كلمة مرور أقوى (٨ أحرف على الأقل).",
    en: "Couldn't create the account. Try another email or a stronger password (min 8 chars).",
  },
  confirmEmailSent: {
    ar: "أرسلنا رابط تأكيد إلى بريدك. افتحه لتفعيل حسابك ثم سجّل الدخول.",
    en: "We sent a confirmation link to your email. Open it, then sign in.",
  },
  usageThisMonth: { ar: "استهلاك هذا الشهر", en: "This month's usage" },
  messages: { ar: "الرسائل", en: "Messages" },
  tokens: { ar: "Tokens", en: "Tokens" },
  of: { ar: "من", en: "of" },
  saved: { ar: "تم الحفظ", en: "Saved" },
  profile: { ar: "الملف الشخصي", en: "Profile" },
  plan: { ar: "الباقة", en: "Plan" },
  comingSoonPage: {
    ar: "هذه الميزة قيد التطوير وستتوفر قريبًا.",
    en: "This feature is under development and coming soon.",
  },
  backToChat: { ar: "العودة إلى المحادثة", en: "Back to chat" },
  newProject: { ar: "مشروع جديد", en: "New project" },
  projectName: { ar: "اسم المشروع", en: "Project name" },
  projectDescription: { ar: "الوصف (اختياري)", en: "Description (optional)" },
  customInstructions: { ar: "تعليمات خاصة", en: "Custom instructions" },
  customInstructionsHint: {
    ar: "تُضاف هذه التعليمات لكل محادثة داخل المشروع",
    en: "Added to every conversation in this project",
  },
  deleteProject: { ar: "حذف المشروع", en: "Delete project" },
  confirmDeleteProject: {
    ar: "هل تريد حذف هذا المشروع؟ المحادثات المرتبطة ستبقى وسيُفك ربطها فقط.",
    en: "Delete this project? Linked conversations will be kept and unlinked.",
  },
  lastActivity: { ar: "آخر نشاط", en: "Last activity" },
  conversationsCount: { ar: "محادثة", en: "conversations" },
  filesCount: { ar: "ملف", en: "files" },
  linkConversation: { ar: "ربط محادثة موجودة", en: "Link existing conversation" },
  unlink: { ar: "فك الربط", en: "Unlink" },
  chatInProject: { ar: "محادثة جديدة في المشروع", en: "New chat in project" },
  noProjects: {
    ar: "لا توجد مشاريع بعد.\nأنشئ مشروعك الأول لتنظيم محادثاتك بتعليمات خاصة.",
    en: "No projects yet.\nCreate your first project to organize chats with custom instructions.",
  },
  noProjectConversations: {
    ar: "لا توجد محادثات في هذا المشروع بعد.",
    en: "No conversations in this project yet.",
  },
  searchProjects: { ar: "بحث في المشاريع", en: "Search projects" },
  sortRecent: { ar: "الأحدث نشاطًا", en: "Recent activity" },
  sortName: { ar: "الاسم", en: "Name" },
  projectNotFound: { ar: "المشروع غير موجود.", en: "Project not found." },
  loadError: {
    ar: "تعذّر تحميل البيانات. أعد المحاولة.",
    en: "Failed to load. Please retry.",
  },
  creating: { ar: "جارٍ الإنشاء…", en: "Creating…" },
  none: { ar: "بلا", en: "None" },
  backToProjects: { ar: "العودة إلى المشاريع", en: "Back to projects" },
  uploadFiles: { ar: "رفع ملفات", en: "Upload files" },
  dropFilesHere: {
    ar: "اسحب الملفات وأفلتها هنا، أو",
    en: "Drag & drop files here, or",
  },
  chooseFiles: { ar: "اختر ملفات", en: "Choose files" },
  allowedTypesHint: {
    ar: "PDF · DOCX · TXT · MD · PNG · JPG · WEBP",
    en: "PDF · DOCX · TXT · MD · PNG · JPG · WEBP",
  },
  uploading: { ar: "جارٍ الرفع…", en: "Uploading…" },
  cancelUpload: { ar: "إلغاء الرفع", en: "Cancel upload" },
  statusUploaded: { ar: "مرفوع", en: "Uploaded" },
  statusProcessing: { ar: "قيد المعالجة", en: "Processing" },
  statusReady: { ar: "جاهز", en: "Ready" },
  statusFailed: { ar: "فشل", en: "Failed" },
  retryProcess: { ar: "إعادة المعالجة", en: "Retry processing" },
  download: { ar: "تنزيل", en: "Download" },
  deleteFile: { ar: "حذف الملف", en: "Delete file" },
  confirmDeleteFile: {
    ar: "هل تريد حذف هذا الملف نهائيًا من التخزين؟",
    en: "Delete this file from storage?",
  },
  searchFiles: { ar: "بحث في الملفات", en: "Search files" },
  allTypes: { ar: "كل الأنواع", en: "All types" },
  allStatuses: { ar: "كل الحالات", en: "All statuses" },
  allProjects: { ar: "كل المشاريع", en: "All projects" },
  noProject: { ar: "بلا مشروع", en: "No project" },
  documents: { ar: "مستندات", en: "Documents" },
  images: { ar: "صور", en: "Images" },
  noFiles: {
    ar: "لا توجد ملفات بعد.\nارفع أول ملف لك (PDF، DOCX، TXT، صور).",
    en: "No files yet.\nUpload your first file (PDF, DOCX, TXT, images).",
  },
  storageUsage: { ar: "التخزين", en: "Storage" },
  extractedChars: { ar: "حرف مستخرج", en: "extracted chars" },
  noTextExtracted: { ar: "بلا نص (صورة)", en: "No text (image)" },
  attachFile: { ar: "إرفاق ملف", en: "Attach file" },
  attachmentNotice: {
    ar: "الملف رُفع وعولج وربُط بالمحادثة، لكنه لا يدخل سياق الذكاء الاصطناعي بعد (حتى تكتمل مرحلة RAG).",
    en: "File uploaded, processed, and linked to this chat — it won't enter the AI context until the RAG stage is complete.",
  },
  providerLimitNote: {
    ar: "الحد الأقصى الحالي للملف 50 ميجابايت بسبب قيود مزود التخزين.",
    en: "Current maximum file size is 50MB due to storage provider constraints.",
  },
  projectFiles: { ar: "ملفات المشروع", en: "Project files" },
  uploadToProject: { ar: "رفع ملف للمشروع", en: "Upload to project" },
  suggestions: {
    ar: [
      { title: "ساعدني في البرمجة", desc: "اكتب، اشرح، أو صحّح كودًا" },
      { title: "اكتب لي خطة مشروع", desc: "خطة عملية بمراحل واضحة" },
      { title: "لخّص هذا المستند", desc: "الصق نصًا وسألخّصه لك" },
      { title: "أنشئ فكرة تطبيق", desc: "عصف ذهني لفكرتك القادمة" },
    ],
    en: [
      { title: "Help me code", desc: "Write, explain, or fix code" },
      { title: "Draft a project plan", desc: "Practical plan with clear stages" },
      { title: "Summarize a document", desc: "Paste text and I'll summarize" },
      { title: "Brainstorm an app idea", desc: "Riff on your next idea" },
    ],
  },
} as const;

type DictKey = keyof typeof dict;

interface I18nContextValue {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: <K extends DictKey>(key: K) => (typeof dict)[K][Locale];
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = `ysd-locale=${l};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  }, []);

  const t = useCallback(
    <K extends DictKey>(key: K) => dict[key][locale] as (typeof dict)[K][Locale],
    [locale],
  );

  return (
    <I18nContext.Provider
      value={{ locale, dir: locale === "ar" ? "rtl" : "ltr", t, setLocale }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
