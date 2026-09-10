/**
 * Minimal client for the OpenAI-compatible Chat Completions API.
 *
 * Works with any endpoint implementing that API shape — OpenAI, Ollama,
 * LM Studio, OpenRouter, etc. No SDK required.
 */

/**
 * Generate text via a single-turn chat completion request.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl        API base URL, e.g. "https://api.openai.com/v1"
 * @param {string|null} [opts.apiKey]  Bearer token, if required by the endpoint
 * @param {string} opts.model          Model identifier
 * @param {string} opts.prompt         User prompt text
 * @param {number} [opts.temperature]  Sampling temperature
 * @returns {Promise<{ text: string }>}
 */
export async function generateText({ baseUrl, apiKey, model, prompt, temperature = 0.3 }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API request failed (${res.status} ${res.statusText}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("API response did not contain any text.");
  }

  return { text };
}
