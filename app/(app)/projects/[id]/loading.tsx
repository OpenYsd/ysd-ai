/** حالة التحميل لتفاصيل المشروع — هيكل عظمي */
export default function ProjectDetailLoading() {
  return (
    <div className="flex-1 px-4 md:px-6 py-5">
      <div className="max-w-[720px] mx-auto space-y-5">
        <div className="h-64 rounded-2xl bg-raised/60 animate-pulse" />
        <div className="h-40 rounded-2xl bg-raised/60 animate-pulse" />
      </div>
    </div>
  );
}
