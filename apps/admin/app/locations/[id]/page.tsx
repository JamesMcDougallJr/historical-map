"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EventSource, HistoricalLocation } from "@historical-map/domain";
import type { EventInput } from "@historical-map/api-client";
import { mapClient } from "@/lib/client";
import { LocationPinEditor } from "@/components/LocationPinEditor";
import { EventForm } from "@/components/EventForm";

export default function LocationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): JSX.Element {
  const { id } = use(params);
  const router = useRouter();

  const [location, setLocation] = useState<HistoricalLocation | null | undefined>(
    undefined, // undefined = loading, null = not found
  );
  const [sources, setSources] = useState<EventSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = (): void => {
    mapClient
      .getLocation(id)
      .then((loc) => {
        setLocation(loc);
        if (loc) setName(loc.name);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  useEffect(() => {
    reload();
    mapClient.getSources().then(setSources).catch(() => setSources([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handlePinMoved = async (
    coordinates: [number, number],
  ): Promise<void> => {
    try {
      const updated = await mapClient.updateLocation(id, { coordinates });
      setLocation(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNameSave = async (): Promise<void> => {
    setSavingName(true);
    try {
      const updated = await mapClient.updateLocation(id, { name });
      setLocation(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingName(false);
    }
  };

  const handleDeleteLocation = async (): Promise<void> => {
    if (!confirm(`Delete "${location?.name}" and all its events?`)) return;
    await mapClient.deleteLocation(id);
    router.push("/");
  };

  const handleAddEvent = async (input: EventInput): Promise<void> => {
    await mapClient.addEvent(id, input);
    setAdding(false);
    reload();
  };

  const handleUpdateEvent = async (
    eventId: string,
    input: EventInput,
  ): Promise<void> => {
    await mapClient.updateEvent(id, eventId, input);
    setEditingEventId(null);
    reload();
  };

  const handleDeleteEvent = async (eventId: string): Promise<void> => {
    if (!confirm("Delete this event?")) return;
    await mapClient.deleteEvent(id, eventId);
    reload();
  };

  if (error) {
    return (
      <main className="container">
        <p style={{ color: "var(--danger)" }}>{error}</p>
        <Link href="/">&larr; Back to locations</Link>
      </main>
    );
  }

  if (location === undefined) {
    return (
      <main className="container">
        <p>Loading…</p>
      </main>
    );
  }

  if (location === null) {
    return (
      <main className="container">
        <p>Location not found.</p>
        <Link href="/">&larr; Back to locations</Link>
      </main>
    );
  }

  return (
    <main className="container">
      <p>
        <Link href="/">&larr; Back to locations</Link>
      </p>

      <div className="card">
        <div className="row">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <button
            className="primary"
            onClick={handleNameSave}
            disabled={savingName || name === location.name}
          >
            {savingName ? "Saving…" : "Save name"}
          </button>
          <button className="danger" onClick={handleDeleteLocation}>
            Delete location
          </button>
        </div>
      </div>

      <h2>Position</h2>
      <p className="muted">Drag the pin to correct its coordinates.</p>
      <LocationPinEditor
        coordinates={location.coordinates}
        onMoved={handlePinMoved}
      />
      <p className="muted">
        {location.coordinates[1].toFixed(5)}, {location.coordinates[0].toFixed(5)}
      </p>

      <h2>Events ({location.events.length})</h2>
      {location.events.map((event) =>
        editingEventId === event.id ? (
          <EventForm
            key={event.id}
            initial={event}
            sources={sources}
            submitLabel="Save event"
            onCancel={() => setEditingEventId(null)}
            onSubmit={(input) => handleUpdateEvent(event.id, input)}
          />
        ) : (
          <div key={event.id} className="card">
            <strong>{event.title}</strong>{" "}
            <span className="muted">
              — {event.dateText ?? event.date}
              {event.datePrecision ? ` (${event.datePrecision})` : ""}
            </span>
            <p>{event.description}</p>
            <div className="row">
              <button onClick={() => setEditingEventId(event.id)}>Edit</button>
              <button className="danger" onClick={() => handleDeleteEvent(event.id)}>
                Delete
              </button>
            </div>
          </div>
        ),
      )}

      <h2>Add event</h2>
      {adding ? (
        <EventForm
          sources={sources}
          submitLabel="Add event"
          onCancel={() => setAdding(false)}
          onSubmit={handleAddEvent}
        />
      ) : (
        <button className="primary" onClick={() => setAdding(true)}>
          Add event
        </button>
      )}
    </main>
  );
}
