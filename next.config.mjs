/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
const nextConfig = {
  // يوجد package-lock.json آخر في مجلد أعلى — نثبّت جذر المشروع هنا
  outputFileTracingRoot: import.meta.dirname,
  experimental: {
    // مع وجود middleware يخزّن Next جسم الطلب بحد افتراضي 10MB —
    // نرفعه ليتسع لسقف مزود التخزين (50MB) + هامش multipart
    middlewareClientMaxBodySize: "52mb",
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default nextConfig;
