"use client";

import { useState, useCallback, useRef, useEffect } from "react";

interface ExpandableTextProps {
  text: string;
  maxLines?: number;
  className?: string;
  showIndicator?: boolean;
}

export function ExpandableText({
  text,
  maxLines = 3,
  className = "",
  showIndicator = true,
}: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  // Check if text actually needs truncation
  useEffect(() => {
    const checkTruncation = () => {
      if (textRef.current) {
        const element = textRef.current;
        // Compare scrollHeight with clientHeight to detect overflow
        setNeedsTruncation(element.scrollHeight > element.clientHeight + 1);
      }
    };

    // Check on mount and when expanded state changes
    if (!isExpanded) {
      // Small delay to ensure layout is computed
      requestAnimationFrame(checkTruncation);
    }
  }, [isExpanded, text]);

  // Click toggles. This used to count clicks behind a 250ms timer — one click to
  // expand, two to collapse — so there was no way to close without knowing about
  // an unsignposted double-click, and expanding always lagged while it waited for
  // a second click. Same behaviour as handleKeyDown below, on purpose.
  const handleClick = useCallback(() => {
    if (isExpanded) {
      setIsExpanded(false);
    } else if (needsTruncation) {
      setIsExpanded(true);
    }
  }, [isExpanded, needsTruncation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isExpanded && needsTruncation) {
          setIsExpanded(true);
        } else if (isExpanded) {
          setIsExpanded(false);
        }
      } else if (e.key === "Escape" && isExpanded) {
        e.preventDefault();
        setIsExpanded(false);
      }
    },
    [isExpanded, needsTruncation],
  );

  const isInteractive = needsTruncation || isExpanded;

  // Use inline style for line-clamp since Tailwind can't detect dynamic classes
  const clampStyle = !isExpanded
    ? {
        display: "-webkit-box",
        WebkitLineClamp: maxLines,
        WebkitBoxOrient: "vertical" as const,
        overflow: "hidden",
      }
    : {};

  return (
    <div
      onClick={isInteractive ? handleClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-expanded={isInteractive ? isExpanded : undefined}
      // Carries the affordance where showIndicator is off (the event card's title
      // and source), which have no visible label — just the cursor and this.
      title={
        isInteractive
          ? isExpanded
            ? "Click to collapse"
            : "Click to expand"
          : undefined
      }
      className={isInteractive ? "cursor-pointer" : ""}
    >
      <span ref={textRef} className={className} style={clampStyle}>
        {text}
      </span>
      {showIndicator && needsTruncation && (
        <span className="block text-blue-500 dark:text-blue-400 text-xs mt-1 hover:underline">
          {isExpanded ? "Show less" : "Read more"}
        </span>
      )}
    </div>
  );
}
