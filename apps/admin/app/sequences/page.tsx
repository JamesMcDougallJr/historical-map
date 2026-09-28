"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { EventGroup } from "@historical-map/domain";
import { mapClient } from "@/lib/client";

export default function SequencesPage(): JSX.Element {
  const [groups, setGroups] = useState<EventGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentGroupId, setParentGroupId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const reload = (): void => {
    mapClient
      .getEventGroups()
      .then(setGroups)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => {
    reload();
  }, []);

  const filtered = groups?.filter((g) =>
    g.title.toLowerCase().includes(filter.toLowerCase()),
  );

  const titleFor = (id: string): string =>
    groups?.find((g) => g.id === id)?.title ?? id;

  const handleCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title) {
      setCreateError("Title is required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await mapClient.createEventGroup({
        title,
        description: description || undefined,
        parentGroupId: parentGroupId || undefined,
      });
      setTitle("");
      setDescription("");
      setParentGroupId("");
      reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="container">
      <h1>Sequences</h1>
      <p className="muted">
        Named, orderable groupings of events — e.g. a massacre grouping its
        constituent sub-events.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          Failed to load sequences: {error}
        </div>
      )}

      {!error && !groups && <p>Loading…</p>}

      {groups && (
        <>
          <div className="field">
            <input
              placeholder="Filter by title…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Description</th>
                <th>Members</th>
                <th>Parent</th>
              </tr>
            </thead>
            <tbody>
              {filtered?.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link href={`/sequences/${encodeURIComponent(g.id)}`}>
                      {g.title}
                    </Link>
                  </td>
                  <td className="muted">{g.description ?? ""}</td>
                  <td>{g.memberEventIds.length}</td>
                  <td className="muted">
                    {g.parentGroupId
                      ? `↳ sub-sequence of ${titleFor(g.parentGroupId)}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered?.length === 0 && <p className="muted">No matches.</p>}

          <h2>Create sequence</h2>
          <form onSubmit={handleCreate} className="card">
            <div className="field">
              <label>Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Parent sequence (optional)</label>
              <select
                value={parentGroupId}
                onChange={(e) => setParentGroupId(e.target.value)}
              >
                <option value="">(none)</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
            </div>
            {createError && <p style={{ color: "var(--danger)" }}>{createError}</p>}
            <div className="row">
              <button type="submit" className="primary" disabled={creating}>
                {creating ? "Creating…" : "Create sequence"}
              </button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
