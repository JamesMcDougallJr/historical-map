"use client";

// Where the document and sequence panels render: a side sheet over the map
// on tablets and desktops (~50% width on a portrait tablet), a bottom sheet
// on phones. One wrapper so each panel is written once.

import { useState, type ReactNode } from "react";
import { BottomSheet, type SheetSnap } from "./BottomSheet";
import type { SearchLayout } from "./SearchBox";

export function SearchPanel({
  layout,
  title,
  onClose,
  children,
  testId,
}: {
  layout: SearchLayout;
  title: string;
  onClose(): void;
  children: ReactNode;
  testId: string;
}): JSX.Element {
  const [snap, setSnap] = useState<SheetSnap>("half");
  const header = (
    <div className="flex items-start gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
      <h2
        className="flex-1 text-base font-semibold text-slate-900 dark:text-slate-100"
        data-testid={`${testId}-title`}
      >
        {title}
      </h2>
      <button
        type="button"
        className="search-touch-target -m-1 p-2 text-slate-500 hover:text-slate-900"
        aria-label="Close panel"
        data-testid={`${testId}-close`}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );

  if (layout === "phone") {
    return (
      <BottomSheet snap={snap} onSnapChange={setSnap} label={title}>
        <div data-testid={testId}>
          {header}
          {children}
        </div>
      </BottomSheet>
    );
  }
  return (
    <aside
      aria-label={title}
      data-testid={testId}
      className={`absolute right-0 top-0 bottom-0 z-30 flex flex-col bg-white/97 dark:bg-slate-900/97 shadow-2xl border-l border-slate-200 dark:border-slate-700 backdrop-blur-sm ${
        layout === "desktop" ? "w-[26rem]" : "w-1/2"
      }`}
    >
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}
