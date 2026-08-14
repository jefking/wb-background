import { createTaskRuntime } from "../runtime-sdk/index.js";
import { registerExampleTask } from "./task.js";

const MAX_VISIBLE_RUNS = 25;
const runState = document.querySelector("#run-state");
const activityLog = document.querySelector("#activity-log");
const emptyActivity = document.querySelector("#activity-empty");
let completedRuns = 0;

function appendActivity(outcome, detail) {
  const now = new Date();
  const timestamp = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const item = document.createElement("li");
  item.className = outcome;

  const time = document.createElement("time");
  time.className = "time";
  time.dateTime = now.toISOString();
  time.textContent = timestamp;

  const result = document.createElement("span");
  result.className = "outcome";
  result.textContent = outcome;

  const message = document.createElement("span");
  message.className = "detail";
  message.textContent = detail;

  item.append(time, result, message);
  activityLog.prepend(item);
  emptyActivity.hidden = true;

  while (activityLog.children.length > MAX_VISIBLE_RUNS) {
    activityLog.lastElementChild.remove();
  }
  return timestamp;
}

function recordSuccess(message) {
  completedRuns += 1;
  const timestamp = appendActivity("success", message);
  runState.textContent = `Run ${completedRuns} · ${timestamp}`;
  console.log(message);
}

function recordError(error, taskId) {
  const detail = `${taskId}: ${error?.message ?? "Task failed."}`;
  const timestamp = appendActivity("error", detail);
  runState.textContent = `Last error · ${timestamp}`;
  console.error(`Task “${taskId}” failed:`, error);
}

const runtime = createTaskRuntime({
  trustedHostOrigin: "http://127.0.0.1:8000",
  onTaskError: recordError
});
registerExampleTask(runtime, recordSuccess);
