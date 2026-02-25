'use client';

import type { ParserStrategy } from '../../types';

interface ParserSelectorProps {
  value: ParserStrategy;
  onChange: (value: ParserStrategy) => void;
  disabled?: boolean;
}

const PARSER_OPTIONS: Array<{ value: ParserStrategy; label: string; description: string }> = [
  {
    value: 'regex',
    label: 'Regex Date Extraction',
    description: 'Finds dates like "May 10, 1869" and extracts surrounding sentences',
  },
  {
    value: 'structured',
    label: 'Structured Format',
    description: 'Parses EVENT:/DATE:/DESCRIPTION: blocks',
  },
];

export function ParserSelector({ value, onChange, disabled }: ParserSelectorProps) {
  return (
    <div className="space-y-2">
      <label htmlFor="parser-select" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Parser Strategy
      </label>
      <select
        id="parser-select"
        value={value}
        onChange={(e) => onChange(e.target.value as ParserStrategy)}
        disabled={disabled}
        className="w-full px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {PARSER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {PARSER_OPTIONS.find((o) => o.value === value)?.description}
      </p>
    </div>
  );
}
