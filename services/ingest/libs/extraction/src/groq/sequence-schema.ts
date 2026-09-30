import { z } from "zod";

/**
 * The JSON Schema sent as `response_format.json_schema.schema` for the
 * once-per-document sequence-proposal call. Same strict-mode rules as
 * `EXTRACTION_JSON_SCHEMA` in `event-schema.ts` — every property in
 * `required`, `additionalProperties: false` everywhere, no `pattern`/
 * `minItems`/enum-of-refs, since Groq's constrained decoding rejects anything
 * else.
 *
 * `memberEventIds` cannot be constrained to "one of the ids we gave you" in
 * JSON Schema — strict mode has no cross-field/enum-from-input mechanism — so
 * a model-invented id is possible and is filtered out after the fact by
 * `GroqExtractionEngine.parseSequences` against the real id set.
 */
export const SEQUENCE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sequences"],
  properties: {
    sequences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "memberEventIds"],
        properties: {
          title: {
            type: "string",
            description:
              'Short name for this narrative sequence, e.g. "The Outbound Journey". Under 80 characters.',
          },
          description: {
            type: "string",
            description: "One sentence describing what this sequence covers.",
          },
          memberEventIds: {
            type: "array",
            items: { type: "string" },
            description:
              "The ids of the events (exactly as given in the input) that belong to this sequence, in narrative order.",
          },
        },
      },
    },
  },
} as const;

/**
 * Post-validation of the model's response. Strict decoding should make this
 * always pass on shape; it exists for the same reason `extractionResponseSchema`
 * does — to catch the one thing JSON Schema strict mode cannot express, and to
 * fail loudly rather than silently if that guarantee ever regresses.
 */
export const sequenceResponseSchema = z.object({
  sequences: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      memberEventIds: z.array(z.string()),
    }),
  ),
});

export type SequenceResponse = z.infer<typeof sequenceResponseSchema>;
