/** شعار YSD AI — نجمة رباعية على تدرّج بنفسجي */

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="relative shrink-0 rounded-[10px] flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg,#7C5CFF 0%,#4E2ED4 100%)",
        boxShadow: "0 0 18px rgba(124,92,255,.35)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        fill="none"
        aria-hidden
      >
        <path
          d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z"
          fill="#F2EEFF"
        />
      </svg>
    </div>
  );
}

export function Logo({
  compact,
  tagline,
}: {
  compact?: boolean;
  tagline?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <LogoMark />
      {!compact && (
        <div className="leading-none">
          <div className="font-display font-bold text-[17px] tracking-wide text-ink-strong">
            YSD AI
          </div>
          {tagline && <div className="text-[10px] text-ink-dim mt-1">{tagline}</div>}
        </div>
      )}
    </div>
  );
}
