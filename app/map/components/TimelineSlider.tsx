'use client';

import { useState, useEffect, useCallback } from 'react';

interface TimelineSliderProps {
  minYear: number;
  maxYear: number;
  value: number;
  onChange: (year: number) => void;
  onToggle?: (enabled: boolean) => void;
  isEnabled?: boolean;
}

export function TimelineSlider({
  minYear,
  maxYear,
  value,
  onChange,
  onToggle,
  isEnabled = false,
}: TimelineSliderProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Calculate percentage for slider thumb position
  const percentage = ((value - minYear) / (maxYear - minYear)) * 100;

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isEnabled) return;

      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        onChange(Math.max(minYear, value - step));
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        onChange(Math.min(maxYear, value + step));
      } else if (e.key === 'Home') {
        e.preventDefault();
        onChange(minYear);
      } else if (e.key === 'End') {
        e.preventDefault();
        onChange(maxYear);
      }
    },
    [isEnabled, minYear, maxYear, value, onChange]
  );

  // Generate decade markers
  const decades: number[] = [];
  const startDecade = Math.ceil(minYear / 10) * 10;
  for (let year = startDecade; year <= maxYear; year += 10) {
    decades.push(year);
  }

  // Filter to show fewer markers on small screens
  const visibleDecades = decades.filter((_, i) => i % 2 === 0 || decades.length <= 8);

  return (
    <div className="fixed bottom-4 left-4 z-20">
      {/* Toggle Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 px-4 py-2 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors ${
          isEnabled ? 'bg-blue-600/80 hover:bg-blue-600' : 'bg-black/70 hover:bg-black/80'
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
          {isEnabled ? value : 'Timeline'}
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
              <div className="w-9 h-5 bg-slate-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* Slider Content */}
          <div className={`px-4 py-4 ${!isEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            {/* Year Display */}
            <div className="text-center mb-4">
              <span className="text-3xl font-bold text-white tabular-nums">{value}</span>
              <p className="text-xs text-slate-400 mt-1">
                Showing overlays active in this year
              </p>
            </div>

            {/* Slider Track */}
            <div className="relative pt-2 pb-6">
              <input
                type="range"
                min={minYear}
                max={maxYear}
                value={value}
                onChange={(e) => onChange(parseInt(e.target.value))}
                onMouseDown={() => setIsDragging(true)}
                onMouseUp={() => setIsDragging(false)}
                onTouchStart={() => setIsDragging(true)}
                onTouchEnd={() => setIsDragging(false)}
                onKeyDown={handleKeyDown}
                disabled={!isEnabled}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900"
                style={{
                  background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${percentage}%, #334155 ${percentage}%, #334155 100%)`,
                }}
              />

              {/* Decade Markers */}
              <div className="absolute left-0 right-0 top-6 flex justify-between px-1">
                {visibleDecades.map((decade) => {
                  const pos = ((decade - minYear) / (maxYear - minYear)) * 100;
                  return (
                    <button
                      key={decade}
                      onClick={() => onChange(decade)}
                      className={`text-[10px] transition-colors ${
                        decade === value
                          ? 'text-blue-400 font-medium'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                      style={{
                        position: 'absolute',
                        left: `${pos}%`,
                        transform: 'translateX(-50%)',
                      }}
                      disabled={!isEnabled}
                    >
                      {decade}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Quick Jump Buttons */}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => onChange(minYear)}
                disabled={!isEnabled || value === minYear}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                {minYear}
              </button>
              <button
                onClick={() => onChange(Math.round((minYear + maxYear) / 2))}
                disabled={!isEnabled}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                {Math.round((minYear + maxYear) / 2)}
              </button>
              <button
                onClick={() => onChange(maxYear)}
                disabled={!isEnabled || value === maxYear}
                className="flex-1 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs rounded transition-colors"
              >
                {maxYear}
              </button>
            </div>
          </div>

          {/* Footer Info */}
          <div className="px-4 py-2 border-t border-slate-700 bg-slate-800/50">
            <p className="text-xs text-slate-500">
              Use arrow keys to adjust year (Shift+Arrow for ±10)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
