/** @type {import('ai-translate/config').AiTranslateConfig} */
export default {
  sourceLang: "en",
  targetLangs: ["ru"],
  provider: {
    model: "openai/gpt-5.6-luna",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  files: [
    {
      pattern: "json/main.json",
      type: "json",
      targetFormat: "{lang}.{ext}",
    },
    {
      pattern: "markdown/main.md",
      type: "markdown",
      targetFormat: "{lang}.{ext}",
    },
  ],
};
