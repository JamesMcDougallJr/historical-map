'use client';

import { useState, useRef } from 'react';
import type { HistoricalOverlay, OverlaySource } from '../types';
import { generateOverlayId, getSourceAttribution } from '../utils/overlays';

interface LayerControlProps {
  overlays: HistoricalOverlay[];
  onToggleOverlay: (id: string) => void;
  onOpacityChange: (id: string, opacity: number) => void;
  onAddOverlay: (overlay: HistoricalOverlay) => void;
  onRemoveOverlay: (id: string) => void;
  onReorderOverlays?: (overlays: HistoricalOverlay[]) => void;
  isLoading?: Record<string, boolean>;
}

export function LayerControl({
  overlays,
  onToggleOverlay,
  onOpacityChange,
  onAddOverlay,
  onRemoveOverlay,
  onReorderOverlays,
  isLoading = {},
}: LayerControlProps): JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newOverlayUrl, setNewOverlayUrl] = useState('');
  const [newOverlayName, setNewOverlayName] = useState('');
  const [newOverlaySource, setNewOverlaySource] = useState<OverlaySource>('allmaps');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragCounter = useRef(0);

  const handleAddOverlay = () => {
    if (!newOverlayUrl.trim() || !newOverlayName.trim()) return;

    const overlay: HistoricalOverlay = {
      id: generateOverlayId(),
      name: newOverlayName.trim(),
      yearRange: [1800, 2000],
      source: newOverlaySource,
      annotationUrl: newOverlaySource === 'allmaps' ? newOverlayUrl.trim() : undefined,
      tileUrl: newOverlaySource !== 'allmaps' ? newOverlayUrl.trim() : undefined,
      opacity: 0.7,
      attribution: getSourceAttribution(newOverlaySource),
      enabled: true,
    };

    onAddOverlay(overlay);
    setNewOverlayUrl('');
    setNewOverlayName('');
    setShowAddForm(false);
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    // Add slight delay for visual feedback
    setTimeout(() => {
      const target = e.target as HTMLElement;
      target.style.opacity = '0.5';
    }, 0);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    const target = e.target as HTMLElement;
    target.style.opacity = '1';
    setDraggedId(null);
    setDragOverId(null);
    dragCounter.current = 0;
  };

  const handleDragEnter = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    dragCounter.current++;
    if (id !== draggedId) {
      setDragOverId(id);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragOverId(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    dragCounter.current = 0;

    if (!draggedId || draggedId === targetId || !onReorderOverlays) {
      setDragOverId(null);
      return;
    }

    const draggedIndex = overlays.findIndex((o) => o.id === draggedId);
    const targetIndex = overlays.findIndex((o) => o.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDragOverId(null);
      return;
    }

    const newOverlays = [...overlays];
    const [draggedItem] = newOverlays.splice(draggedIndex, 1);
    if (!draggedItem) {
      setDragOverId(null);
      return;
    }
    newOverlays.splice(targetIndex, 0, draggedItem);

    // Update zIndex based on new order
    const reorderedOverlays = newOverlays.map((overlay, index) => ({
      ...overlay,
      zIndex: index + 1,
    }));

    onReorderOverlays(reorderedOverlays);
    setDragOverId(null);
  };

  const enabledCount = overlays.filter((o) => o.enabled).length;

  return (
    <div className="fixed bottom-4 right-4 z-20">
      {/* Toggle Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 px-4 py-2 bg-black/70 hover:bg-black/80 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors"
        aria-label="Toggle layer controls"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        <span className="text-sm font-medium">Layers</span>
        {enabledCount > 0 && (
          <span className="bg-blue-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {enabledCount}
          </span>
        )}
      </button>

      {/* Expanded Panel */}
      {isExpanded && (
        <div className="absolute bottom-12 right-0 w-80 bg-slate-900/95 backdrop-blur-sm rounded-lg shadow-xl border border-slate-700 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
            <h3 className="text-white font-medium">Historical Overlays</h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-1"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
            </button>
          </div>

          {/* Add Form */}
          {showAddForm && (
            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/50">
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Name</label>
                  <input
                    type="text"
                    value={newOverlayName}
                    onChange={(e) => setNewOverlayName(e.target.value)}
                    placeholder="e.g., 1890 Railroad Map"
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Source Type</label>
                  <select
                    value={newOverlaySource}
                    onChange={(e) => setNewOverlaySource(e.target.value as OverlaySource)}
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="allmaps">Allmaps (IIIF)</option>
                    <option value="custom">Custom XYZ/WMS</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    {newOverlaySource === 'allmaps' ? 'Allmaps Annotation URL' : 'Tile URL'}
                  </label>
                  <input
                    type="url"
                    value={newOverlayUrl}
                    onChange={(e) => setNewOverlayUrl(e.target.value)}
                    placeholder={
                      newOverlaySource === 'allmaps'
                        ? 'https://annotations.allmaps.org/maps/...'
                        : 'https://tiles.example.com/{z}/{x}/{y}.png'
                    }
                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddOverlay}
                    disabled={!newOverlayUrl.trim() || !newOverlayName.trim()}
                    className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
                  >
                    Add Layer
                  </button>
                  <button
                    onClick={() => setShowAddForm(false)}
                    className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Reorder hint */}
          {onReorderOverlays && overlays.length > 1 && (
            <div className="px-4 py-2 bg-slate-800/30 border-b border-slate-700/50">
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                Drag to reorder layers
              </p>
            </div>
          )}

          {/* Layer List */}
          <div className="max-h-80 overflow-y-auto">
            {overlays.length === 0 ? (
              <div className="px-4 py-6 text-center text-slate-400 text-sm">
                No overlays available.
                <br />
                <button
                  onClick={() => setShowAddForm(true)}
                  className="text-blue-400 hover:text-blue-300 mt-2"
                >
                  Add your first overlay
                </button>
              </div>
            ) : (
              overlays.map((overlay) => (
                <div
                  key={overlay.id}
                  draggable={!!onReorderOverlays}
                  onDragStart={(e) => handleDragStart(e, overlay.id)}
                  onDragEnd={handleDragEnd}
                  onDragEnter={(e) => handleDragEnter(e, overlay.id)}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, overlay.id)}
                  className={`px-4 py-3 border-b border-slate-700/50 last:border-b-0 transition-all ${
                    overlay.enabled ? 'bg-slate-800/30' : ''
                  } ${dragOverId === overlay.id ? 'border-t-2 border-t-blue-500' : ''} ${
                    onReorderOverlays ? 'cursor-grab active:cursor-grabbing' : ''
                  }`}
                >
                  {/* Layer Header */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-start gap-3">
                      {/* Drag Handle */}
                      {onReorderOverlays && (
                        <div className="text-slate-500 mt-1 select-none">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="9" cy="5" r="1.5" />
                            <circle cx="15" cy="5" r="1.5" />
                            <circle cx="9" cy="12" r="1.5" />
                            <circle cx="15" cy="12" r="1.5" />
                            <circle cx="9" cy="19" r="1.5" />
                            <circle cx="15" cy="19" r="1.5" />
                          </svg>
                        </div>
                      )}
                      <label className="relative inline-flex items-center cursor-pointer mt-0.5">
                        <input
                          type="checkbox"
                          checked={overlay.enabled}
                          onChange={() => onToggleOverlay(overlay.id)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                      </label>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white text-sm font-medium truncate">
                            {overlay.name}
                          </span>
                          {isLoading[overlay.id] && (
                            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                          )}
                        </div>
                        <span className="text-xs text-slate-400">
                          {overlay.yearRange[0]}–{overlay.yearRange[1]}
                        </span>
                        {overlay.description && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                            {overlay.description}
                          </p>
                        )}
                      </div>
                    </div>
                    {overlay.source === 'allmaps' || overlay.source === 'custom' ? (
                      <button
                        onClick={() => onRemoveOverlay(overlay.id)}
                        className="text-slate-500 hover:text-red-400 transition-colors p-1"
                        aria-label={`Remove ${overlay.name}`}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    ) : null}
                  </div>

                  {/* Opacity Slider - Only show when enabled */}
                  {overlay.enabled && (
                    <div className="flex items-center gap-3 mt-2 pl-12">
                      <span className="text-xs text-slate-400 w-14">Opacity</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={overlay.opacity * 100}
                        onChange={(e) =>
                          onOpacityChange(overlay.id, parseInt(e.target.value) / 100)
                        }
                        className="flex-1 h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />
                      <span className="text-xs text-slate-400 w-8">
                        {Math.round(overlay.opacity * 100)}%
                      </span>
                    </div>
                  )}

                  {/* Source Badge */}
                  <div className="mt-2 pl-12">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 bg-slate-800 px-2 py-0.5 rounded">
                      {overlay.source}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer Info */}
          <div className="px-4 py-2 border-t border-slate-700 bg-slate-800/50">
            <p className="text-xs text-slate-500">
              Find maps at{' '}
              <a
                href="https://editor.allmaps.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300"
              >
                Allmaps Editor
              </a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
