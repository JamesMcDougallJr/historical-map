// Shared constants for the map feature

/** Maximum document size in bytes for sync processing */
export const MAX_DOCUMENT_SIZE = 50 * 1024; // 50KB

/** Maximum document size in KB (for display purposes) */
export const MAX_DOCUMENT_SIZE_KB = 50;

/** Number of events to display per page in the popup */
export const EVENTS_PER_PAGE = 3;

/** Timeout for URL fetch requests in milliseconds */
export const FETCH_TIMEOUT_MS = 10000; // 10 seconds

/** Accepted file types for document upload */
export const ACCEPTED_FILE_TYPES = '.pdf,.txt';

/** MIME types accepted for upload */
export const ACCEPTED_MIME_TYPES = ['application/pdf', 'text/plain'];
