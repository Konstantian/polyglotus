# Polyglotus

CLI tool for automatic AI-powered translation of JSON and Markdown files.

Point it at your source files, list target languages, and it handles the rest — chunking large JSON, merging missing keys into existing translations, and creating markdown translations.

## Installation

You can skip installation and run it directly with `npx`:

```bash
npx polyglotus init
```

## Quick start

```bash
npx polyglotus init
npx polyglotus translate
```

## Environment variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (for `openai` provider) |

API keys can also be set in the config file via `provider.apiKey`, but env vars take priority.

**Dotenv support:** Polyglotus automatically loads variables from a `.env` file in your project root, so you don't need to pass them inline:

```
# .env
OPENAI_API_KEY=your_key
```

## Configuration

Create an `polyglotus.config.mjs` in your project root (or run `npx polyglotus init`):

```js
export default {
  sourceLang: "en",
  targetLangs: ["de", "fr", "es", "ru"],

  provider: {
    model: "openai/gpt-5.6-luna",
  },

  files: [
    {
      pattern: "messages/en.json",
      type: "json",
    },
    {
      pattern: "docs/readme.md",
      type: "markdown",
    },
  ],

  prompts: {
    json: "Custom context prompt for JSON translation…",
    markdown: "Custom context prompt for Markdown translation…",
  },
};
```

### Provider configuration

The `provider` block talks to any endpoint implementing the OpenAI-compatible
Chat Completions API — OpenAI, Ollama, LM Studio, OpenRouter, self-hosted,
etc. By default it targets the official OpenAI API; set `baseUrl` to point
anywhere else.

```js
provider: {
  model: "model-id",
  baseUrl: "optional-custom-url", // defaults to https://api.openai.com/v1
  apiKey: "optional-key-here",
  apiKeyEnv: "OPENAI_API_KEY", // optional: env var name to read the key from
}
```

| Field | Default | Description |
|---|---|---|
| `model` | — | Model identifier |
| `baseUrl` | `https://api.openai.com/v1` | API endpoint base URL |
| `apiKey` | — | API key (env var is preferred, this is a fallback) |
| `apiKeyEnv` | `OPENAI_API_KEY` | Name of the env var to read the API key from |

A missing API key only raises an error when `baseUrl` is the default OpenAI
endpoint. For any other endpoint (local Ollama, self-hosted servers, etc.)
a missing key is assumed to be intentional — set `apiKeyEnv` or `apiKey` if
your endpoint requires one.

#### OpenAI (default)

```json
"provider": {
  "model": "openai/gpt-5.6-luna"
}
```
Env var: `OPENAI_API_KEY`.

#### Ollama (local)

Use a local [Ollama](https://ollama.com) instance — free, no API key needed.

```json
"provider": {
  "model": "llama3.1",
  "baseUrl": "http://localhost:11434/v1"
}
```

#### Any other OpenAI-compatible endpoint

```json
"provider": {
  "model": "model-id",
  "baseUrl": "https://your-endpoint/v1",
  "apiKey": "optional-key-here",
  "apiKeyEnv": "MY_CUSTOM_API_KEY"
}
```

### Other config fields

| Field | Required | Description |
|---|---|---|
| `sourceLang` | yes | Source language code (e.g. `"en"`) |
| `targetLangs` | yes | Array of target language codes |
| `requestDelay` | no | Minimum delay between AI requests, in milliseconds (default: `1000`) |
| `files` | yes | Array of file entries to translate |
| `files[].pattern` | yes | Glob pattern for source files (resolved relative to config) |
| `files[].type` | yes | `"json"` or `"markdown"` |
| `files[].prompt` | no | Override the default prompt for this specific file pattern |
| `prompts.json` | no | Default context prompt prepended to all JSON translation requests |
| `prompts.markdown` | no | Default context prompt prepended to all Markdown translation requests |

### How file naming works

**JSON files:** The source language code in the filename is replaced with the target code.
- `messages/en.json` → `messages/de.json`, `messages/fr.json`, …

**Markdown files:** The target language code is appended before the extension.
- `docs/readme.md` → `docs/readme-de.md`, `docs/readme-fr.md`, …

## CLI usage

```
polyglotus translate [options]
polyglotus init
```

### `translate` options

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to config file (default: auto-detect) |
| `-l, --lang <codes>` | Override target languages (comma-separated) |
| `-m, --model <model>` | Override model identifier |
| `--base-url <url>` | Override API base URL |
| `--api-key-env <name>` | Override the env var name to read the API key from |
| `--chunk-size <n>` | Max JSON keys per AI request (default: 100) |
| `--request-delay <ms>` | Minimum delay between AI requests, in milliseconds (overrides config, default: 1000) |
| `-d, --dry-run` | Preview what would be translated |
| `-v, --verbose` | Detailed progress output |

### Examples

```bash
# Translate everything using OpenAI (default config)
OPENAI_API_KEY=sk-xxx npx polyglotus translate

# Only translate to Russian and German
npx polyglotus translate --lang ru,de

# Use a specific OpenAI model
OPENAI_API_KEY=sk-xxx npx polyglotus translate --model openai/gpt-5.6-luna

# Use local Ollama
npx polyglotus translate --model llama3.1 --base-url http://localhost:11434/v1

# Dry run — see what's missing without writing anything
npx polyglotus translate --dry-run

# Smaller chunks for large files
npx polyglotus translate --chunk-size 50 --verbose

# Wait 2 seconds between AI requests (e.g. to stay under a rate limit)
npx polyglotus translate --request-delay 2000
```

## Features

- **OpenAI-compatible** - works with OpenAI, local Ollama, or any other endpoint implementing the Chat Completions API
- **Incremental** - only translates missing keys/files; existing translations are preserved
- **Chunked** - large JSON files are split into manageable pieces for reliable AI output
- **Glob patterns** - match multiple source files with a single pattern
- **Per-file prompts** - give the AI specific context for different parts of your project
- **Config-driven** - model, endpoint, and API key all configurable in one file

## License

MIT
