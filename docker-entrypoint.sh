#!/bin/sh
# ============================================================
# YSD AI — نقطة دخول الحاوية
#
# ★ الغاية الوحيدة: ضبط متغيّرَي glibc malloc قبل أن يبدأ Node، **وفقط** حين يكون فضاء F2LLM مطلوبًا.
#
#   MALLOC_MMAP_THRESHOLD_ و MALLOC_TRIM_THRESHOLD_ يقرؤهما glibc عند بدء العملية، فلا يكفي ضبطهما من
#   داخل التطبيق. بدونهما تتضخّم ذاكرة ONNX Runtime الأصلية ~300MB فوق حدّ 512MB (قيس: 549MB→320MB
#   خارج Next، وF2LLM داخل Next ≈ 409MB). وثمنهما ≈ ضعف زمن التضمين للمقطع، فلا يُفرضان على المسار
#   الافتراضي (e5) الذي لم يُقَس بهما ولا يحتاجهما هنا.
#
# ★ يتجاهل العَلَمَ في بيئة الإنتاج — كما يفعل التطبيق نفسه (lib/rag/embedding-space.ts): حارسان لا واحد.
# ★ `exec` كي تصل إشارات المنصّة (SIGTERM) إلى Node مباشرةً لا إلى غلاف.
# ============================================================
set -eu

if [ "${YSD_RAG_EMBEDDING_MODEL:-}" = "f2llm-v2-80m" ]; then
  env_name="$(printf '%s' "${RAILWAY_ENVIRONMENT_NAME:-}" | tr '[:upper:]' '[:lower:]')"
  case "$env_name" in
    *prod*)
      echo "[entrypoint] YSD_RAG_EMBEDDING_MODEL ignored: production environment" >&2
      ;;
    *)
      export MALLOC_MMAP_THRESHOLD_=65536
      export MALLOC_TRIM_THRESHOLD_=65536
      echo "[entrypoint] f2llm space: glibc malloc thresholds set (mmap=65536 trim=65536)" >&2
      ;;
  esac
fi

exec "$@"
