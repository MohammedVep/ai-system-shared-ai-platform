import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const start = async (): Promise<void> => {
  const env = loadEnv();
  const app = buildApp({ env });

  try {
    await app.listen({
      host: "0.0.0.0",
      port: env.port
    });
    app.log.info({ port: env.port }, "AI Gateway started");
  } catch (error) {
    app.log.error({ error }, "Failed to start server");
    process.exitCode = 1;
  }
};

start();
