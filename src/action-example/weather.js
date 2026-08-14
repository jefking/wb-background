import { ActionError, fetchJson } from "../action-sdk/index.js";

export const WEATHER_ACTION_ID = "weather.current";
export const WEATHER_CITY_KEY = "weather.city";
export const DEFAULT_WEATHER_ORIGIN = "http://127.0.0.1:8003";

const CONDITIONS = new Set(["clear", "cloudy", "fog", "rain", "snow", "wind"]);

function validateEmptyInput(input) {
  if (!input || Array.isArray(input) || Object.keys(input).length !== 0) {
    throw new ActionError("invalid_input", "The weather action does not accept task-controlled input.");
  }
  return input;
}

function normalizeCity(value) {
  const city = value.normalize("NFC").trim();
  if (city.length === 0 || city.length > 80 || /[\u0000-\u001f\u007f]/.test(city)) {
    throw new ActionError("invalid_vault_value", "weather.city must contain 1–80 printable characters.");
  }
  return city;
}

function sanitizeWeatherResponse(response) {
  if (!response || Array.isArray(response) || typeof response !== "object") {
    throw new ActionError("invalid_response", "The weather service returned an invalid object.");
  }
  const temperatureC = response.temperatureC;
  const humidity = response.humidity;
  const condition = response.condition;
  const observedAt = response.observedAt;
  if (typeof temperatureC !== "number" || temperatureC < -100 || temperatureC > 100
    || !Number.isInteger(humidity) || humidity < 0 || humidity > 100
    || !CONDITIONS.has(condition)
    || typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) {
    throw new ActionError("invalid_response", "The weather service returned invalid weather fields.");
  }

  // Deliberately omit the city echoed by the service. The task receives only
  // the minimum result and never learns the vault-backed location.
  return Object.freeze({ temperatureC, humidity, condition, observedAt });
}

/** Trusted Host action definition. No task-provided URL, method, or headers. */
export function createWeatherAction({
  fetchFn = globalThis.fetch,
  serviceOrigin = DEFAULT_WEATHER_ORIGIN
} = {}) {
  const origin = new URL(serviceOrigin).origin;
  if (origin !== serviceOrigin) throw new TypeError("serviceOrigin must be an exact origin.");

  return {
    id: WEATHER_ACTION_ID,
    title: "Read current weather",
    description: "Use weather.city inside the trusted host to fetch a sanitized weather observation.",
    destination: Object.freeze({ origin, method: "GET", path: "/weather" }),
    requiredEntries: Object.freeze([{
      slot: "city",
      key: WEATHER_CITY_KEY,
      kinds: Object.freeze(["variable", "secret"])
    }]),
    validateInput: validateEmptyInput,
    async execute({ values, signal }) {
      const city = normalizeCity(values.city);
      const url = new URL("/weather", origin);
      url.searchParams.set("city", city);

      const response = await fetchJson({
        fetchFn,
        url,
        allowedOrigin: origin,
        method: "GET",
        headers: { accept: "application/json" },
        signal,
        maxResponseBytes: 16_384
      });
      return sanitizeWeatherResponse(response);
    }
  };
}
