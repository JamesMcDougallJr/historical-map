// Structured format parser for EVENT:/DATE:/DESCRIPTION: blocks

import type { ParsedEvent } from '../../../types';
import type { Parser } from './regex-parser';
import { parseToISO } from '../../../utils/date-utils';
import { generateEventId } from '../../../utils/storage';

/**
 * Structured parser that parses EVENT:/DATE:/DESCRIPTION: format
 *
 * Expected format:
 * EVENT: Golden Spike Ceremony
 * DATE: May 10, 1869
 * DESCRIPTION: The First Transcontinental Railroad was completed at Promontory Summit.
 *
 * Or single-line:
 * EVENT: Golden Spike | DATE: 1869-05-10 | DESCRIPTION: Railroad completed
 */
export const structuredParser: Parser = {
  name: 'structured',
  description: 'Parse structured EVENT:/DATE:/DESCRIPTION: format',

  parse(text: string): ParsedEvent[] {
    const events: ParsedEvent[] = [];

    // Try multi-line format first
    const multiLineEvents = parseMultiLine(text);
    if (multiLineEvents.length > 0) {
      events.push(...multiLineEvents);
    }

    // Also try single-line pipe-separated format
    const singleLineEvents = parseSingleLine(text);
    for (const event of singleLineEvents) {
      // Avoid duplicates by checking titles
      if (!events.some((e) => e.title === event.title)) {
        events.push(event);
      }
    }

    // Sort by date
    return events.sort((a, b) => {
      const dateA = new Date(a.date).getTime() || 0;
      const dateB = new Date(b.date).getTime() || 0;
      return dateA - dateB;
    });
  },
};

/**
 * Parse multi-line EVENT:/DATE:/DESCRIPTION: blocks
 */
function parseMultiLine(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  // Match blocks starting with EVENT:
  const blockPattern = /EVENT:\s*(.+?)(?:\n|\r\n?)DATE:\s*(.+?)(?:\n|\r\n?)(?:DESCRIPTION:\s*)?(.+?)(?=(?:\n\s*\n|EVENT:|$))/gis;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(text)) !== null) {
    const title = match[1]?.trim() ?? '';
    const dateStr = match[2]?.trim() ?? '';
    const description = match[3]?.trim() ?? '';

    if (!title || !dateStr) continue;

    const normalizedDate = parseToISO(dateStr);
    if (!normalizedDate) continue;

    events.push({
      id: generateEventId(),
      title,
      description: description || title,
      date: normalizedDate,
      confidence: 1.0, // Structured format has high confidence
      sourceText: match[0].trim(),
    });
  }

  return events;
}

/**
 * Parse single-line pipe-separated format
 * EVENT: Title | DATE: 1869-05-10 | DESCRIPTION: Description
 */
function parseSingleLine(text: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const lines = text.split(/\n/);

  for (const line of lines) {
    // Check if line contains EVENT: and DATE: with pipe separators
    if (!line.includes('EVENT:') || !line.includes('DATE:')) continue;

    const parts = line.split('|').map((p) => p.trim());
    let title = '';
    let dateStr = '';
    let description = '';

    for (const part of parts) {
      if (part.toLowerCase().startsWith('event:')) {
        title = part.replace(/^event:\s*/i, '').trim();
      } else if (part.toLowerCase().startsWith('date:')) {
        dateStr = part.replace(/^date:\s*/i, '').trim();
      } else if (part.toLowerCase().startsWith('description:')) {
        description = part.replace(/^description:\s*/i, '').trim();
      }
    }

    if (!title || !dateStr) continue;

    const normalizedDate = parseToISO(dateStr);
    if (!normalizedDate) continue;

    events.push({
      id: generateEventId(),
      title,
      description: description || title,
      date: normalizedDate,
      confidence: 1.0,
      sourceText: line.trim(),
    });
  }

  return events;
}
