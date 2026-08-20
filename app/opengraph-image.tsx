import { ImageResponse } from "next/og";
import { BRAND, BRAND_COLORS } from "@/lib/brand";
import { StarGlyph } from "@/lib/brand-image";

/**
 * البطاقة الاجتماعية 1200×630 (v0.9.13، المرحلة 6B).
 *
 * ── ما فيها وما ليس فيها ──
 *
 * علامةٌ ونصّ ومداراتٌ خافتة. ولا بيانات مستخدم، ولا شيء يعتمد على من يفتح
 * الرابط: هذه صورةٌ واحدة يراها الجميع، ويخزّنها X وWhatsApp وDiscord على
 * خوادمها. فأي محتوى شخصيّ فيها يخرج من سيطرتنا للأبد.
 *
 * ── ولماذا لا تدرّجٌ شعاعيّ ──
 *
 * محرّك `next/og` يقبل مجموعةً محدودة من CSS، ودعمُ `radial-gradient` فيه
 * أقلّ ضمانًا من الخطّي. والتوهّج هنا دوائرُ نصفُ قطرها كامل بشفافية —
 * عناصرُ عادية يفهمها المحرّك حتمًا. وفشلُ التوليد لا يظهر عند البناء بل
 * على أوّل مشاركةِ رابط، فالمخاطرة لا تُقبل هنا.
 */

export const runtime = "nodejs";
export const alt = `${BRAND.name} — Think Deeper. Build Better.`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: BRAND_COLORS.background,
          fontFamily: "sans-serif",
        }}
      >
        {/* توهّجٌ بنفسجيّ أعلى اليمين */}
        <div
          style={{
            position: "absolute",
            top: -260,
            right: -180,
            width: 760,
            height: 760,
            borderRadius: 9999,
            background: "rgba(124,92,255,0.20)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -120,
            right: -40,
            width: 420,
            height: 420,
            borderRadius: 9999,
            background: "rgba(78,46,212,0.28)",
          }}
        />

        {/* مداراتٌ — خطوطٌ رفيعة لا زخرفةٌ صاخبة */}
        <div
          style={{
            position: "absolute",
            top: 60,
            right: 120,
            width: 520,
            height: 520,
            borderRadius: 9999,
            border: "1px solid rgba(139,108,246,0.28)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 150,
            right: 210,
            width: 340,
            height: 340,
            borderRadius: 9999,
            border: "1px solid rgba(139,108,246,0.18)",
          }}
        />

        {/* النجمة الكبرى داخل المدار */}
        <div
          style={{
            position: "absolute",
            top: 236,
            right: 296,
            width: 168,
            height: 168,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StarGlyph size={168} fill={BRAND_COLORS.primary} />
        </div>

        {/* النصّ */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 80px",
            width: 720,
            height: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                width: 64,
                height: 64,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 20,
                background: `linear-gradient(135deg, ${BRAND_COLORS.primary} 0%, ${BRAND_COLORS.primaryDeep} 100%)`,
              }}
            >
              <StarGlyph size={36} />
            </div>
            <div
              style={{
                marginLeft: 20,
                fontSize: 40,
                fontWeight: 700,
                color: BRAND_COLORS.ink,
                letterSpacing: 1,
              }}
            >
              {BRAND.name}
            </div>
          </div>

          <div
            style={{
              marginTop: 44,
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.15,
              color: BRAND_COLORS.ink,
            }}
          >
            Think Deeper.
          </div>
          <div
            style={{
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.15,
              color: BRAND_COLORS.primary,
            }}
          >
            Build Better.
          </div>

          <div
            style={{
              marginTop: 28,
              fontSize: 26,
              color: BRAND_COLORS.inkMuted,
              lineHeight: 1.5,
            }}
          >
            An intelligent workspace for chat, files and projects.
          </div>

          <div
            style={{
              marginTop: 40,
              fontSize: 16,
              letterSpacing: 4,
              color: "rgba(168,163,199,0.65)",
            }}
          >
            {BRAND.tagline}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
