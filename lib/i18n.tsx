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

  /* ── إذن المساهمة في تحسين YSD (v0.9.4) ── */
  trainingConsentSection: {
    ar: "الخصوصية وتحسين YSD",
    en: "Privacy & YSD Improvement",
  },
  trainingConsentTitle: {
    ar: "ساعد في تحسين YSD",
    en: "Help improve YSD",
  },
  trainingConsentDescription: {
    ar: "اسمح لـ YSD باستخدام المحادثات التي تختار مشاركتها للمساعدة في تحسين نماذجه المستقبلية.",
    en: "Allow YSD to use conversations you choose to share to help improve future YSD models.",
  },
  /**
   * ★ نصٌّ يقول ما لا يقع كما يقول ما يقع.
   *
   * فلو كُتب «ستُستخدم محادثاتك» لَوافق الناس على شيءٍ لا يجري، ثم شعروا
   * بالخديعة يوم يجري غيره. و«التي تختار مشاركتها» هي التصميم نفسه.
   */
  trainingConsentNotice: {
    ar: "لن يؤدي تشغيل هذا الخيار إلى تدريب النموذج مباشرة على كل رسالة، ولن تُستخدم محادثاتك السابقة بأثر رجعي.",
    en: "Turning this on does not train the model directly on every message, and your previous conversations are not included retroactively.",
  },
  trainingConsentReversible: {
    ar: "يمكنك إيقاف المشاركة في أي وقت.",
    en: "You can turn sharing off at any time.",
  },
  trainingConsentReconsent: {
    ar: "تحتاج إلى الموافقة مجددًا على سياسة المشاركة الحالية.",
    en: "You need to consent again to the current sharing policy.",
  },
  trainingConsentOn: { ar: "تم تفعيل المشاركة.", en: "Sharing enabled." },
  trainingConsentOff: { ar: "تم إيقاف المشاركة.", en: "Sharing disabled." },
  trainingConsentError: {
    ar: "تعذّر تحديث إعداد المشاركة. حاول مرة أخرى.",
    en: "Could not update sharing preference. Please try again.",
  },

  /* ── مشاركة محادثةٍ مع بنك تحسين YSD (v0.9.5) ── */
  /**
   * ★ «لتحسين YSD» جزءٌ من الاسم لا زينة.
   *
   * «شارك هذه المحادثة» وحدها تُقرأ تصديرًا أو رابطًا عامًّا — وهي أشيع
   * معاني الكلمة في التطبيقات. فتُقيَّد بوجهتها في كل موضع تظهر فيه.
   */
  shareForTraining: {
    ar: "شارك هذه المحادثة لتحسين YSD",
    en: "Share this conversation to improve YSD",
  },
  shareForTrainingConfirmTitle: {
    ar: "مشاركة المحادثة لتحسين YSD؟",
    en: "Share this conversation to improve YSD?",
  },
  shareForTrainingConfirmBody: {
    ar: "سيتم إرسال الأجزاء المؤهلة من هذه المحادثة التي أُنشئت بعد موافقتك إلى بنك تحسين YSD للفحص قبل أي استخدام تدريبي.",
    en: "Eligible parts of this conversation created after your consent will be sent to the YSD improvement bank for review before any training use.",
  },
  shareForTrainingConfirmNote: {
    ar: "لن يتم تدريب النموذج مباشرةً، ولن تُضمّن الرسائل الأقدم من وقت موافقتك.",
    en: "The model is not trained directly, and messages older than your consent are not included.",
  },
  shareForTrainingConfirmAction: { ar: "مشاركة", en: "Share" },
  shareForTrainingCancel: { ar: "إلغاء", en: "Cancel" },
  shareForTrainingClose: { ar: "إغلاق", en: "Close" },
  /**
   * ★ «للمراجعة» — لا «تم التدريب».
   *
   * ما يقع فعلًا أن العيّنات تدخل موقوفةً بانتظار فحص. وقولُ «تم تدريب
   * YSD» يصف شيئًا لم يحدث، ويجعل صاحبه يظنّ أن سحب إذنه لاحقًا لا يُجدي.
   */
  shareForTrainingSuccess: {
    ar: "تمت إضافة الأجزاء المؤهلة إلى بنك تحسين YSD للمراجعة.",
    en: "Eligible parts were added to the YSD improvement bank for review.",
  },
  shareForTrainingNothingNew: {
    ar: "تمت مراجعة المحادثة، ولا توجد أجزاء جديدة لإضافتها.",
    en: "This conversation was reviewed, and there are no new parts to add.",
  },
  shareForTrainingOlderSkipped: {
    ar: "تم تجاهل الرسائل الأقدم من وقت موافقتك.",
    en: "Messages older than your consent were skipped.",
  },
  shareForTrainingConsentRequired: {
    ar: "لتفعيل المشاركة، افتح الإعدادات وشغّل «ساعد في تحسين YSD».",
    en: "To enable sharing, open Settings and turn on “Help improve YSD”.",
  },
  shareForTrainingError: {
    ar: "تعذّرت المشاركة. حاول مرة أخرى.",
    en: "Could not share the conversation. Please try again.",
  },

  /* ── مراجعة بنك تحسين YSD (v0.9.5) ── */
  trainingBankTitle: { ar: "بنك تحسين YSD", en: "YSD Training Bank" },
  trainingBankSubtitle: {
    ar: "مراجعة يدوية للعيّنات التي شاركها المستخدمون. يُعاد التحقّق من المصدر قبل كل قرار.",
    en: "Manual review of samples users shared. The source is revalidated before every decision.",
  },
  /**
   * ★ «معتمَدة» ليست «مُدرَّبة» — والنصّ يقولها حيث يُقرأ الرقم.
   *
   * فمن يرى عمودًا اسمه «معتمَدة» يقرأه على معناه في اللغة العامّة: أن
   * شيئًا صار نافذًا. وما يقع فعلًا أن العيّنة صارت مؤهَّلةً للنظر.
   */
  trainingBankApprovedMeaning: {
    ar: "«معتمَدة» تعني مؤهَّلة للنظر في مجموعة تدريب مستقبلية. لا تصدير، ولا تدريب، ولا تحديث نموذج.",
    en: "“Approved” means eligible for consideration in a future training set. No export, no training, no model update.",
  },
  trainingBankCount_pending: { ar: "قيد المراجعة", en: "Pending" },
  trainingBankCount_approved: { ar: "معتمَدة", en: "Approved" },
  trainingBankCount_rejected_privacy: { ar: "مرفوضة — خصوصية", en: "Rejected — Privacy" },
  trainingBankCount_rejected_quality: { ar: "مرفوضة — جودة", en: "Rejected — Quality" },
  trainingBankCount_revoked: { ar: "مُبطَلة", en: "Revoked" },
  trainingBankPendingList: { ar: "العيّنات قيد المراجعة", en: "Pending samples" },
  trainingBankEmpty: { ar: "لا عيّنات تنتظر المراجعة.", en: "No samples awaiting review." },
  trainingBankReview: { ar: "مراجعة", en: "Review" },
  trainingBankReviewTitle: { ar: "مراجعة عيّنة", en: "Review sample" },
  trainingBankLoading: { ar: "جارٍ التحقّق من المصدر…", en: "Revalidating the source…" },
  trainingBankUserMessage: { ar: "رسالة المستخدم", en: "User message" },
  trainingBankAssistantMessage: { ar: "رد المساعد", en: "Assistant response" },
  trainingBankPrivacyWarning: {
    ar: "قد تحتوي العينة على بيانات شخصية. راجعها قبل الاعتماد.",
    en: "This sample may contain personal information. Review it before approval.",
  },
  trainingBankRedacted: {
    ar: "حُجبت أجزاء تبدو مفاتيح أو اعتمادات أو أرقام بطاقات.",
    en: "Parts that look like keys, credentials, or card numbers were masked.",
  },
  trainingBankPrivacyBlocked: {
    ar: "وجد الفحص بيانات يقينية في هذه العيّنة، فلا يمكن اعتمادها.",
    en: "The scanner found definite personal data in this sample, so it cannot be approved.",
  },
  trainingBankQualityBlocked: {
    ar: "لم تعد هذه العيّنة تجتاز فحص الجودة، فلا يمكن اعتمادها.",
    en: "This sample no longer passes the quality gate, so it cannot be approved.",
  },
  trainingBankSourceChanged: {
    ar: "تم تغيير مصدر هذه العينة بعد مشاركتها، فلا يمكن اعتمادها.",
    en: "This sample's source changed after it was shared, so it cannot be approved.",
  },
  trainingBankSourceUnavailable: {
    ar: "لم يعد مصدر هذه العينة متاحًا.",
    en: "This sample's source is no longer available.",
  },
  trainingBankApprove: { ar: "اعتماد", en: "Approve" },
  trainingBankRejectPrivacy: { ar: "رفض — خصوصية", en: "Reject — Privacy" },
  trainingBankRejectQuality: { ar: "رفض — جودة", en: "Reject — Quality" },
  trainingBankClose: { ar: "إغلاق", en: "Close" },
  trainingBankApproved: {
    ar: "تم اعتماد العيّنة للنظر مستقبلًا. لم يُدرَّب نموذج ولم يُصدَّر شيء.",
    en: "The sample was approved for future consideration. No model was trained and nothing was exported.",
  },
  trainingBankRejected: { ar: "تم رفض العيّنة.", en: "The sample was rejected." },
  trainingBankConflict: {
    ar: "تم حسم هذه العيّنة بالفعل. حدّث الصفحة.",
    en: "This sample was already decided. Refresh the page.",
  },
  trainingBankFailed: { ar: "تعذّر تنفيذ القرار. حاول مرة أخرى.", en: "Could not apply the decision. Please try again." },
  trainingBankPrivacy_unknown: { ar: "خصوصية: غير محكوم", en: "Privacy: unknown" },
  trainingBankPrivacy_needs_review: { ar: "خصوصية: تحتاج مراجعة", en: "Privacy: needs review" },
  trainingBankPrivacy_passed: { ar: "خصوصية: مرّت", en: "Privacy: passed" },
  trainingBankPrivacy_rejected: { ar: "خصوصية: مرفوضة", en: "Privacy: rejected" },
  trainingBankQuality_unknown: { ar: "جودة: غير محكوم", en: "Quality: unknown" },
  trainingBankQuality_passed: { ar: "جودة: مرّت", en: "Quality: passed" },
  trainingBankQuality_rejected: { ar: "جودة: مرفوضة", en: "Quality: rejected" },

  /* ── إصدارات مجموعة التدريب (v0.9.6، المرحلة 3A) ── */
  datasetsSection: { ar: "إصدارات المجموعة", en: "Dataset releases" },
  /**
   * ★ ونصٌّ يقول ما ليس بعد.
   *
   * «إصدار» تُقرأ في سياق النماذج على أنها شيءٌ نُشر. وما يقع هنا أن
   * عيّناتٍ جُمعت وثُبّتت — ولا تدريب ولا تصدير ولا نموذج.
   */
  datasetsMeaning: {
    ar: "الإصدار مجموعة عيّنات مثبَّتة ببصمة. لا تصدير، ولا تدريب، ولا نموذج — وصلاحيته تُفحص من جديد قبل أي استخدام.",
    en: "A release is a fixed, hashed set of samples. No export, no training, no model — and its validity is rechecked before any use.",
  },
  datasetsEmpty: { ar: "لا إصدارات بعد.", en: "No releases yet." },
  datasetsVersion: { ar: "الإصدار", en: "Version" },
  datasetsStatus: { ar: "الحالة", en: "Status" },
  datasetsSamples: { ar: "العيّنات", en: "Samples" },
  datasetsCreated: { ar: "أُنشئ", en: "Created" },
  datasetsFrozen: { ar: "جُمّد", en: "Frozen" },
  datasetStatus_draft: { ar: "مسوَّدة", en: "Draft" },
  datasetStatus_frozen: { ar: "مجمَّد", en: "Frozen" },
  datasetStatus_invalidated: { ar: "مُبطَل", en: "Invalidated" },
  datasetsPreview: { ar: "معاينة المؤهَّلين", en: "Preview eligible" },
  datasetsCreateDraft: { ar: "إنشاء مسوَّدة", en: "Create draft" },
  datasetsFreeze: { ar: "تجميد", en: "Freeze" },
  datasetsEligible: { ar: "مؤهَّلة الآن", en: "Eligible now" },
  datasetsSkipped: { ar: "مستبعَدة", en: "Skipped" },
  datasetsNoEligible: {
    ar: "لا توجد عيّنات مؤهَّلة الآن. لا تُنشأ مسوَّدة فارغة.",
    en: "No eligible samples right now. An empty draft is not created.",
  },
  datasetsCreated_ok: {
    ar: "أُنشئت المسوَّدة. لم يُصدَّر شيء ولم يُدرَّب نموذج.",
    en: "Draft created. Nothing was exported and no model was trained.",
  },
  datasetsFrozen_ok: {
    ar: "جُمّد الإصدار. ما زال يُفحص من جديد قبل أي استخدام.",
    en: "Release frozen. It is still revalidated before any use.",
  },
  datasetsRevalidationFailed: {
    ar: "لم تعد بعض العيّنات صالحة، فلم يُجمَّد الإصدار.",
    en: "Some samples are no longer valid, so the release was not frozen.",
  },
  datasetsConflict: {
    ar: "تغيّرت حالة الإصدار. حدّث الصفحة.",
    en: "The release state changed. Refresh the page.",
  },
  datasetsFailed: { ar: "تعذّرت العملية. حاول مرة أخرى.", en: "Operation failed. Please try again." },

  /* ── أثر التدريب الخاصّ (v0.9.7، المرحلة 3B) ── */
  artifactCreate: { ar: "إنشاء أثر التدريب", en: "Create training artifact" },
  artifactConfirmTitle: { ar: "إنشاء أثر التدريب؟", en: "Create training artifact?" },
  artifactConfirmBody: {
    ar: "سيتم إنشاء ملف تدريب خاص من الإصدار المجمّد بعد إعادة التحقق من جميع عيناته. لن يبدأ أي تدريب.",
    en: "A private training file will be created from the frozen release after all its samples are revalidated. No training will start.",
  },
  /**
   * ★ ونصٌّ يقول ما ليس بعد.
   *
   * «أثر جاهز» تُقرأ على أنها «صار يُستعمل». وما يقع أن ملفًّا كُتب ووُضع
   * في تخزينٍ خاصّ لا يصل إليه متصفّح — ولا يُقرأ إلا بعد فحصٍ جديد.
   */
  artifactMeaning: {
    ar: "الأثر ملف خاص بالخادم. لا تنزيل، ولا رابط، ولا تدريب — وصلاحيته تُفحص من جديد قبل أي استخدام.",
    en: "The artifact is a server-only file. No download, no link, no training — and its validity is rechecked before any use.",
  },
  artifactReady: { ar: "أثر جاهز", en: "Artifact ready" },
  artifactSamples: { ar: "عيّنات", en: "samples" },
  artifactSize: { ar: "الحجم", en: "Size" },
  artifactConfirmAction: { ar: "إنشاء", en: "Create" },
  artifactCancel: { ar: "إلغاء", en: "Cancel" },
  artifactClose: { ar: "إغلاق", en: "Close" },
  artifactSuccess: {
    ar: "تم إنشاء الأثر. لم يبدأ أي تدريب ولم يُصدَّر شيء إلى خارج الخادم.",
    en: "The artifact was created. No training started and nothing left the server.",
  },
  artifactExists: {
    ar: "لهذا الإصدار أثر قائم بالفعل. لا يُستبدل.",
    en: "This release already has an artifact. It is not replaced.",
  },
  artifactInvalid: {
    ar: "لم تعد بعض العيّنات صالحة، فلم يُنشأ الأثر.",
    en: "Some samples are no longer valid, so the artifact was not created.",
  },
  artifactFailed: { ar: "تعذّر إنشاء الأثر. حاول مرة أخرى.", en: "Could not create the artifact. Please try again." },

  /* ── مهامّ التدريب — مواصفةٌ لا تشغيل (v0.9.8، المرحلة 4A) ── */
  jobsSection: { ar: "مهام التدريب", en: "Training jobs" },
  /**
   * ★ ونصٌّ يقول ما ليس بعد.
   *
   * «مهمّة تدريب» تُقرأ على أنها شيءٌ يجري. وما يقع أن مواصفةً كُتبت —
   * ولا عتاد، ولا مزوّد، ولا أوزان.
   */
  jobsMeaning: {
    ar: "المهمة مواصفة تدريب فقط: أي بيانات، وأي نموذج أساسي، وبأي أرقام. لا تشغيل، ولا GPU، ولا نموذج جديد.",
    en: "A job is only a training specification: which data, which base model, which numbers. No execution, no GPU, no new model.",
  },
  jobsEmpty: { ar: "لا مهام بعد.", en: "No jobs yet." },
  jobsCreate: { ar: "إنشاء مهمة تدريب", en: "Create training job" },
  jobsConfirmTitle: { ar: "إنشاء مهمة تدريب؟", en: "Create training job?" },
  jobsConfirmBody: {
    ar: "سيتم إنشاء مواصفة تدريب فقط. لن يبدأ أي تدريب أو استخدام GPU.",
    en: "Only a training specification will be created. No training will start and no GPU will be used.",
  },
  jobsConfirmAction: { ar: "إنشاء", en: "Create" },
  jobsCancel: { ar: "إلغاء", en: "Cancel" },
  jobsBaseModel: { ar: "النموذج الأساسي", en: "Base model" },
  jobsPreset: { ar: "الإعداد", en: "Preset" },
  jobsMethod: { ar: "الطريقة", en: "Method" },
  jobsSeed: { ar: "البذرة", en: "Seed" },
  jobsDataset: { ar: "المجموعة", en: "Dataset" },
  jobsSamples: { ar: "العيّنات", en: "Samples" },
  jobsCreated: { ar: "أُنشئت", en: "Created" },
  jobsPrepared: { ar: "جُهِّزت", en: "Prepared" },
  jobStatus_draft: { ar: "مسوَّدة", en: "Draft" },
  jobStatus_prepared: { ar: "مُجهَّزة", en: "Prepared" },
  jobStatus_cancelled: { ar: "ملغاة", en: "Cancelled" },
  jobsPrepareAction: { ar: "تجهيز", en: "Prepare" },
  jobsCancelAction: { ar: "إلغاء المهمة", en: "Cancel job" },
  /**
   * ★ و«مُجهَّزة» تُشرح حيث تُقرأ.
   *
   * فمن يرى الكلمة وحدها يظنّ أن شيئًا صار جاهزًا للانطلاق. وما يعنيه
   * أن المواصفة ثبتت — ويبقى فحصٌ جديد قبل أيّ تسليم.
   */
  jobsPreparedMeaning: {
    ar: "«مُجهَّزة» تعني أن المواصفة ثبتت وصلحت للتسليم مستقبلًا. لم يبدأ تدريب، وتُفحص صلاحيتها من جديد قبل أي استخدام.",
    en: "“Prepared” means the specification is fixed and fit for future handover. No training started, and its validity is rechecked before any use.",
  },
  jobsCreatedOk: {
    ar: "أُنشئت المواصفة. لم يبدأ أي تدريب ولم يُستخدم أي GPU.",
    en: "The specification was created. No training started and no GPU was used.",
  },
  jobsPreparedOk: {
    ar: "جُهِّزت المواصفة. لم يبدأ أي تدريب.",
    en: "The specification is prepared. No training started.",
  },
  jobsCancelledOk: { ar: "أُلغيت المهمة.", en: "The job was cancelled." },
  jobsArtifactInvalid: {
    ar: "لم تعد بيانات هذه المهمة صالحة، فلم تُجهَّز.",
    en: "This job's data is no longer valid, so it was not prepared.",
  },
  jobsConflict: {
    ar: "تغيّرت حالة المهمة. حدّث الصفحة.",
    en: "The job state changed. Refresh the page.",
  },
  jobsFailed: { ar: "تعذّرت العملية. حاول مرة أخرى.", en: "Operation failed. Please try again." },
  jobsPinned: { ar: "مثبَّت", en: "Pinned" },
  jobsUnpinned: { ar: "غير مثبَّت", en: "Unpinned" },
  /**
   * ★ ونصٌّ يقول لماذا لا يُختار.
   *
   * فقائمةٌ فيها خيارٌ معطَّل بلا سبب تُقرأ عطلًا. و«غير مثبَّت» تعني أن
   * هوّية أوزانه لم يُتحقَّق منها — فما سيُنزَّل قد لا يكون ما وُصف.
   */
  jobsUnpinnedNote: {
    ar: "النماذج غير المثبَّتة لا يمكن إنشاء مهمة منها: لم يُتحقَّق من هوية أوزانها.",
    en: "Unpinned models cannot start a job: their weight identity has not been verified.",
  },
  jobsUnpinnedError: {
    ar: "هذا النموذج غير مثبَّت، فلم تُنشأ المهمة.",
    en: "This model is unpinned, so the job was not created.",
  },
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
  /**
   * الصور تنتهي عند status="ready" ولا تدخل RAG (بلا OCR) — فلا يجوز وعدها
   * بمرحلة تجهيز لن تأتي. راجع lib/rag/pipeline.ts و lib/files/service.ts.
   */
  imageNoAiContext: { ar: "صورة — بلا سياق AI", en: "Image — no AI context" },
  imageAttachmentNotice: {
    ar: "الصور تُحفظ وتُعرض فقط ولا تدخل سياق الذكاء الاصطناعي (قراءة النص من الصور غير مدعومة بعد). أرفق ملف PDF أو DOCX أو TXT لتسأل عن محتواه.",
    en: "Images are stored and displayed only — they don't enter the AI context (reading text from images isn't supported yet). Attach a PDF, DOCX, or TXT to ask about its content.",
  },
  providerLimitNote: {
    ar: "الحد الأقصى الحالي للملف 50 ميجابايت بسبب قيود مزود التخزين.",
    en: "Current maximum file size is 50MB due to storage provider constraints.",
  },
  projectFiles: { ar: "ملفات المشروع", en: "Project files" },
  ragPreparing: {
    ar: "جارٍ تجهيز الملف للذكاء الاصطناعي",
    en: "Preparing file for AI",
  },
  ragReady: { ar: "جاهز للمحادثة", en: "Ready for chat" },
  ragFailed: { ar: "فشل التجهيز", en: "Preparation failed" },
  ragPrepare: { ar: "تجهيز للذكاء الاصطناعي", en: "Prepare for AI" },
  ragRetry: { ar: "إعادة تجهيز للذكاء الاصطناعي", en: "Re-prepare for AI" },
  textExtracted: { ar: "تم استخراج النص", en: "Text extracted" },
  sources: { ar: "المصادر", en: "Sources" },
  page: { ar: "صفحة", en: "Page" },
  removeFromContext: {
    ar: "إزالة من سياق المحادثة (دون حذف الملف)",
    en: "Remove from chat context (keeps the file)",
  },
  ragAttachmentReady: {
    ar: "الملف جاهز — اسأل عن محتواه وسيجيب YSD AI من مقاطعه مع ذكر المصادر.",
    en: "File ready — ask about its content and YSD AI will answer from it with sources.",
  },
  uploadToProject: { ar: "رفع ملف للمشروع", en: "Upload to project" },
  betaTitle: { ar: "النسخة التجريبية الخاصة", en: "Private Beta" },
  betaIntro: {
    ar: "YSD AI حاليًا في نسخة تجريبية خاصة بالدعوة فقط. أدخل كود الدعوة للانضمام.",
    en: "YSD AI is currently in invite-only private beta. Enter your invite code to join.",
  },
  inviteCode: { ar: "كود الدعوة", en: "Invite code" },
  haveInvite: { ar: "لديّ كود دعوة", en: "I have an invite code" },
  checkInvite: { ar: "تحقّق من الكود", en: "Verify code" },
  inviteValid: { ar: "الكود صالح — أكمل التسجيل.", en: "Code valid — continue registration." },
  inviteInvalid: {
    ar: "كود الدعوة غير صالح أو منتهٍ أو مستنفد.",
    en: "Invite code is invalid, expired, or exhausted.",
  },
  registrationClosed: {
    ar: "التسجيل العام مغلق حاليًا. الانضمام بالدعوة فقط.",
    en: "Public registration is closed. Invite only.",
  },
  agreeTerms: {
    ar: "أوافق على شروط الاستخدام وسياسة الخصوصية",
    en: "I agree to the Terms of Use and Privacy Policy",
  },
  mustAgree: {
    ar: "يجب الموافقة على الشروط والخصوصية للمتابعة.",
    en: "You must accept the Terms and Privacy Policy to continue.",
  },
  termsLink: { ar: "شروط الاستخدام", en: "Terms of Use" },
  privacyLink: { ar: "سياسة الخصوصية", en: "Privacy Policy" },
  suspendedTitle: { ar: "الحساب موقوف", en: "Account suspended" },
  suspendedBody: {
    ar: "تم إيقاف حسابك. إن كنت تعتقد أن هذا خطأ، تواصل مع إدارة المنصة.",
    en: "Your account has been suspended. If you believe this is a mistake, contact support.",
  },
  maintenanceTitle: { ar: "صيانة مؤقتة", en: "Under maintenance" },
  maintenanceBody: {
    ar: "المنصة قيد الصيانة حاليًا. نعود قريبًا — شكرًا لصبرك.",
    en: "The platform is under maintenance. We'll be back shortly — thanks for your patience.",
  },
  usageTitle: { ar: "استهلاكي", en: "My usage" },
  remaining: { ar: "المتبقي", en: "Remaining" },
  dailyMessages: { ar: "الرسائل اليوم", en: "Messages today" },
  monthlyMessages: { ar: "الرسائل هذا الشهر", en: "Messages this month" },
  ragOps: { ar: "عمليات RAG", en: "RAG operations" },
  nearLimit: {
    ar: "اقتربت من الحد — استخدمت أكثر من ٨٠٪.",
    en: "Approaching your limit — over 80% used.",
  },
  atLimit: {
    ar: "بلغت الحد. انتظر التجديد أو رقِّ باقتك.",
    en: "You've reached the limit. Wait for renewal or upgrade.",
  },
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
