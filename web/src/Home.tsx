import { useEffect, useState, type FormEvent } from "react";
import type { RoomSummary } from "../../shared/protocol.ts";
import { api } from "./api.ts";
import { Library } from "./Library.tsx";
import { navigate } from "./nav.ts";

/** The link friends open to join; it lands on the join screen with the code filled in. */
// A real path rather than #/join/, so Android can open it in the app; the server redirects browsers to #/join/.
export const inviteLink = (code: string) =>
  `${location.origin}/join/${code.toUpperCase()}`;

/** The host's home: pick a movie to start a party (it shows the code; nothing plays until you join), see running parties, or join by code. */
export function Home(props: {
  name: string;
  onRename: () => void;
  onSignOut: () => void;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [started, setStarted] = useState<RoomSummary | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.rooms().then(setRooms, () => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const start = async (mediaId: string) => {
    setError(null);
    try {
      const room = await api.createRoom(mediaId);
      setStarted(room);
      window.scrollTo({ top: 0, behavior: "smooth" });
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

  const end = async (room: RoomSummary) => {
    const title = room.media?.title ?? "this party";
    if (
      !confirm(
        `End ${title} for everyone? Anyone watching goes back to the start screen.`,
      )
    )
      return;
    try {
      await api.endRoom(room.id, props.name);
      setRooms((rs) => rs.filter((r) => r.id !== room.id));
      setStarted((s) => (s?.id === room.id ? null : s));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const id = code.trim().toLowerCase();
    if (id) navigate(`/room/${id}`);
  };

  return (
    <div className="page-wrap">
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

        {started && (
          <section>
            <div className="card started">
              <p className="muted">
                Party ready for <strong>{started.media?.title}</strong>. Share
                the code or the invite link, then join when you're ready to
                watch.
              </p>
              <p className="party-code">{started.id.toUpperCase()}</p>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => navigate(`/room/${started.id}`)}
                >
                  Join party
                </button>
                <button onClick={() => copy(started.id)}>
                  {copied ? "Link copied" : "Copy invite link"}
                </button>
                <button onClick={() => end(started)}>End party</button>
              </div>
            </div>
          </section>
        )}

        <section>
          <h2>Watch parties</h2>
          {rooms.length === 0 ? (
            <p className="muted">No parties right now.</p>
          ) : (
            <ul className="rooms">
              {rooms.map((r) => (
                <li key={r.id}>
                  <button
                    className="item"
                    onClick={() => navigate(`/room/${r.id}`)}
                  >
                    <span className="title">
                      {r.media?.title ?? "Nothing picked yet"}
                    </span>
                    <span className="meta">
                      {r.members.length === 0
                        ? "empty"
                        : [...new Set(r.members.map((m) => m.name))].join(
                            ", ",
                          )}{" "}
                      · code {r.id.toUpperCase()}
                    </span>
                    <span className="action">Join</span>
                  </button>
                  <button className="end" onClick={() => end(r)}>
                    End
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="row join-code" onSubmit={join}>
            <input
              placeholder="Party code"
              value={code}
              maxLength={12}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button>Join</button>
          </form>
        </section>

        <section>
          <h2>Start a party</h2>
          <Library
            actionLabel="Start party"
            onPick={(item) => start(item.id)}
          />
        </section>
      </div>
    </div>
  );
}
