import express from "express";
import cors from "cors";
import morgan from "morgan";
import { randomUUID } from "node:crypto";

import {
  listTasks,
  createTask,
  deleteTask,
  getTask,
  storageMode,
} from "./db.js";

const PORT = process.env.PORT || 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();

app.use(express.json());
app.use(morgan("tiny"));
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
  })
);

// --- Health check (used by ALB target group + container HEALTHCHECK) ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", storage: storageMode() });
});

// --- List all tasks ---
app.get("/api/tasks", async (_req, res, next) => {
  try {
    const tasks = await listTasks();
    res.json(tasks);
  } catch (err) {
    next(err);
  }
});

// --- Create a task ---
app.post("/api/tasks", async (req, res, next) => {
  try {
    const title = (req.body?.title || "").trim();
    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }
    const task = {
      id: randomUUID(),
      title,
      completed: Boolean(req.body?.completed) || false,
      createdAt: Date.now(),
    };
    await createTask(task);
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

// --- Delete a task ---
app.delete("/api/tasks/:id", async (req, res, next) => {
  try {
    const existing = await getTask(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: "task not found" });
    }
    await deleteTask(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Root ---
app.get("/", (_req, res) => {
  res.json({ service: "sample-app-backend", storage: storageMode() });
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

app.listen(PORT, () => {
  console.log(`sample-app-backend listening on :${PORT} (storage: ${storageMode()})`);
});
