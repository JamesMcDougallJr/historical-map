/**
 * Jev is TypeSafe's "System One" decision model: you send it `state` plus
 * named, typed questions, and it returns typed answers with probabilities
 * instead of prose. Questions are built with the SDK's `noul` (yes/no),
 * `choice` and `score` helpers; those and their answer types are re-exported
 * from the `@app/jev` barrel so call sites never import the SDK directly.
 */

export class JevDisabledError extends Error {
  constructor() {
    super("Jev is not configured (JEV_API_KEY unset)");
    this.name = "JevDisabledError";
  }
}
