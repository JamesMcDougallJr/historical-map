/**
 * Typed questions/answers for TypeSafe's Jev model.
 *
 * Jev is a "System One" decision model, not a generative LLM: you send it
 * application state plus one or more typed questions, and it returns a typed
 * answer with a probability instead of prose. It supports three question
 * shapes — Choice (pick one of up to 255 options), Score (an ordered rubric)
 * and Noul (yes/no) — and is priced for exactly this: cheap, fast, structured
 * judgment calls alongside a real LLM (reranking, verification, routing),
 * not a replacement for one.
 */

export type JevQuestionKind = "choice" | "score" | "noul";

interface JevQuestionBase {
  /** Caller-chosen key the answer is returned under. */
  id: string;
  /** The judgment being asked for, in plain language. */
  prompt: string;
}

export interface JevChoiceQuestion extends JevQuestionBase {
  kind: "choice";
  /** Up to 255 options; the answer's `value` is an index into this array. */
  options: string[];
}

export interface JevScoreQuestion extends JevQuestionBase {
  kind: "score";
  /** Ordered rubric tiers, low to high; `value` is an index into this array. */
  tiers: string[];
}

export interface JevNoulQuestion extends JevQuestionBase {
  kind: "noul";
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevAnswer {
  id: string;
  /** Index into `options`/`tiers` for choice/score; 0 (no) or 1 (yes) for noul. */
  value: number;
  /** The model's confidence in `value`, 0-1. */
  probability: number;
}

export interface JevRequest {
  /** The application state the questions are judged against. */
  context: string;
  questions: JevQuestion[];
}

export class JevDisabledError extends Error {
  constructor() {
    super("Jev is not configured (JEV_API_KEY unset)");
    this.name = "JevDisabledError";
  }
}

export class JevRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}
