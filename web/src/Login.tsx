import { useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { navigate } from "./nav.ts";
import { Logo } from "./Logo.tsx";

/** The first screen for anyone who isn't the host: start a party (needs the password) or join one with a code. */
export function Landing() {
  return (
    <div className="center">
      <div className="card login">
        <Logo />
        <button className="primary big" onClick={() => navigate("/join/")}>
          Join a party
        </button>
        <button className="big" onClick={() => navigate("/start")}>
          Start a party
        </button>
        <p className="muted small">Joining needs the party code from your host. Starting one needs the server password.</p>
      </div>
    </div>
  );
}

/** Host sign-in. Also asks for a name, which is all it asks once the password is known. */
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
        <h1>Start a party</h1>
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
        {props.needPassword && (
          <button type="button" onClick={() => navigate("/")}>
            Back
          </button>
        )}
      </form>
    </div>
  );
}

/** Join a party with the code the host shared. */
export function Join(props: { initialName: string; initialCode: string; onDone: (name: string, roomId: string) => void }) {
  const [name, setName] = useState(props.initialName);
  const [code, setCode] = useState(props.initialCode.toUpperCase());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return setError("Enter the party code from your host.");
    if (!name.trim()) return setError("Pick a name so friends know who's talking.");
    setBusy(true);
    setError(null);
    try {
      const room = await api.join(code);
      props.onDone(name.trim(), room.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>Join a party</h1>
        <label>
          Party code
          <input
            className="code"
            autoFocus={!props.initialCode}
            value={code}
            maxLength={12}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
        <label>
          Your name
          <input autoFocus={Boolean(props.initialCode)} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Joining…" : "Join"}
        </button>
        <button type="button" onClick={() => navigate("/")}>
          Back
        </button>
      </form>
    </div>
  );
}
