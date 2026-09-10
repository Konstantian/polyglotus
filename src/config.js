import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { z } from "zod";

const CONFIG_FILENAME = "auto-translate.config.mjs";

const configSchema = z.object({
  sourceLang: z.string().default("en"),
  targetLangs: z.array(z.string()).min(1, "Config must specify at least one targetLangs entry."),
  provider: z.object({
    model: z.string({ required_error: "Config must specify provider.model." }),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    baseUrl: z.string().optional(),
  }),
  files: z
    .array(
      z.object({
        pattern: z.string(),
        type: z.enum(["json", "markdown"]).optional(),
        targetFormat: z.string().optional(),
        prompt: z.string().optional(),
      })
    )
    .min(1, "Config must specify at least one files entry."),
  prompts: z
    .object({
      json: z.string().optional(),
      markdown: z.string().optional(),
    })
    .optional()
    .default({}),
});

/**
 * @typedef {z.infer<typeof configSchema>} AutoTranslateConfig
 */

/**
 * Searches for auto-translate.config.mjs starting from cwd up to root.
 * @param {string} startDir
 * @returns {string|null}
 */
function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads and validates the configuration.
 * @param {string|undefined} explicitPath  Optional explicit path to config file
 * @returns {Promise<object>}
 */
export async function loadConfig(explicitPath) {
  const configPath = explicitPath || findConfigFile(process.cwd());

  if (!configPath || !existsSync(configPath)) {
    throw new Error(
      `Config file not found. Create a ${CONFIG_FILENAME} file or specify one with --config.\n` +
        `Run "auto-translate init" to generate a starter config.`
    );
  }

  let userConfig;
  try {
    const absolutePath = path.resolve(configPath);
    const fileUrl = pathToFileURL(absolutePath).href;
    const mod = await import(fileUrl);
    userConfig = mod.default ?? mod;
  } catch (err) {
    throw new Error(`Failed to load config file: ${configPath}\n  ${err.message}`);
  }

  // Validate & apply defaults via Zod
  const result = configSchema.safeParse(userConfig);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join("\n  • ");
    throw new Error(`Invalid config:\n  • ${messages}`);
  }

  const config = result.data;

  // Resolve file paths relative to config file location
  const configDir = path.dirname(path.resolve(configPath));
  config._configDir = configDir;

  return config;
}

/**
 * Write a starter config file.
 * @param {string} dir  Directory to write into
 */
export async function writeDefaultConfig(dir) {
  const dest = path.join(dir, CONFIG_FILENAME);
  if (existsSync(dest)) {
    throw new Error(`${CONFIG_FILENAME} already exists in ${dir}`);
  }

  const content = `/** @type {import('auto-translate/config').AutoTranslateConfig} */
export default {
  sourceLang: "en",
  targetLangs: ["de"],
  provider: {
    model: "",
  },
  files: [
    {
      type: "json",
      pattern: "messages/main.json",
      targetFormat: "{lang}.{ext}",
      prompt: "Translate UI strings for a web application. Use natural, professional language.",
    },
  ],
};
`;

  await fs.writeFile(dest, content, "utf-8");
  return dest;
}
