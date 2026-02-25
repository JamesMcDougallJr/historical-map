// Processing service interface and factory
// Designed for future cloud scaling with swappable implementations

import type { EventProcessingService, ParsedEvent, ParserStrategy } from '../../types';
import { LocalProcessor } from './local-processor';

// Singleton instance
let processorInstance: EventProcessingService | null = null;

/**
 * Factory to get the appropriate processor
 * Currently returns local processor, can be swapped for cloud implementation
 */
export function getProcessor(): EventProcessingService {
  if (!processorInstance) {
    // Future: check environment or config to determine implementation
    // if (process.env.USE_CLOUD_PROCESSOR === 'true') {
    //   processorInstance = new CloudProcessor();
    // } else {
    processorInstance = new LocalProcessor();
    // }
  }
  return processorInstance;
}

/**
 * Parse text synchronously using the configured processor
 * Use this for small documents (<50KB)
 */
export function parseDocument(text: string, strategy: ParserStrategy): ParsedEvent[] {
  const processor = getProcessor();
  return processor.parseSync(text, strategy);
}

/**
 * Reset the processor instance (useful for testing)
 */
export function resetProcessor(): void {
  processorInstance = null;
}
