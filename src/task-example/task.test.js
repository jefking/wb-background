import assert from "node:assert/strict";
import test from "node:test";

import { registerExampleTask } from "./task.js";

test("the example registers a five-second task that invokes weather.current", async () => {
  let definition;
  const output = [];
  const runtime = {
    registerTask(candidate) {
      definition = candidate;
      return { id: candidate.id };
    }
  };

  const registration = registerExampleTask(runtime, (message) => output.push(message));
  assert.deepEqual(registration, { id: "weather-heartbeat" });
  assert.equal(definition.id, "weather-heartbeat");
  assert.equal(definition.frequencyMs, 5_000);
  assert.deepEqual(definition.actions, ["weather.current"]);

  const requests = [];
  await definition.run({
    async invoke(actionId, input) {
      requests.push({ actionId, input });
      return { temperatureC: 10, condition: "cloudy", humidity: 75 };
    }
  });
  assert.deepEqual(requests, [{ actionId: "weather.current", input: {} }]);
  assert.deepEqual(output, ["10°C · cloudy · 75% humidity"]);
});
