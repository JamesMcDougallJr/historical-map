'use client';

import { useState, useRef } from 'react';
import { MAX_DOCUMENT_SIZE, ACCEPTED_FILE_TYPES } from '../../constants';

type InputMethod = 'text' | 'file' | 'url';

interface DocumentInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

// Check if we're in development mode (client-side check)
const isDev = process.env.NODE_ENV !== 'production';

export function DocumentInput({ value, onChange, disabled }: DocumentInputProps) {
  const [inputMethod, setInputMethod] = useState<InputMethod>('text');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsLoading(true);

    try {
      if (file.type === 'application/pdf') {
        // Parse PDF via API route (server-side processing)
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/parse-pdf', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to parse PDF');
        }

        onChange(data.text);
      } else if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
        const text = await file.text();
        onChange(text);
      } else {
        setError('Unsupported file type. Please use PDF or TXT files.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setIsLoading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleUrlFetch = async () => {
    if (!urlInput.trim()) {
      setError('Please enter a URL');
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/fetch-content?url=${encodeURIComponent(urlInput.trim())}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch content');
      }

      onChange(data.text);
      setUrlInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch URL');
    } finally {
      setIsLoading(false);
    }
  };

  const tabs: { id: InputMethod; label: string; devOnly?: boolean }[] = [
    { id: 'text', label: 'Paste Text' },
    { id: 'file', label: 'Upload File' },
    { id: 'url', label: 'Fetch URL', devOnly: true },
  ];

  // Filter out dev-only tabs in production
  const visibleTabs = tabs.filter(tab => !tab.devOnly || isDev);

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Document Text
      </label>

      {/* Tab selector */}
      <div className="flex border-b border-neutral-300 dark:border-neutral-600">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setInputMethod(tab.id);
              setError(null);
            }}
            disabled={disabled || isLoading}
            className={`px-4 py-2 text-sm font-medium transition-colors
              ${inputMethod === tab.id
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 -mb-px'
                : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
              }
              disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {tab.label}
            {tab.devOnly && (
              <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">(dev)</span>
            )}
          </button>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* Text input */}
      {inputMethod === 'text' && (
        <>
          <textarea
            id="document-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="Paste article or document text here. The parser will extract historical events with dates..."
            className="w-full h-48 px-4 py-3 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-500 dark:placeholder-neutral-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: 'inherit', WebkitTextFillColor: 'inherit' }}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {value.length.toLocaleString()} characters
            {value.length > MAX_DOCUMENT_SIZE && (
              <span className="text-amber-600 dark:text-amber-400 ml-2">
                (Document is large, consider splitting)
              </span>
            )}
          </p>
        </>
      )}

      {/* File input */}
      {inputMethod === 'file' && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              onChange={handleFileChange}
              disabled={disabled || isLoading}
              className="hidden"
              id="file-upload"
            />
            <label
              htmlFor="file-upload"
              className={`px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors
                ${disabled || isLoading
                  ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
            >
              {isLoading ? 'Processing...' : 'Choose File'}
            </label>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              PDF or TXT files
            </span>
          </div>
          {value && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {value.length.toLocaleString()} characters extracted
            </p>
          )}
        </div>
      )}

      {/* URL input */}
      {inputMethod === 'url' && isDev && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isLoading) {
                  e.preventDefault();
                  handleUrlFetch();
                }
              }}
              disabled={disabled || isLoading}
              placeholder="https://example.com/article"
              className="flex-1 px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder-neutral-500 dark:placeholder-neutral-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={handleUrlFetch}
              disabled={disabled || isLoading || !urlInput.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-400 text-white rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed"
            >
              {isLoading ? 'Fetching...' : 'Fetch'}
            </button>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            URL fetching is only available in development mode
          </p>
          {value && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {value.length.toLocaleString()} characters fetched
            </p>
          )}
        </div>
      )}

      {/* Show extracted content preview for file/url methods */}
      {(inputMethod === 'file' || inputMethod === 'url') && value && (
        <div className="mt-3 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-600">
          <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-2">
            Extracted content preview:
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-4 whitespace-pre-wrap">
            {value.slice(0, 500)}{value.length > 500 ? '...' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
