"use client";

import { useEffect, useState } from "react";

export default function MapLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Listen for fullscreen changes from the map component
  useEffect(() => {
    const handleFullscreenChange = (e: CustomEvent<boolean>) => {
      setIsFullscreen(e.detail);
    };
    window.addEventListener(
      "map-fullscreen-change",
      handleFullscreenChange as EventListener,
    );
    return () => {
      window.removeEventListener(
        "map-fullscreen-change",
        handleFullscreenChange as EventListener,
      );
    };
  }, []);

  // Break out of any parent container constraints using CSS
  // Fill full viewport height (standalone app — no navbar offset)
  // No overflow restriction so OpenLayers popups can render outside bounds
  // Fullscreen mode: fill entire viewport with fixed positioning
  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 h-screen w-screen z-50 bg-slate-900"
          : "w-screen relative left-1/2 -translate-x-1/2 h-screen overflow-hidden"
      }
    >
      {children}
    </div>
  );
}
