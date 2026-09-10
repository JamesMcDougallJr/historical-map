import { z } from "zod";

/**
 * The JSON Schema sent as `response_format.json_schema.schema`.
 *
 * **Written strict-mode-native from the start**, because Groq's constrained
 * decoding rejects anything else and retrofitting a permissive schema is
 * fiddly. The rules, all of which this obeys:
 *
 *   - every property appears in `required` — partial-required is rejected
 *   - `additionalProperties: false` on every object
 *   - optional fields are nullable unions, never omitted from `required`
 *   - no `pattern`, `minLength`/`maxLength`, `oneOf`, `allOf`, `not`, `if`
 *
 * Note the last rule: `dateIso` cannot be constrained to a date pattern here,
 * so it is validated after the fact by `extractionResponseSchema` below.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "dateText",
          "dateIso",
          "datePrecision",
          "placeName",
          "confidence",
          "sourceText",
        ],
        properties: {
          title: {
            type: "string",
            description: "Short headline for the event, under 100 characters.",
          },
          description: {
            type: "string",
            description:
              "One or two sentences describing what happened, in your own words.",
          },
          dateText: {
            type: "string",
            description:
              'The date exactly as the document words it, e.g. "Spring 1847", "circa 1850", "May 10, 1869".',
          },
          dateIso: {
            type: ["string", "null"],
            description:
              "A single representative day as YYYY-MM-DD. For an imprecise date pick the earliest plausible day (Spring 1847 -> 1847-03-01; the 1850s -> 1850-01-01). Null only if no year can be determined at all.",
          },
          datePrecision: {
            type: "string",
            enum: ["day", "month", "season", "year", "decade", "circa"],
            description:
              "How precisely the document dates this event. Do not claim more precision than the text supports.",
          },
          placeName: {
            type: ["string", "null"],
            description:
              'Where the event happened, exactly as written, e.g. "Promontory Summit". Null if the text names no place. Never output coordinates.',
          },
          confidence: {
            type: "number",
            description:
              "0 to 1. How confident you are that this is a real, correctly-dated historical event as opposed to a misreading of the text.",
          },
          sourceText: {
            type: "string",
            description:
              "The verbatim sentence or passage this event was drawn from.",
          },
        },
      },
    },
  },
} as const;

/**
 * Post-validation of the model's response.
 *
 * Strict decoding is documented as guaranteeing schema adherence, so this
 * should never fail — which is exactly why it is cheap to keep. It also catches
 * the things JSON Schema strict mode *cannot* express: that `dateIso` is
 * really a date, and that `confidence` is within range.
 */
export const extractionResponseSchema = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      dateText: z.string(),
      dateIso: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      datePrecision: z.enum([
        "day",
        "month",
        "season",
        "year",
        "decade",
        "circa",
      ]),
      placeName: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      sourceText: z.string(),
    }),
  ),
});

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;
