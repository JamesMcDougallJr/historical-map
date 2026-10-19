"use client";

import { useState, useRef, useEffect } from "react";

interface MapMenuProps {
  onRefresh?: () => void;
  importHref: string;
  onSetDefaultView: () => void;
}

export function MapMenu({
  onRefresh,
  importHref,
  onSetDefaultView,
}: MapMenuProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
  const containerRef = useRef<HTMLDivElement>(null);

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

  const handleSetDefaultView = () => {
    onSetDefaultView();
    // Stay open so "Saved ✓" is visible — this is the action's only feedback.
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 1500);
  };

  const itemClass =
    "block px-4 py-2.5 text-sm text-white hover:bg-slate-800/50 text-left w-full";

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="p-2 bg-black/60 hover:bg-black/80 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors"
        aria-label="Map actions"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>

      {isExpanded && (
        <div className="absolute top-12 right-0 w-56 bg-slate-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-slate-700 overflow-hidden z-10">
          {onRefresh && (
            <button
              onClick={() => {
                onRefresh();
                setIsExpanded(false);
              }}
              className={itemClass}
            >
              Refresh
            </button>
          )}
          <a href={importHref} className={itemClass}>
            Import Events
          </a>
          <button onClick={handleSetDefaultView} className={itemClass}>
            {saveStatus === "saved" ? "Saved ✓" : "Set as Default View"}
          </button>
        </div>
      )}
    </div>
  );
}
