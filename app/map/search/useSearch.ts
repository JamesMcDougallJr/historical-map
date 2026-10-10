// The search bar's request state: debounced lexical typeahead, an explicit
// full search on Enter, the live-highlight request alongside each, and the
// slow-search hint (plans/21-search-ui.md).
//
// Every request goes through one AbortController, so a slow response can
// never overwrite a newer one: starting a request aborts the last, and a
// response is only applied if its controller is still the current one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSearchQuery } from "../utils/search-query";
import type { SearchResponse } from "../types";
import { fetchMatches, fetchSearch, type SearchParams } from "./search-client";

/** Typeahead debounce. */
export const SEARCH_DEBOUNCE_MS = 150;
/**
 * How long an in-flight search runs before the "narrow by time" hint. A
 * starting constant: set the real one from the latency distribution once
 * S3's hybrid mode exists, since that's the path that can actually be slow.
 */
export const SLOW_SEARCH_MS = 800;
const SLOW_HINT_DISMISSED_KEY = "search-slow-hint-dismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(SLOW_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export interface UseSearchOptions {
  /** The timeline filter, when enabled. Search always follows it. */
  timeline: [number, number] | null;
  limitToView: boolean;
  getViewFilter: () => SearchParams["view"];
}

export interface SearchState {
  input: string;
  /** The response for the latest completed request, or null. */
  response: SearchResponse | null;
  loading: boolean;
  /** "waiting": a search has been in flight past SLOW_SEARCH_MS. "after": one finished slowly. */
  slowHint: "waiting" | "after" | null;
  /** Location ids for live highlighting, and whether everything else may be dimmed. */
  highlight: { ids: ReadonlySet<string>; dimOthers: boolean } | null;
  setInput(text: string): void;
  /** Run the full (non-prefix) search now. Resolves with its response, or null if superseded. */
  submit(text?: string): Promise<SearchResponse | null>;
  clear(): void;
  dismissSlowHint(): void;
}

export function useSearch({
  timeline,
  limitToView,
  getViewFilter,
}: UseSearchOptions): SearchState {
  const [input, setInputState] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [matches, setMatches] = useState<{
    locationIds: string[];
    truncated: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [slowHint, setSlowHint] = useState<SearchState["slowHint"]>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrefixRef = useRef(true);
  const inputRef = useRef("");
  const dismissedRef = useRef(false);
  useEffect(() => {
    dismissedRef.current = readDismissed();
  }, []);

  // Options read at request time, so a timeline move doesn't recreate run().
  const optsRef = useRef({ timeline, limitToView, getViewFilter });
  optsRef.current = { timeline, limitToView, getViewFilter };

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current = null;
  }, []);

  const run = useCallback(
    async (text: string, prefix: boolean): Promise<SearchResponse | null> => {
      cancel();
      lastPrefixRef.current = prefix;
      if (!text.trim()) {
        setResponse(null);
        setMatches(null);
        setLoading(false);
        setSlowHint(null);
        return null;
      }

      const { timeline, limitToView, getViewFilter } = optsRef.current;
      const params: SearchParams = {
        q: text,
        prefix,
        mode: "lexical",
        timeline,
        view: limitToView ? getViewFilter() : null,
      };
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setSlowHint(null);

      // The hint suggests the timeline, so it's noise whenever a date filter
      // already applies — the timeline, or a date in the query itself.
      const unfiltered = !timeline && !parseSearchQuery(text).dateRange;
      if (unfiltered && !dismissedRef.current) {
        slowTimerRef.current = setTimeout(() => {
          if (controllerRef.current === controller) setSlowHint("waiting");
        }, SLOW_SEARCH_MS);
      }

      // Live highlighting shares the request's params, debounce and abort.
      fetchMatches(params, controller.signal)
        .then((m) => {
          if (controllerRef.current === controller) setMatches(m);
        })
        .catch(() => {});

      try {
        const res = await fetchSearch(params, controller.signal);
        if (controllerRef.current !== controller) return null;
        if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
        setResponse(res);
        setLoading(false);
        setSlowHint(
          res.timing.unfiltered &&
            res.timing.ms > SLOW_SEARCH_MS &&
            !dismissedRef.current
            ? "after"
            : null,
        );
        return res;
      } catch {
        if (controllerRef.current === controller) {
          setLoading(false);
          setSlowHint(null);
        }
        return null;
      }
    },
    [cancel],
  );

  const setInput = useCallback(
    (text: string) => {
      inputRef.current = text;
      setInputState(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!text.trim()) {
        void run("", true);
        return;
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void run(text, true);
      }, SEARCH_DEBOUNCE_MS);
    },
    [run],
  );

  const submit = useCallback(
    (text?: string) => {
      if (text !== undefined) {
        inputRef.current = text;
        setInputState(text);
      }
      return run(inputRef.current, false);
    },
    [run],
  );

  const clear = useCallback(() => {
    inputRef.current = "";
    setInputState("");
    void run("", true);
  }, [run]);

  // A timeline move (or "limit to view") re-runs the open search, debounced
  // like typing, so results never describe a range the map isn't showing.
  const timelineKey = timeline ? `${timeline[0]}-${timeline[1]}` : "off";
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    if (!inputRef.current.trim()) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void run(inputRef.current, lastPrefixRef.current);
    }, SEARCH_DEBOUNCE_MS);
  }, [timelineKey, limitToView, run]);

  useEffect(() => cancel, [cancel]);

  const dismissSlowHint = useCallback(() => {
    dismissedRef.current = true;
    setSlowHint(null);
    try {
      sessionStorage.setItem(SLOW_HINT_DISMISSED_KEY, "1");
    } catch {
      // Private mode: dismissed for this page's lifetime only.
    }
  }, []);

  const highlight = useMemo(() => {
    if (!input.trim() || !matches) return null;
    const ids = new Set(matches.locationIds);
    // Hits from the list highlight too — the matches request is lexical-only,
    // so semantic hits (S3) reach the map this way.
    for (const hit of response?.hits ?? []) {
      if (hit.kind === "event") ids.add(hit.locationId);
      if (hit.kind === "location") ids.add(hit.id);
    }
    // A capped id list can't claim "only these match", so nothing dims.
    return { ids, dimOthers: !matches.truncated };
  }, [input, matches, response]);

  return {
    input,
    response,
    loading,
    slowHint,
    highlight,
    setInput,
    submit,
    clear,
    dismissSlowHint,
  };
}
