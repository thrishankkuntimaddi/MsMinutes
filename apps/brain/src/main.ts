import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { app } = await buildServer(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `Brain is awake as ${config.personaName}. Bodies connect to ws://${config.host}:${config.port}/ws`,
);
