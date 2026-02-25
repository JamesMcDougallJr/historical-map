// Local in-process implementation of EventProcessingService

import type { EventProcessingService, ParsedEvent, ParserStrategy } from '../../types';
import { getParser } from '../utils/parsers';

/**
 * Local processor that runs parsing in the same Node.js process
 * Suitable for documents under 50KB
 */
export class LocalProcessor implements EventProcessingService {
  /**
   * Parse text synchronously
   * @param text - Document text to parse
   * @param strategy - Parser strategy to use ('regex' or 'structured')
   * @returns Array of parsed events
   */
  parseSync(text: string, strategy: ParserStrategy): ParsedEvent[] {
    const parser = getParser(strategy);

    if (!parser) {
      console.warn(`Unknown parser strategy: ${strategy}, falling back to regex`);
      const fallbackParser = getParser('regex');
      return fallbackParser ? fallbackParser.parse(text) : [];
    }

    return parser.parse(text);
  }

  // Future: Implement job-based async methods for cloud migration
  // async createJob(text: string, strategy: string): Promise<string> {
  //   throw new Error('Job-based processing not implemented in local processor');
  // }
  //
  // async getJobStatus(jobId: string): Promise<ProcessingJob> {
  //   throw new Error('Job-based processing not implemented in local processor');
  // }
  //
  // async cancelJob(jobId: string): Promise<void> {
  //   throw new Error('Job-based processing not implemented in local processor');
  // }
}
