#!/bin/sh
# ============================================================
# YSD AI — نقطة دخول الحاوية
#
# ★ الغاية الوحيدة: ضبط متغيّرَي glibc malloc قبل أن يبدأ Node، **وفقط** حين يكون فضاء F2LLM مشتعلًا فعلًا.
#
#   MALLOC_MMAP_THRESHOLD_ و MALLOC_TRIM_THRESHOLD_ يقرؤهما glibc عند بدء العملية، فلا يكفي ضبطهما من
#   داخل التطبيق. بدونهما تتضخّم ذاكرة ONNX Runtime الأصلية ~300MB فوق حدّ 512MB (قيس: 549MB→320MB
#   خارج Next، وF2LLM داخل Next ≈ 409MB). وثمنهما ≈ ضعف زمن التضمين للمقطع، فلا يُفرضان على المسار
#   الافتراضي (e5) الذي لم يُقَس بهما ولا يحتاجهما هنا.
#
# ★ `unset` أولًا مهما كانت الحالة — لا شرطًا للفضاء وحده.
#
#   المنصّة قد تحمل هذين المتغيّرين كإعدادٍ ثابتٍ على الخدمة (خطأُ تشغيلٍ سابقٌ ضبطهما هكذا مرّةً)،
#   فيصلان Node بمعزلٍ عن أيّ منطقٍ هنا. مسحُهما أولًا يضمن أن القسم أدناه — لا إعدادُ المنصّة — هو
#   الحاكمُ الوحيد على ما يراه e5. فرعٌ يشتعل خطأً لا يمكن أن يُسرّب الضبط إلى المسار الافتراضي.
#
# ★ حارسٌ أول من ثلاثة — لا يعمل وحده:
#   الثاني lib/rag/embedding-space.ts (f2llmEnabled: العَلَمان معًا في الإنتاج)، والثالث
#   assertF2llmRuntimeEnv في f2llm-embeddings.ts (يرفض تحميل النموذج على Linux بلا المتغيّرين، حتى
#   لو صدّقهما فرعٌ هنا بالخطأ). الثلاثة تتفق حرفيًّا: بيئة الإنتاج + عَلَم الموافقة الصريح معًا، وإلا فلا.
#
# ★ `exec` كي تصل إشارات المنصّة (SIGTERM) إلى Node مباشرةً لا إلى غلاف.
# ============================================================
set -eu

unset MALLOC_MMAP_THRESHOLD_ MALLOC_TRIM_THRESHOLD_ 2>/dev/null || true

if [ "${YSD_RAG_EMBEDDING_MODEL:-}" = "f2llm-v2-80m" ]; then
  env_name="$(printf '%s' "${RAILWAY_ENVIRONMENT_NAME:-}" | tr '[:upper:]' '[:lower:]')"
  case "$env_name" in
    *prod*)
      if [ "${YSD_F2LLM_PRODUCTION_OPT_IN:-}" = "1" ]; then
        export MALLOC_MMAP_THRESHOLD_=65536
        export MALLOC_TRIM_THRESHOLD_=65536
        echo "[entrypoint] f2llm space (production, explicit opt-in): glibc malloc thresholds set (mmap=65536 trim=65536)" >&2
      else
        echo "[entrypoint] YSD_RAG_EMBEDDING_MODEL ignored: production environment without YSD_F2LLM_PRODUCTION_OPT_IN=1" >&2
      fi
      ;;
    *)
      export MALLOC_MMAP_THRESHOLD_=65536
      export MALLOC_TRIM_THRESHOLD_=65536
      echo "[entrypoint] f2llm space: glibc malloc thresholds set (mmap=65536 trim=65536)" >&2
      ;;
  esac
fi

exec "$@"
