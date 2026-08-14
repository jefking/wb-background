export function registerExampleTask(runtime, log = console.log) {
  return runtime.registerTask({
    id: "heartbeat",
    frequencyMs: 5_000,
    async run({ getSecret }) {
      const secret = await getSecret("demo.secret");
      log(`heartbeat called with a ${secret.length}-character secret`);
    }
  });
}
