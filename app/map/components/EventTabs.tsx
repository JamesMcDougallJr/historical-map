'use client';

interface EventTabsProps {
  years: string[];
  activeYear: string;
  onYearChange: (year: string) => void;
}

export function EventTabs({ years, activeYear, onYearChange }: EventTabsProps) {
  if (years.length <= 1) return null;

  return (
    <div className="flex gap-1 overflow-x-auto pb-2 mb-3 border-b border-neutral-200 dark:border-neutral-700">
      {years.map((year) => (
        <button
          key={year}
          onClick={() => onYearChange(year)}
          className={`px-3 py-1.5 text-sm font-medium rounded-t transition-colors whitespace-nowrap ${
            year === activeYear
              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-b-2 border-blue-500'
              : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
        >
          {year}
        </button>
      ))}
    </div>
  );
}
