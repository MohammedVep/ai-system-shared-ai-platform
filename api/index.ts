import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const app = buildApp({ env: loadEnv() });
let isReady = false;

const ensureReady = async (): Promise<void> => {
  if (isReady) {
    return;
  }
  await app.ready();
  isReady = true;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ensureReady();
  app.server.emit("request", req, res);
}
