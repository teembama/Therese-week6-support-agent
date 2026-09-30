// Backend entry point (npm start, the Docker CMD). Loads .env when present, BEFORE any other
// module is evaluated: ESM runs static imports first, and config.ts reads AGENT_MODEL and the
// timeouts at import time. Hence no static imports here; the server loads through the dynamic
// import below. On Railway there is no .env and the variables come from the service settings.
// process.loadEnvFile never overrides a variable that is already set.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

await import("./server.js");
