#!/usr/bin/env node

import "dotenv/config";
import { Command, InvalidArgumentError } from "commander";
import { loadConfig, writeDefaultConfig } from "../src/config.js";
import { resolveProvider } from "../src/provider.js";
import { runTranslation } from "../src/translate.js";
import { formatDuration } from "../src/progress.js";

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Must be a positive integer.");
  return n;
}

const program = new Command();

program
  .name("polyglotus")
  .description("CLI tool for AI-powered translation of JSON and Markdown files")
  .version("1.0.0");

// ── translate (default command) ──────────────────────────────────────────────

program
  .command("translate", { isDefault: true })
  .description("Translate files according to polyglotus.config.mjs")
  .option("-c, --config <path>", "Path to config file")
  .option("-l, --lang <codes>", "Comma-separated target language codes (overrides config)")
  .option("--chunk-size <n>", "Max JSON keys per AI request", "100")
  .option("--request-delay <ms>", "Minimum delay between starting AI requests, in milliseconds (overrides config, default: 1000)")
  .option("-j, --concurrency <n>", "Max number of AI requests running in parallel (overrides config, default: 4)", parsePositiveInt)
  .option("-d, --dry-run", "Show what would be done without writing files")
  .option("-v, --verbose", "Show detailed progress")
  .option("-m, --model <model>", "Model identifier (overrides config)")
  .option("--base-url <url>", "Custom API base URL (overrides config)")
  .option("--api-key-env <name>", "Env var name to read the API key from (overrides config)")
  .action(async (opts) => {
    try {
      const config = await loadConfig(opts.config);

      // Resolve provider from config + CLI overrides
      const { baseUrl, apiKey, model, displayName } = resolveProvider(
        config.provider,
        {
          model: opts.model,
          baseUrl: opts.baseUrl,
          apiKeyEnv: opts.apiKeyEnv,
        }
      );
      const client = { baseUrl, apiKey, model };

      const targetLangs = opts.lang ? opts.lang.split(",").map((s) => s.trim()) : undefined;

      const requestDelay =
        opts.requestDelay !== undefined ? parseInt(opts.requestDelay, 10) : (config.requestDelay ?? 1000);

      const concurrency = opts.concurrency ?? config.concurrency ?? 4;

      console.log("Polyglotus — AI Translation CLI\n");
      console.log(`   Endpoint: ${displayName}`);
      console.log(`   Model:    ${model}`);
      console.log(`   Source:   ${config.sourceLang}`);
      console.log(`   Targets:  ${(targetLangs || config.targetLangs).join(", ")}`);
      console.log(`   Files:    ${config.files.length} pattern(s)`);
      console.log(`   Parallel: ${concurrency} request(s)`);
      if (opts.dryRun) console.log(`   Mode:     DRY RUN`);
      console.log("");

      const startedAt = Date.now();
      const result = await runTranslation(config, client, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        chunkSize: parseInt(opts.chunkSize, 10),
        requestDelay,
        concurrency,
        targetLangs,
      });

      // Summary
      console.log("\n" + "─".repeat(48));
      if (opts.dryRun) {
        console.log("Dry run complete — no files were written.");
      } else {
        if (result.totalSuccess) console.log(`Translated: ${result.totalSuccess}`);
        if (result.totalSkipped) console.log(`Up to date: ${result.totalSkipped}`);
        if (result.totalErrors) console.log(`Errors:      ${result.totalErrors}`);
        if (!result.totalSuccess && !result.totalErrors) console.log("Everything is up to date!");
        else console.log(`Time:       ${formatDuration(Date.now() - startedAt)}`);
      }
      console.log("─".repeat(48));

      if (result.totalErrors > 0) process.exit(1);
    } catch (err) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
  });

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Generate a starter polyglotus.config.mjs in the current directory")
  .action(async () => {
    try {
      const dest = await writeDefaultConfig(process.cwd());
      console.log(`Created ${dest}`);
      console.log("   Edit the file to configure your translation sources and target languages.");
    } catch (err) {
      console.error(`${err.message}`);
      process.exit(1);
    }
  });

program.parse();
