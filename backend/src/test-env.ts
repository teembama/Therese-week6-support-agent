// Preloaded by `npm run test:gate` (node --import): unit tests never read .env, but config.ts
// requires AGENT_MODEL (D49). No test calls a model.
process.env["AGENT_MODEL"] ??= "claude-haiku-4-5";
