// Regex-based parser for extracting dates and surrounding context

import type { ParsedEvent } from '../../../types';
import { findDates, extractSentence, generateTitle } from '../date-patterns';
import { generateEventId } from '../../../utils/storage';

export interface Parser {
  name: string;
  description: string;
  parse: (text: string) => ParsedEvent[];
}

/**
 * Regex parser that finds dates in text and extracts surrounding context
 */
export const regexParser: Parser = {
  name: 'regex',
  description: 'Extract events by finding dates in text and their surrounding sentences',

  parse(text: string): ParsedEvent[] {
    const dates = findDates(text);
    const events: ParsedEvent[] = [];

    // Track seen sentences to avoid duplicates
    const seenSentences = new Set<string>();

    for (const date of dates) {
      // Skip very low confidence matches for now
      if (date.confidence < 0.5) continue;

      const sentence = extractSentence(text, date.index);

      // Skip if we've already processed this sentence
      const sentenceKey = sentence.slice(0, 100);
      if (seenSentences.has(sentenceKey)) continue;
      seenSentences.add(sentenceKey);

      const title = generateTitle(sentence, date);

      events.push({
        id: generateEventId(),
        title,
        description: sentence,
        date: date.normalized,
        confidence: date.confidence,
        sourceText: sentence,
      });
    }

    // Sort by date
    return events.sort((a, b) => {
      const dateA = new Date(a.date).getTime() || 0;
      const dateB = new Date(b.date).getTime() || 0;
      return dateA - dateB;
    });
  },
};
