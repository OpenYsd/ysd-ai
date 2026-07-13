-- ============================================================
-- YSD AI — migration 0004 (آمنة لإعادة التشغيل)
-- النموذج المنطقي ysd/free يحل محل الموجّه العشوائي openrouter/free:
-- الواجهة تعرض ysd/free، والخادم يحله إلى Allowlist نماذج مجانية
-- معتمدة (lib/ai/free-models.ts) بحارس لغة.
-- ============================================================

insert into ai_providers (id, display_name)
values ('openrouter', 'OpenRouter')
on conflict (id) do nothing;

insert into ai_models (id, provider_id, display_name_ar, display_name_en)
values ('ysd/free', 'openrouter', 'YSD مجاني', 'YSD Free')
on conflict (id) do nothing;

-- تعطيل الموجه العشوائي إن كان مسجلًا (من 0003)
update ai_models set enabled = false where id = 'openrouter/free';

-- تفضيلات المستخدمين المشيرة للمعرف القديم تنتقل للمعرف الجديد
update user_preferences set default_model_id = 'ysd/free'
where default_model_id = 'openrouter/free';
