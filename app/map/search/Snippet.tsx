// Renders a search snippet. Matches arrive wrapped in SNIPPET_MARK_START/END
// sentinels (control characters), never HTML: source text is untrusted, so it
// is split on the sentinels and every piece rendered as a text node. A
// snippet containing `<img onerror=…>` therefore shows those characters and
// creates no element.

import { SNIPPET_MARK_END, SNIPPET_MARK_START } from "@historical-map/domain";

export function snippetParts(
  snippet: string,
): Array<{ text: string; mark: boolean }> {
  const parts: Array<{ text: string; mark: boolean }> = [];
  let rest = snippet;
  while (rest.length) {
    const start = rest.indexOf(SNIPPET_MARK_START);
    if (start < 0) {
      parts.push({ text: rest, mark: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), mark: false });
    const end = rest.indexOf(SNIPPET_MARK_END, start + 1);
    if (end < 0) {
      parts.push({ text: rest.slice(start + 1), mark: false });
      break;
    }
    parts.push({ text: rest.slice(start + 1, end), mark: true });
    rest = rest.slice(end + 1);
  }
  return parts.filter((p) => p.text.length > 0);
}

export function Snippet({
  text,
  className,
}: {
  text: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={className}>
      {snippetParts(text).map((part, i) =>
        part.mark ? (
          <mark
            key={i}
            className="bg-yellow-200/80 text-inherit rounded-sm px-0.5"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
