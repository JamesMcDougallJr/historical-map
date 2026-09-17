"use client";

import { useState } from "react";
import type { DatePrecision, EventSource, HistoricalEvent } from "@historical-map/domain";
import type { EventInput } from "@historical-map/api-client";

const DATE_PRECISIONS: DatePrecision[] = [
  "day",
  "month",
  "season",
  "year",
  "decade",
  "circa",
];

export interface EventFormProps {
  initial?: HistoricalEvent;
  sources: EventSource[];
  onSubmit: (input: EventInput) => Promise<void>;
  onCancel?: () => void;
  submitLabel: string;
}

export function EventForm({
  initial,
  sources,
  onSubmit,
  onCancel,
  submitLabel,
}: EventFormProps): JSX.Element {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.date ?? "");
  const [datePrecision, setDatePrecision] = useState<DatePrecision | "">(
    initial?.datePrecision ?? "",
  );
  const [dateText, setDateText] = useState(initial?.dateText ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [source, setSource] = useState(initial?.source ?? "");
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title || !date || !description) {
      setError("Title, date, and description are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        title,
        date,
        description,
        datePrecision: datePrecision || undefined,
        dateText: dateText || undefined,
        source: source || undefined,
        sourceId: sourceId || undefined,
        tags: tags
          ? tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
        imageUrl: imageUrl || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="card">
      <div className="field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>

      <div className="row">
        <div className="field">
          <label>Date (YYYY-MM-DD)</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Date precision</label>
          <select
            value={datePrecision}
            onChange={(e) => setDatePrecision(e.target.value as DatePrecision | "")}
          >
            <option value="">(day — default)</option>
            {DATE_PRECISIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Date as written in source (optional)</label>
        <input
          placeholder='e.g. "Spring 1847"'
          value={dateText}
          onChange={(e) => setDateText(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Description</label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      <div className="row">
        <div className="field">
          <label>Source (free text citation)</label>
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <div className="field">
          <label>Source (registered)</label>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">(none)</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Tags (comma-separated)</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="field">
          <label>Image URL</label>
          <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
        </div>
      </div>

      {(initial?.documentId || initial?.anchor) && (
        <p className="muted">
          From ingestion: document {initial.documentId ?? "?"}
          {initial.anchor ? ` (${initial.anchor})` : ""} — not editable here.
        </p>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="row">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
