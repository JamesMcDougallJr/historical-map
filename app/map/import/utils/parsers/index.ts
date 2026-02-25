// Parser registry

import type { ParserStrategy } from '../../../types';
import { regexParser, type Parser } from './regex-parser';
import { structuredParser } from './structured-parser';

// Registry of all available parsers
const parsers: Record<ParserStrategy, Parser> = {
  regex: regexParser,
  structured: structuredParser,
};

/**
 * Get a parser by strategy name
 */
export function getParser(strategy: ParserStrategy): Parser | undefined {
  return parsers[strategy];
}

/**
 * Get all available parser strategies
 */
export function getAvailableStrategies(): Array<{
  name: ParserStrategy;
  description: string;
}> {
  return Object.entries(parsers).map(([name, parser]) => ({
    name: name as ParserStrategy,
    description: parser.description,
  }));
}

/**
 * Check if a strategy is valid
 */
export function isValidStrategy(strategy: string): strategy is ParserStrategy {
  return strategy in parsers;
}

export type { Parser };
