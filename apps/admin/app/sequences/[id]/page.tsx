"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EventGroup, HistoricalLocation } from "@historical-map/domain";
import type { EventSearchResult } from "@historical-map/api-client";
import { mapClient } from "@/lib/client";

interface MemberRow {
  eventId: string;
  title: string;
  dateLabel: string;
  locationName: string;
}

export default function SequenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): JSX.Element {
  const { id } = use(params);
  const router = useRouter();

  const [group, setGroup] = useState<EventGroup | null | undefined>(
    undefined, // undefined = loading, null = not found
  );
  const [members, setMembers] = useState<HistoricalLocation[]>([]);
  const [allGroups, setAllGroups] = useState<EventGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);

  const [parentGroupId, setParentGroupId] = useState("");
  const [savingParent, setSavingParent] = useState(false);

  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<EventSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const reload = (): void => {
    mapClient
      .getEventGroup(id)
      .then((result) => {
        if (!result) {
          setGroup(null);
          return;
        }
        setGroup(result.group);
        setMembers(result.members);
        setTitle(result.group.title);
        setDescription(result.group.description ?? "");
        setParentGroupId(result.group.parentGroupId ?? "");
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => {
    reload();
    mapClient.getEventGroups().then(setAllGroups).catch(() => setAllGroups([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const memberRows: MemberRow[] = (group?.memberEventIds ?? []).flatMap(
    (eventId) => {
      for (const location of members) {
        const event = location.events.find((e) => e.id === eventId);
        if (event) {
          return [
            {
              eventId,
              title: event.title,
              dateLabel: `${event.dateText ?? event.date}${
                event.datePrecision ? ` (${event.datePrecision})` : ""
              }`,
              locationName: location.name,
            },
          ];
        }
      }
      return [];
    },
  );

  const handleDetailsSave = async (): Promise<void> => {
    setSavingDetails(true);
    try {
      const updated = await mapClient.updateEventGroup(id, {
        title,
        description: description || undefined,
      });
      setGroup(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDetails(false);
    }
  };

  const handleParentSave = async (): Promise<void> => {
    setSavingParent(true);
    try {
      const updated = await mapClient.updateEventGroup(id, {
        parentGroupId: parentGroupId || undefined,
      });
      setGroup(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingParent(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirm(`Delete sequence "${group?.title}"?`)) return;
    await mapClient.deleteEventGroup(id);
    router.push("/sequences");
  };

  const setMemberOrder = async (eventIds: string[]): Promise<void> => {
    await mapClient.setEventGroupMembers(id, eventIds);
    reload();
  };

  const handleMoveUp = (index: number): void => {
    if (!group || index <= 0) return;
    const order = [...group.memberEventIds];
    [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
    setMemberOrder(order);
  };

  const handleMoveDown = (index: number): void => {
    if (!group || index >= group.memberEventIds.length - 1) return;
    const order = [...group.memberEventIds];
    [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
    setMemberOrder(order);
  };

  const handleRemove = (eventId: string): void => {
    if (!group) return;
    setMemberOrder(group.memberEventIds.filter((eid) => eid !== eventId));
  };

  const handleSearch = async (): Promise<void> => {
    if (!searchText) return;
    setSearching(true);
    try {
      const results = await mapClient.searchEvents({ q: searchText });
      setSearchResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const handleAddMember = async (eventId: string): Promise<void> => {
    if (!group) return;
    await setMemberOrder([...group.memberEventIds, eventId]);
    setSearchResults([]);
    setSearchText("");
  };

  if (error) {
    return (
      <main className="container">
        <p style={{ color: "var(--danger)" }}>{error}</p>
        <Link href="/sequences">&larr; Back to sequences</Link>
      </main>
    );
  }

  if (group === undefined) {
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );
  }

  if (group === null) {
    return (
      <main className="container">
        <p>Sequence not found.</p>
        <Link href="/sequences">&larr; Back to sequences</Link>
      </main>
    );
  }

  return (
    <main className="container">
      <p>
        <Link href="/sequences">&larr; Back to sequences</Link>
      </p>

      <div className="card">
        <div className="row">
          <div className="field">
            <label>Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={handleDetailsSave}
            disabled={
              savingDetails ||
              (title === group.title &&
                description === (group.description ?? ""))
            }
          >
            {savingDetails ? "Saving…" : "Save details"}
          </button>
          <button className="danger" onClick={handleDelete}>
            Delete sequence
          </button>
        </div>
      </div>

      <h2>Parent sequence</h2>
      <div className="card">
        <div className="row">
          <div className="field">
            <select
              value={parentGroupId}
              onChange={(e) => setParentGroupId(e.target.value)}
            >
              <option value="">(none)</option>
              {allGroups
                .filter((g) => g.id !== id)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <button
          className="primary"
          onClick={handleParentSave}
          disabled={savingParent || parentGroupId === (group.parentGroupId ?? "")}
        >
          {savingParent ? "Saving…" : "Save parent"}
        </button>
      </div>

      <h2>Members ({memberRows.length})</h2>
      {memberRows.map((row, index) => (
        <div key={row.eventId} className="card">
          <strong>{row.title}</strong>{" "}
          <span className="muted">
            — {row.dateLabel} — at {row.locationName}
          </span>
          <div className="row">
            <button onClick={() => handleMoveUp(index)} disabled={index === 0}>
              Up
            </button>
            <button
              onClick={() => handleMoveDown(index)}
              disabled={index === memberRows.length - 1}
            >
              Down
            </button>
            <button className="danger" onClick={() => handleRemove(row.eventId)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {memberRows.length === 0 && <p className="muted">No members yet.</p>}

      <h2>Add member</h2>
      <div className="card">
        <div className="row">
          <div className="field">
            <input
              placeholder="Search events…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>
          <button onClick={handleSearch} disabled={searching || !searchText}>
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        {searchResults.map((result) => (
          <div key={result.event.id} className="row" style={{ alignItems: "center" }}>
            <span>
              {result.event.title} — at {result.location.name} —{" "}
              <span className="muted">{result.event.date}</span>
            </span>
            <button onClick={() => handleAddMember(result.event.id)}>Add</button>
          </div>
        ))}
        {searchResults.length === 0 && searchText && !searching && (
          <p className="muted">No results yet — try a search.</p>
        )}
      </div>
    </main>
  );
}
