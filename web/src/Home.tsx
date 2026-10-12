import { useEffect, useState, type FormEvent } from "react";
import type { RoomSummary } from "../../shared/protocol.ts";
import { api } from "./api.ts";
import { navigate } from "./nav.ts";

/** The link friends open to join; it lands on the join screen with the code filled in. */
export const inviteLink = (code: string) => `${location.origin}${location.pathname}#/join/${code.toUpperCase()}`;

/** The host's home: start a party, see the ones running, or join one by code. */
export function Home(props: { name: string; onRename: () => void; onSignOut: () => void }) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [started, setStarted] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.rooms().then(setRooms, () => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const start = async () => {
    setError(null);
    try {
      const room = await api.createRoom();
      setStarted(room.id);
      setRooms((rs) => [...rs.filter((r) => r.id !== room.id), room]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this invite link", inviteLink(id));
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const id = code.trim().toLowerCase();
    if (id) navigate(`/room/${id}`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <h1>Popcorn Club</h1>
        <span className="spacer" />
        <span className="muted">
          Hosting as <strong>{props.name}</strong>
        </span>
        <button onClick={props.onRename}>Change name</button>
        <button onClick={props.onSignOut}>Sign out</button>
      </header>

      {error && <p className="error">{error}</p>}

      <section>
        {started ? (
          <div className="card started">
            <p className="muted">Your party is ready. Share the code or the invite link, then join and pick something to watch.</p>
            <p className="party-code">{started.toUpperCase()}</p>
            <div className="row">
              <button className="primary" onClick={() => navigate(`/room/${started}`)}>
                Join party
              </button>
              <button onClick={() => copy(started)}>{copied ? "Link copied" : "Copy invite link"}</button>
            </div>
          </div>
        ) : (
          <button className="primary big" onClick={start}>
            Start a party
          </button>
        )}
      </section>

      <section>
        <h2>Watch parties</h2>
        {rooms.length === 0 ? (
          <p className="muted">No parties right now.</p>
        ) : (
          <ul className="rooms">
            {rooms.map((r) => (
              <li key={r.id}>
                <button className="item" onClick={() => navigate(`/room/${r.id}`)}>
                  <span className="title">{r.media?.title ?? "Nothing picked yet"}</span>
                  <span className="meta">
                    {r.members.length === 0 ? "empty" : [...new Set(r.members.map((m) => m.name))].join(", ")} · code {r.id.toUpperCase()}
                  </span>
                  <span className="action">Join</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="row join-code" onSubmit={join}>
          <input placeholder="Party code" value={code} maxLength={12} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button>Join</button>
        </form>
      </section>
    </div>
  );
}
