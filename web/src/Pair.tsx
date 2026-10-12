import { useState, type FormEvent } from "react";
import { navigate } from "./nav.ts";

/** Opened from the QR code on a TV: the phone picks what the TV signs in as, and the TV picks it up. */
export function Pair(props: { id: string; host: boolean; initialName: string }) {
  const [asHost, setAsHost] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(props.initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!asHost && !code.trim()) return setError("Enter the party code from your host.");
    if (!name.trim()) return setError("Pick a name for the TV so friends know who's watching.");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pair/${encodeURIComponent(props.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(asHost ? { name: name.trim(), password } : { name: name.trim(), code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="center">
        <div className="card login">
          <h1>All set</h1>
          <p>Your TV is signing in now. You can close this page.</p>
          <button onClick={() => navigate("/")}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Sign in your TV</h1>
        {asHost ? (
          !props.host && (
            <label>
              Server password
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )
        ) : (
          <label>
            Party code
            <input
              className="code"
              autoFocus
              value={code}
              maxLength={12}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
        )}
        <label>
          Name on the TV
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : asHost ? "Sign in TV as host" : "Join on the TV"}
        </button>
        <button type="button" onClick={() => setAsHost(!asHost)}>
          {asHost ? "Join a party instead" : "I'm the host"}
        </button>
      </form>
    </div>
  );
}
