export function registerExampleTask(runtime, log = console.log) {
  return runtime.registerTask({
    id: "weather-heartbeat",
    frequencyMs: 5_000,
    actions: ["weather.current"],
    async run({ invoke }) {
      const weather = await invoke("weather.current", {});
      log(`${weather.temperatureC}°C · ${weather.condition} · ${weather.humidity}% humidity`);
    }
  });
}
