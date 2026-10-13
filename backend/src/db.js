import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE = process.env.TASKS_TABLE || "Tasks";
const ENDPOINT = process.env.DYNAMODB_ENDPOINT || undefined;

/**
 * A tiny data-access layer for Tasks.
 *
 * It tries to talk to DynamoDB. If DynamoDB is unreachable (e.g. running the
 * demo locally before any AWS resources exist), it transparently falls back
 * to an in-memory store so the API still works.
 */

let docClient = null;
let useMemory = false;
const memory = new Map(); // id -> task

try {
  const client = new DynamoDBClient({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
  });
  docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
} catch (err) {
  console.warn("Could not init DynamoDB client, using in-memory store:", err.message);
  useMemory = true;
}

function fallbackToMemory(err) {
  if (!useMemory) {
    console.warn(
      `DynamoDB unavailable (${err?.name || err?.message}). Falling back to in-memory store.`
    );
    useMemory = true;
  }
}

export async function listTasks() {
  if (useMemory) {
    return [...memory.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  try {
    const out = await docClient.send(new ScanCommand({ TableName: TABLE }));
    return (out.Items || []).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    fallbackToMemory(err);
    return listTasks();
  }
}

export async function getTask(id) {
  if (useMemory) {
    return memory.get(id) || null;
  }
  try {
    const out = await docClient.send(
      new GetCommand({ TableName: TABLE, Key: { id } })
    );
    return out.Item || null;
  } catch (err) {
    fallbackToMemory(err);
    return getTask(id);
  }
}

export async function createTask(task) {
  if (useMemory) {
    memory.set(task.id, task);
    return task;
  }
  try {
    await docClient.send(new PutCommand({ TableName: TABLE, Item: task }));
    return task;
  } catch (err) {
    fallbackToMemory(err);
    return createTask(task);
  }
}

export async function deleteTask(id) {
  if (useMemory) {
    return memory.delete(id);
  }
  try {
    await docClient.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
    return true;
  } catch (err) {
    fallbackToMemory(err);
    return deleteTask(id);
  }
}

export function storageMode() {
  return useMemory ? "in-memory" : "dynamodb";
}
