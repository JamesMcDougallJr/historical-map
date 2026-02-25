'use client';

interface EventPaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function EventPagination({
  currentPage,
  totalPages,
  onPageChange,
}: EventPaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between pt-3 mt-3 border-t border-neutral-200 dark:border-neutral-700">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 0}
        className="px-3 py-1 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        ← Previous
      </button>
      <span className="text-sm text-neutral-500 dark:text-neutral-400">
        {currentPage + 1} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= totalPages - 1}
        className="px-3 py-1 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Next →
      </button>
    </div>
  );
}
