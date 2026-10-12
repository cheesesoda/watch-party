import { useState, type FormEvent } from "react";
import { api } from "./api.ts";

export function Login(props: { needPassword: boolean; initialName: string; onDone: (name: string) => void }) {
  const [name, setName] = useState(props.initialName);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Pick a name so friends know who's talking.");
    setBusy(true);
    setError(null);
    try {
      if (props.needPassword) await api.login(password);
      props.onDone(name.trim());
    } catch (err) {
      setError((err as Error).message === "Not signed in." ? "Wrong password." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Popcorn Club</h1>
        <label>
          Your name
          <input autoFocus value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        {props.needPassword && (
          <label>
            Server password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
