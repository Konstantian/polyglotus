import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { generateText } from "./openai.js";
import { flatten, unflatten } from "flat";
import { glob } from "glob";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Split an object into chunks of at most `size` keys.
 */
function chunkObject(obj, size) {
  const entries = Object.entries(obj);
  const chunks = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return chunks;
}

/**
 * Derive the target file path from a source path and target language.
 *
 * When targetFormat is provided, it is used as a filename template with placeholders:
 *   {name} — source basename without extension
 *   {lang} — target language code
 *   {ext}  — source file extension without dot
 *
 *   Examples:
 *     targetFormat "{name}-{lang}.{ext}"    → test-ru.md
 *     targetFormat "{lang}/{name}.{ext}"    → ru/test.md
 *     targetFormat "{name}.{lang}.html"     → test.ru.html
 *
 * When targetFormat is NOT provided, the default behaviour applies:
 *   If the basename matches the source language code, replace it with target:
 *     messages/en.json → messages/de.json
 *   Otherwise append target language via dash:
 *     test.md → test-de.md
 *
 * @param {string} sourcePath
 * @param {string} sourceLang
 * @param {string} targetLang
 * @param {string} [targetFormat]  Optional filename template
 */
function targetPath(sourcePath, sourceLang, targetLang, targetFormat) {
  const dir = path.dirname(sourcePath);
  const ext = path.extname(sourcePath).slice(1); // without dot
  const base = path.basename(sourcePath, path.extname(sourcePath));

  if (targetFormat) {
    const formatted = targetFormat
      .replace(/\{name\}/g, base)
      .replace(/\{lang\}/g, targetLang)
      .replace(/\{ext\}/g, ext);
    return path.join(dir, formatted);
  }

  // Default: replace basename if it matches sourceLang, otherwise append -lang
  const newBase = base === sourceLang ? targetLang : `${base}-${targetLang}`;
  return path.join(dir, `${newBase}.${ext}`);
}

// ── JSON translation ─────────────────────────────────────────────────────────

async function translateJsonChunk(chunk, sourceLang, targetLang, client, contextPrompt, verbose) {
  const keyCount = Object.keys(chunk).length;
  if (verbose) console.log(`    Translating ${keyCount} JSON keys...`);

  const prompt = `${contextPrompt ? contextPrompt + "\n\n" : ""}Translate the following JSON values from "${sourceLang}" to "${targetLang}".
Keys must stay identical. Preserve placeholders like {name}, {{count}}, %s, %d and HTML tags exactly.
Output ONLY valid JSON. No explanation, no code fences.

${JSON.stringify(chunk, null, 2)}`;

  const result = await generateText({ ...client, prompt, temperature: 0.3 });

  let text = result.text.trim();
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fenced) text = fenced[1];

  const translated = JSON.parse(text);

  // Validate key parity
  const srcKeys = Object.keys(chunk).sort();
  const tgtKeys = Object.keys(translated).sort();
  if (srcKeys.length !== tgtKeys.length) {
    throw new Error(`Key count mismatch: expected ${srcKeys.length}, got ${tgtKeys.length}`);
  }
  const missing = srcKeys.filter((k) => !(k in translated));
  if (missing.length) throw new Error(`Missing keys after translation: ${missing.join(", ")}`);

  return translated;
}

/**
 * Translate a full JSON file (handles chunking internally).
 */
async function translateJsonFile(sourcePath, destPath, sourceLang, targetLang, client, contextPrompt, chunkSize, verbose, logHeader) {
  const sourceContent = await fs.readFile(sourcePath, "utf-8");
  const sourceJson = JSON.parse(sourceContent);
  const flatSource = flatten(sourceJson);
  const totalKeys = Object.keys(flatSource).length;

  // If target exists, find only missing keys
  let keysToTranslate = flatSource;
  let existingJson = null;

  if (existsSync(destPath)) {
    const existingContent = await fs.readFile(destPath, "utf-8");
    existingJson = JSON.parse(existingContent);
    const flatExisting = flatten(existingJson);
    const missingEntries = Object.entries(flatSource).filter(([k]) => !(k in flatExisting));

    if (missingEntries.length === 0) {
      if (verbose) {
        logHeader();
        console.log(`  ${path.basename(destPath)} — up to date (${totalKeys} keys)`);
      }
      return { translated: 0, total: totalKeys, skipped: true };
    }

    keysToTranslate = Object.fromEntries(missingEntries);
    logHeader();
    console.log(`  ${path.basename(destPath)} — ${missingEntries.length} missing keys out of ${totalKeys}`);
  } else {
    logHeader();
    console.log(`  ${path.basename(destPath)} — new file (${totalKeys} keys)`);
  }

  const chunks = chunkObject(keysToTranslate, chunkSize);
  const translatedChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) console.log(`    chunk ${i + 1}/${chunks.length}`);
    const translated = await translateJsonChunk(chunks[i], sourceLang, targetLang, client, contextPrompt, verbose);
    translatedChunks.push(translated);
    if (i < chunks.length - 1) await sleep(500);
  }

  const mergedFlat = Object.assign({}, ...translatedChunks);
  const translatedNested = unflatten(mergedFlat);

  let finalJson;
  if (existingJson) {
    finalJson = deepMerge(existingJson, translatedNested);
  } else {
    finalJson = translatedNested;
  }

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, JSON.stringify(finalJson, null, 2) + "\n", "utf-8");

  return { translated: Object.keys(keysToTranslate).length, total: totalKeys, skipped: false };
}

// ── Markdown translation ─────────────────────────────────────────────────────

async function translateMarkdownFile(sourcePath, destPath, sourceLang, targetLang, client, contextPrompt, verbose, logHeader) {
  if (existsSync(destPath)) {
    if (verbose) {
      logHeader();
      console.log(`  ${path.basename(destPath)} — already exists, skipping`);
    }
    return { skipped: true };
  }

  logHeader();
  console.log(`  ${path.basename(destPath)} — translating markdown...`);

  const content = await fs.readFile(sourcePath, "utf-8");

  const prompt = `${contextPrompt ? contextPrompt + "\n\n" : ""}Translate the following markdown from "${sourceLang}" to "${targetLang}".
Preserve all markdown formatting, code blocks, URLs, and file paths.
Output ONLY the translated markdown. No explanation, no wrapping.

${content}`;

  const result = await generateText({ ...client, prompt, temperature: 0.3 });
  const translated = result.text.trim();

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, translated + "\n", "utf-8");

  return { skipped: false };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full translation pipeline for a loaded config.
 *
 * @param {object}  config   Loaded ai-translate config
 * @param {object}  client   OpenAI-compatible client config ({ baseUrl, apiKey, model })
 * @param {object}  opts     CLI options (dryRun, verbose, chunkSize, targetLangs override)
 */
export async function runTranslation(config, client, opts = {}) {
  const {
    dryRun = false,
    verbose = false,
    chunkSize = 100,
    targetLangs,
  } = opts;

  const sourceLang = config.sourceLang || "en";
  const langs = targetLangs || config.targetLangs;
  const configDir = config._configDir || process.cwd();

  let totalSuccess = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const fileEntry of config.files) {
    const pattern = path.resolve(configDir, fileEntry.pattern);
    const type = fileEntry.type || (pattern.endsWith(".json") ? "json" : "markdown");
    const targetFormat = fileEntry.targetFormat || null;
    const contextPrompt = fileEntry.prompt || config.prompts[type] || "";

    // Resolve glob patterns
    const matchedFiles = await glob(pattern, { nodir: true });

    if (matchedFiles.length === 0) {
      console.warn(`No files matched pattern: ${fileEntry.pattern}`);
      continue;
    }

    for (const srcFile of matchedFiles) {
      let sourceLogged = false;
      const logHeader = () => {
        if (!sourceLogged) {
          console.log(`\nSource: ${path.relative(configDir, srcFile)}`);
          sourceLogged = true;
        }
      };

      for (const lang of langs) {
        const dest = targetPath(srcFile, sourceLang, lang, targetFormat);
        const relDest = path.relative(configDir, dest);

        if (dryRun) {
          logHeader();
          const exists = existsSync(dest);
          console.log(`  ${exists ? "✔" : "●"} ${relDest} ${exists ? "(exists)" : "(would create)"}`);
          continue;
        }

        try {
          if (type === "json") {
            const result = await translateJsonFile(srcFile, dest, sourceLang, lang, client, contextPrompt, chunkSize, verbose, logHeader);
            if (result.skipped) {
              totalSkipped++;
            } else {
              totalSuccess++;
            }
          } else {
            const result = await translateMarkdownFile(srcFile, dest, sourceLang, lang, client, contextPrompt, verbose, logHeader);
            if (result.skipped) {
              totalSkipped++;
            } else {
              totalSuccess++;
            }
          }
        } catch (err) {
          logHeader();
          console.error(`  ${relDest} — ${err.message}`);
          totalErrors++;
        }
      }
    }
  }

  return { totalSuccess, totalSkipped, totalErrors };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      out[key] = deepMerge(out[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}
