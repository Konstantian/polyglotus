const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

/**
 * Resolve OpenAI-compatible client configuration from provider config.
 *
 * Works with any endpoint implementing the OpenAI Chat Completions API —
 * OpenAI, Ollama, LM Studio, OpenRouter, self-hosted, etc. Defaults target
 * the official OpenAI API; set "baseUrl" to point at a different endpoint.
 *
 * The API key env var name defaults to "OPENAI_API_KEY" but can be
 * overridden via provider.apiKeyEnv in config or the --api-key-env CLI
 * flag — useful for custom endpoints or alternate keys. If no key is
 * found and the endpoint is the default OpenAI API, an error is thrown;
 * for any other endpoint a missing key is assumed to be intentional
 * (e.g. an unauthenticated local server).
 *
 * @param {object} providerConfig  The "provider" block from polyglotus.config.mjs
 * @param {object} cliOverrides    CLI flags that override config values
 * @returns {{ baseUrl: string, apiKey: string|null, model: string, displayName: string }}
 */
export function resolveProvider(providerConfig = {}, cliOverrides = {}) {
  const model = cliOverrides.model || providerConfig.model;
  if (!model) {
    throw new Error("No model configured. Set provider.model in config.");
  }

  const baseUrl = cliOverrides.baseUrl || providerConfig.baseUrl || DEFAULT_BASE_URL;

  const apiKeyEnv = cliOverrides.apiKeyEnv || providerConfig.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const apiKey = (apiKeyEnv && process.env[apiKeyEnv]) || providerConfig.apiKey || null;

  if (!apiKey && baseUrl === DEFAULT_BASE_URL) {
    throw new Error(
      `No API key for OpenAI.\n` +
        `   Set ${apiKeyEnv} env var, add "apiKey" to provider config,\n` +
        `   or set "apiKeyEnv" in provider config to point at a different env var.`
    );
  }

  return { baseUrl, apiKey, model, displayName: displayNameFor(baseUrl) };
}

function displayNameFor(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
