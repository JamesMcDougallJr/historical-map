import { NextRequest, NextResponse } from 'next/server';
import { FETCH_TIMEOUT_MS, MAX_DOCUMENT_SIZE } from '@/app/map/constants';

/**
 * API endpoint for fetching content from URLs
 * SECURITY: Only available in development environment
 */
export async function GET(request: NextRequest) {
  // Security check: only allow in development
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'URL fetching is disabled in production' },
      { status: 403 }
    );
  }

  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json(
      { error: 'URL parameter is required' },
      { status: 400 }
    );
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid protocol');
    }
  } catch {
    return NextResponse.json(
      { error: 'Invalid URL format. Must be a valid HTTP(S) URL.' },
      { status: 400 }
    );
  }

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HistoricalMapBot/1.0)',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch URL: ${response.status} ${response.statusText}` },
        { status: 502 }
      );
    }

    const html = await response.text();

    // Extract text from HTML
    const text = extractTextFromHtml(html);

    // Return with warning if content is large
    if (text.length > MAX_DOCUMENT_SIZE) {
      return NextResponse.json({
        text,
        url: parsedUrl.toString(),
        warning: `Content is ${Math.round(text.length / 1024)}KB. Large documents may affect parsing performance.`
      });
    }

    return NextResponse.json({ text, url: parsedUrl.toString() });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds` },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 502 }
    );
  }
}

/**
 * Extracts readable text from HTML content
 * Strips tags while preserving structure through line breaks
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style tags with their content
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // Replace block elements with line breaks for structure
  text = text
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|article|section|header|footer|nav|aside)[^>]*>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, ' '); // Remove remaining tags

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  // Clean up whitespace while preserving paragraph structure
  return text
    .replace(/[ \t]+/g, ' ') // Collapse horizontal whitespace
    .replace(/\n[ \t]+/g, '\n') // Remove leading whitespace on lines
    .replace(/[ \t]+\n/g, '\n') // Remove trailing whitespace on lines
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple blank lines
    .trim();
}
