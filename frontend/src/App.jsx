import { useEffect, useState } from "react";
import { fetchTasks, addTask, removeTask, apiBase } from "./api.js";

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setTasks(await fetchTasks());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onAdd(e) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setSubmitting(true);
    setError("");
    try {
      const task = await addTask(value);
      setTasks((prev) => [task, ...prev]);
      setTitle("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(id) {
    setError("");
    const prev = tasks;
    setTasks((t) => t.filter((x) => x.id !== id)); // optimistic
    try {
      await removeTask(id);
    } catch (err) {
      setError(err.message);
      setTasks(prev); // rollback
    }
  }

  return (
    <div className="container">
      <header>
        <h1>Tasks</h1>
        <p className="subtitle">
          React (Amplify) → Express (ECS) → DynamoDB
        </p>
      </header>

      <form className="add-form" onSubmit={onAdd}>
        <input
          type="text"
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || !title.trim()}>
          {submitting ? "Adding…" : "Add"}
        </button>
      </form>

      {error && <div className="error">⚠ {error}</div>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="muted">No tasks yet. Add one above.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <span>{t.title}</span>
              <button
                className="delete"
                onClick={() => onDelete(t.id)}
                aria-label={`Delete ${t.title}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer>
        <small className="muted">API: {apiBase()}</small>
      </footer>
    </div>
  );
}
