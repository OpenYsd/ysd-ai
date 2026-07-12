/** حالة التحميل لقائمة المشاريع — هيكل عظمي */
export default function ProjectsLoading() {
  return (
    <div className="flex-1 px-4 md:px-6 py-5">
      <div className="max-w-[860px] mx-auto">
        <div className="h-10 w-full rounded-xl bg-raised/60 animate-pulse mb-4" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-2xl bg-raised/60 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
