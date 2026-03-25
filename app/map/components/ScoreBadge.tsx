"use client";

interface ScoreBadgeProps {
  points: number;
  acknowledged: number;
  total: number;
}

export function ScoreBadge({ points, acknowledged, total }: ScoreBadgeProps) {
  const pct = total > 0 ? Math.round((acknowledged / total) * 100) : 0;

  return (
    <div className="absolute top-3 right-3 z-10 bg-white/90 dark:bg-neutral-800/90 backdrop-blur-sm rounded-xl shadow-lg border border-neutral-200 dark:border-neutral-700 px-3 py-2 flex items-center gap-3 select-none">
      {/* Points */}
      <div className="flex items-center gap-1.5">
        <span className="text-lg">⭐</span>
        <span className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
          {points}
        </span>
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-600" />

      {/* Progress */}
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          {acknowledged}/{total} events
        </span>
        <div className="w-16 h-1.5 bg-neutral-200 dark:bg-neutral-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
