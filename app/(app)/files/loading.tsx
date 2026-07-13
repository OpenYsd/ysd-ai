/** حالة التحميل لصفحة الملفات — هيكل عظمي */
export default function FilesLoading() {
  return (
    <div className="flex-1 px-4 md:px-6 py-5">
      <div className="max-w-[860px] mx-auto space-y-3">
        <div className="h-28 rounded-2xl bg-raised/60 animate-pulse" />
        <div className="h-10 rounded-xl bg-raised/60 animate-pulse" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded-xl bg-raised/60 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
