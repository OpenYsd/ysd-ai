# ============================================================
# YSD AI — صورة إنتاجية (Next.js + خادم Node دائم)
# البناء: npm run build   ·   التشغيل: npm start
#
# مبدأ الأسرار:
#   • NEXT_PUBLIC_* تلزم في **الوقتين**:
#       - وقت البناء (build args): تُحقَن في حزمة المتصفح.
#       - وقت التشغيل (-e): لأن lib/env.ts يقرأ process.env[name] **ديناميكيًا**،
#         وNext.js لا يحقن إلا الوصول الساكن (process.env.NEXT_PUBLIC_X حرفيًا).
#         بدونها وقت التشغيل يفشل checkEnv، ومع YSD_STRICT_ENV=1 يُرفض الإقلاع
#         فترد كل المسارات 500. (تحقّق حي: الحاوية سقطت بالضبط هكذا.)
#     وهي عامة بطبيعتها (تصل كل زائر أصلًا): رابط Supabase والمفتاح anon المحكوم
#     بـRLS. لا تمرّر أي سرّ خادمي هنا.
#   • الأسرار الخادمية (OPENROUTER_API_KEY / ANTHROPIC_API_KEY) **وقت التشغيل فقط**
#     عبر -e أو secrets المنصة. لا ARG ولا ENV لها ولا COPY لأي .env — راجع .dockerignore.
# ============================================================

# ---------- 1) الاعتماديات ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# نسخ ملفات التثبيت فقط: تتغيّر نادرًا فتبقى الطبقة مخبّأة
COPY package.json package-lock.json ./
# ci = تثبيت حتمي مطابق للقفل (بما فيه devDependencies — يحتاجها البناء)
RUN npm ci --no-audit --no-fund

# ---------- 2) البناء ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# عامة بطبيعتها — تُحقَن في حزمة المتصفح وقت البناء
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_NAME
ARG NEXT_PUBLIC_DEFAULT_LOCALE
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_DEFAULT_LOCALE=$NEXT_PUBLIC_DEFAULT_LOCALE \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# يفشل مبكرًا برسالة واضحة بدل صورة تُبنى ثم تنكسر في المتصفح
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" || (echo "خطأ: NEXT_PUBLIC_SUPABASE_URL مطلوب وقت البناء (--build-arg)" && exit 1)
RUN test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" || (echo "خطأ: NEXT_PUBLIC_SUPABASE_ANON_KEY مطلوب وقت البناء (--build-arg)" && exit 1)

RUN npm run build

# هذا المشروع لا يملك مجلد public/ (الأصول إمّا داخل app/ أو SVG مضمّن)، وNext.js
# لا يشترطه. ننشئه فارغًا ليبقى COPY في مرحلة التشغيل صامدًا سواء أُضيف لاحقًا أم لا.
RUN mkdir -p /app/public

# .next/cache ذاكرة بناء webpack (قِيست: 236MB من أصل 248MB) — لا تُستخدَم وقت
# التشغيل إطلاقًا. حذفها هنا يمنع شحنها في طبقة التشغيل. الخادم يُعيد إنشاء المجلد
# عند الحاجة، وقد هُيّئ قابلًا للكتابة في مرحلة runner.
RUN rm -rf /app/.next/cache

# ---------- 3) اعتماديات التشغيل فقط ----------
# طبقة منفصلة: تُسقط devDependencies (‎~14 حزمة) من الصورة النهائية
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- 4) التشغيل ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # قالب النشر المبدئي: يقلّل بصمة نموذج Embeddings المحلي
    YSD_LOW_MEMORY=1

# مستخدم غير جذر (node موجود في الصورة الأساسية بـuid 1000)
RUN mkdir -p /app/.next/cache && chown -R node:node /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder  --chown=node:node /app/.next        ./.next
COPY --from=builder  --chown=node:node /app/public       ./public
COPY --from=builder  --chown=node:node /app/package.json ./package.json
COPY --from=builder  --chown=node:node /app/next.config.mjs ./next.config.mjs

USER node
EXPOSE 3000

# HEALTHCHECK = liveness فقط: هل خادم Node حيّ ويستجيب؟
# **أي** رد HTTP (200 أو 503) يعني أنه حيّ؛ فشل الاتصال وحده يعني موته.
#
# لماذا لا نشترط 200: /api/health يرد 503 حين تتعثّر خدمة خارجية (Supabase مثلًا —
# رُصد انقطاعه ثلاث مرات أثناء التطوير). لو ربطنا صحة الحاوية بذلك، لأعلنت المنصة
# أن الحاوية معطوبة بعد 90ث من انقطاع خارجي فأعادت تشغيل خادم سليم — وإعادة
# التشغيل لا تُصلح خدمة خارجية، بل تقطع الخدمة عن المستخدمين بلا سبب.
# جسم /api/health (readiness) يبقى للمراقبة وصفحات الحالة — لا لقرار إعادة التشغيل.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"

# خادم Node دائم (لا serverless)
CMD ["npm", "start"]
