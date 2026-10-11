import { useEffect, useState } from "react";
import type { RoomSummary } from "../../shared/protocol.ts";
import { api } from "./api.ts";
import { navigate } from "./nav.ts";
import { Library } from "./Library.tsx";

export function Home(props: { name: string; onRename: () => void; onSignOut: () => void }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.rooms().then(setRooms, () => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const start = async (mediaId?: string) => {
    try {
      const room = await api.createRoom(mediaId);
      navigate(`/room/${room.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <h1>Watch Party</h1>
        <span className="spacer" />
        <span className="muted">
          Watching as <strong>{props.name}</strong>
        </span>
        <button onClick={props.onRename}>Change name</button>
        <button onClick={props.onSignOut}>Sign out</button>
      </header>

      {error && <p className="error">{error}</p>}

      <section>
        <h2>Watch parties</h2>
        {rooms.length === 0 ? (
          <p className="muted">Nobody is watching yet. Pick something below to start a party.</p>
        ) : (
          <ul className="rooms">
            {rooms.map((r) => (
              <li key={r.id}>
                <button className="item" onClick={() => navigate(`/room/${r.id}`)}>
                  <span className="title">{r.media?.title ?? "Nothing selected"}</span>
                  <span className="meta">
                    {r.members.length === 0 ? "empty" : [...new Set(r.members.map((m) => m.name))].join(", ")} · code {r.id}
                  </span>
                  <span className="action">Join</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Library</h2>
        <Library actionLabel="Start party" onPick={(item) => start(item.id)} />
      </section>
    </div>
  );
}
