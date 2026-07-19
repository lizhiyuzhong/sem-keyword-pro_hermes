export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  /** Custom LLM endpoint (OpenAI-compatible). Falls back to Manus Forge. */
  llmApiUrl: process.env.LLM_API_URL ?? "",
  /** Custom LLM API key. Falls back to BUILT_IN_FORGE_API_KEY. */
  llmApiKey: process.env.LLM_API_KEY ?? "",
  /** Custom LLM model name. Falls back to "gemini-2.5-flash". */
  llmModel: process.env.LLM_MODEL ?? "",
  /** Dev mode: skip Manus OAuth, inject mock admin user. NEVER set on Manus. */
  devMode: process.env.DEV_MODE === "true",
};
