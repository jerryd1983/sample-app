// Resolve the API base URL.
// - In production (Amplify), VITE_API_BASE_URL points at the ALB/ECS endpoint.
// - In local dev, leave it blank and requests go to the same origin ("/api/...").
const BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function url(path) {
  return `${BASE}${path}`;
}

async function handle(res) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function fetchTasks() {
  return handle(await fetch(url("/api/tasks")));
}

export async function addTask(title) {
  return handle(
    await fetch(url("/api/tasks"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    })
  );
}

export async function removeTask(id) {
  return handle(
    await fetch(url(`/api/tasks/${id}`), { method: "DELETE" })
  );
}

export function apiBase() {
  return BASE || "(same origin)";
}
