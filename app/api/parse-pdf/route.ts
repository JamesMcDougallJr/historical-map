import { NextRequest, NextResponse } from 'next/server';
import { MAX_DOCUMENT_SIZE } from '@/app/map/constants';
import { extractText } from 'unpdf';

/**
 * API endpoint for parsing PDF files
 * Extracts text content from uploaded PDF files
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'File must be a PDF' },
        { status: 400 }
      );
    }

    if (file.size > MAX_DOCUMENT_SIZE * 10) {
      // Allow larger PDFs since text extraction compresses them
      return NextResponse.json(
        { error: 'File too large. Maximum size is 500KB.' },
        { status: 413 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();

    // Use unpdf for serverless-compatible PDF parsing
    const { text: pages } = await extractText(new Uint8Array(arrayBuffer));

    // Join pages and clean up the text while preserving paragraph structure
    const text = pages
      .join('\n\n')
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple blank lines
      .trim();

    if (text.length > MAX_DOCUMENT_SIZE) {
      return NextResponse.json(
        {
          text,
          warning: `Extracted text is ${Math.round(text.length / 1024)}KB. Consider splitting for better processing.`
        }
      );
    }

    return NextResponse.json({ text });
  } catch (error) {
    console.error('PDF parsing error:', error);
    return NextResponse.json(
      { error: `Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}
