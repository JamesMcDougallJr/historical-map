// POST endpoint for document parsing
// Handles small documents (<50KB) synchronously

import { NextResponse } from 'next/server';
import type { ParsedEvent, ParserStrategy } from '@/app/map/types';
import { parseDocument } from '@/app/map/import/services/processing-service';
import { MAX_DOCUMENT_SIZE, MAX_DOCUMENT_SIZE_KB } from '@/app/map/constants';

interface ParseRequest {
  text: string;
  strategy: ParserStrategy;
}

interface ParseResponse {
  success: boolean;
  events: ParsedEvent[];
  error?: string;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as ParseRequest;
    const { text, strategy } = body;

    // Validate input
    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, events: [], error: 'Text is required' } satisfies ParseResponse,
        { status: 400 }
      );
    }

    if (!strategy || !['regex', 'structured'].includes(strategy)) {
      return NextResponse.json(
        { success: false, events: [], error: 'Invalid parser strategy' } satisfies ParseResponse,
        { status: 400 }
      );
    }

    // Check size limit
    if (text.length > MAX_DOCUMENT_SIZE) {
      return NextResponse.json(
        {
          success: false,
          events: [],
          error: `Text exceeds ${MAX_DOCUMENT_SIZE_KB}KB limit. Consider splitting the document.`,
        } satisfies ParseResponse,
        { status: 413 }
      );
    }

    // Parse the document
    const events = parseDocument(text, strategy);

    return NextResponse.json({
      success: true,
      events,
    } satisfies ParseResponse);
  } catch (error) {
    console.error('Parse error:', error);
    return NextResponse.json(
      {
        success: false,
        events: [],
        error: error instanceof Error ? error.message : 'Unknown parsing error',
      } satisfies ParseResponse,
      { status: 500 }
    );
  }
}
