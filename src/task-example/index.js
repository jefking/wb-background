import { createTaskRuntime } from "../runtime-sdk/index.js";
import { registerExampleTask } from "./task.js";

const runtime = createTaskRuntime({ trustedHostOrigin: "http://127.0.0.1:8000" });
registerExampleTask(runtime);
