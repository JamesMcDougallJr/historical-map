"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface TimelineSliderProps {
  minYear: number;
  maxYear: number;
  range: [number, number];
  onRangeChange: (range: [number, number]) => void;
  onToggle?: (enabled: boolean) => void;
  isEnabled?: boolean;
}

export function TimelineSlider({
  minYear,
  maxYear,
  range,
  onRangeChange,
  onToggle,
  isEnabled = false,
}: TimelineSliderProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"low" | "high" | null>(null);

  // Close on tap/click outside
  useEffect(() => {
    if (!isExpanded) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [isExpanded]);

  const totalRange = maxYear - minYear;
  const lowPct = ((range[0] - minYear) / totalRange) * 100;
  const highPct = ((range[1] - minYear) / totalRange) * 100;

  const yearFromClientX = useCallback(
    (clientX: number): number => {
      if (!trackRef.current) return minYear;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(minYear + pct * totalRange);
    },
    [minYear, totalRange],
  );

  // Pointer drag handlers
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = "touches" in e ? e.touches[0]!.clientX : e.clientX;
      const year = yearFromClientX(clientX);
      if (dragging === "low") {
        onRangeChange([Math.min(year, range[1] - 1), range[1]]);
      } else {
        onRangeChange([range[0], Math.max(year, range[0] + 1)]);
      }
    };

    const onUp = () => setDragging(null);

    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchend", onUp);
    };
  }, [dragging, range, onRangeChange, yearFromClientX]);

  // Decade markers
  const decades: number[] = [];
  const startDecade = Math.ceil(minYear / 10) * 10;
  for (let year = startDecade; year <= maxYear; year += 10) {
    decades.push(year);
  }
  const visibleDecades = decades.filter(
    (_, i) => i % 2 === 0 || decades.length <= 8,
  );

  const handleTrackClick = (e: React.MouseEvent) => {
    if (!isEnabled) return;
    const year = yearFromClientX(e.clientX);
    // Move whichever thumb is closer
    const distLow = Math.abs(year - range[0]);
    const distHigh = Math.abs(year - range[1]);
    if (distLow <= distHigh) {
      onRangeChange([Math.min(year, range[1] - 1), range[1]]);
    } else {
      onRangeChange([range[0], Math.max(year, range[0] + 1)]);
    }
  };

  return (
    <div ref={containerRef} className="fixed bottom-4 left-4 z-20">
      {/* Toggle Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 px-4 py-2 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors ${
          isEnabled
            ? "bg-blue-600/80 hover:bg-blue-600"
            : "bg-black/70 hover:bg-black/80"
        }`}
        aria-label="Toggle timeline"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span className="text-sm font-medium">
          {isEnabled ? `${range[0]}–${range[1]}` : "Timeline"}
        </span>
      </button>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="absolute bottom-12 left-0 w-80 bg-slate-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-slate-700 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-white font-medium">Time Filter</h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => onToggle?.(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
            </label>
          </div>

          {/* Range Slider Content */}
          <div
            className={`px-4 py-4 ${!isEnabled ? "opacity-50 pointer-events-none" : ""}`}
          >
            {/* Range Display */}
            <div className="flex items-center justify-center gap-3 mb-4">
              <span className="text-2xl font-bold text-white tabular-nums">
                {range[0]}
              </span>
              <span className="text-slate-500">–</span>
              <span className="text-2xl font-bold text-white tabular-nums">
                {range[1]}
              </span>
            </div>
            <p className="text-xs text-slate-400 text-center mb-4">
              Showing overlays active in this range
            </p>

            {/* Custom Range Track */}
            <div className="relative pt-2 pb-8">
              <div
                ref={trackRef}
                className="relative h-2 bg-slate-700 rounded-full cursor-pointer"
                onClick={handleTrackClick}
              >
                {/* Active range highlight */}
                <div
                  className="absolute h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
                  style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
                />

                {/* Low thumb */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 bg-white rounded-full shadow-md border-2 border-blue-500 cursor-grab active:cursor-grabbing hover:scale-110 transition-transform touch-none"
                  style={{ left: `${lowPct}%` }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setDragging("low");
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setDragging("low");
                  }}
                />

                {/* High thumb */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 bg-white rounded-full shadow-md border-2 border-purple-500 cursor-grab active:cursor-grabbing hover:scale-110 transition-transform touch-none"
                  style={{ left: `${highPct}%` }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setDragging("high");
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setDragging("high");
                  }}
                />
              </div>

              {/* Decade Markers */}
              <div className="absolute left-0 right-0 top-6 flex justify-between px-1">
                {visibleDecades.map((decade) => {
                  const pos = ((decade - minYear) / totalRange) * 100;
                  const inRange = decade >= range[0] && decade <= range[1];
                  return (
                    <button
                      key={decade}
                      onClick={() => {
                        // Snap nearest thumb to decade
                        const distLow = Math.abs(decade - range[0]);
                        const distHigh = Math.abs(decade - range[1]);
                        if (distLow <= distHigh) {
                          onRangeChange([
                            Math.min(decade, range[1] - 1),
                            range[1],
                          ]);
                        } else {
                          onRangeChange([
                            range[0],
                            Math.max(decade, range[0] + 1),
                          ]);
                        }
                      }}
                      className={`text-[10px] transition-colors ${
                        inRange
                          ? "text-blue-400 font-medium"
                          : "text-slate-500 hover:text-slate-300"
                      }`}
                      style={{
                        position: "absolute",
                        left: `${pos}%`,
                        transform: "translateX(-50%)",
                      }}
                      disabled={!isEnabled}
                    >
                      {decade}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Presets */}
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => onRangeChange([minYear, 1850])}
                disabled={!isEnabled}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                Pre-1850
              </button>
              <button
                onClick={() => onRangeChange([1850, 1920])}
                disabled={!isEnabled}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                1850–1920
              </button>
              <button
                onClick={() => onRangeChange([1920, maxYear])}
                disabled={!isEnabled}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                Post-1920
              </button>
              <button
                onClick={() => onRangeChange([minYear, maxYear])}
                disabled={!isEnabled}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                All
              </button>
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-slate-700 bg-slate-800/50">
            <p className="text-xs text-slate-500">
              Drag thumbs to set time range
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
