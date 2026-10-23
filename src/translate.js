import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { generateText } from "./openai.js";
import { flatten, unflatten } from "flat";
import { glob } from "glob";
import { createProgress, formatDuration } from "./progress.js";

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

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ── JSON translation ─────────────────────────────────────────────────────────

async function translateJsonChunk(chunk, sourceLang, targetLang, client, contextPrompt) {
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
 * Read a JSON source and its existing translation (if any), and split the
 * keys that still need translating into request-sized chunks.
 */
async function planJsonFile(target, chunkSize) {
  const sourceJson = JSON.parse(await fs.readFile(target.srcFile, "utf-8"));
  const flatSource = flatten(sourceJson);

  // If target exists, find only missing keys
  let keysToTranslate = flatSource;
  if (existsSync(target.dest)) {
    target.existingJson = JSON.parse(await fs.readFile(target.dest, "utf-8"));
    const flatExisting = flatten(target.existingJson);
    keysToTranslate = Object.fromEntries(Object.entries(flatSource).filter(([k]) => !(k in flatExisting)));
  }

  target.totalKeys = Object.keys(flatSource).length;
  target.missingKeys = Object.keys(keysToTranslate).length;
  target.upToDate = Boolean(target.existingJson) && target.missingKeys === 0;
  target.chunks = chunkObject(keysToTranslate, chunkSize);
}

/**
 * Translate the chunks of a JSON file in parallel and merge them into the
 * target file. Chunks that succeed are saved even when others fail, so the
 * next run only has to retry the keys that are still missing.
 */
async function translateJsonFile(target, ctx) {
  const { chunks } = target;

  const results = await Promise.allSettled(
    chunks.map((chunk, i) => {
      const label = chunks.length > 1 ? `${target.relDest} — chunk ${i + 1}/${chunks.length}` : target.relDest;
      return ctx.request(target, label, async () => {
        const startedAt = Date.now();
        const translated = await translateJsonChunk(chunk, ctx.sourceLang, target.lang, ctx.client, target.contextPrompt);
        if (ctx.logChunks && chunks.length > 1) {
          ctx.progress.log(`        ${label} done in ${formatDuration(Date.now() - startedAt)}`);
        }
        return translated;
      });
    })
  );

  const translatedChunks = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failures = results.flatMap((r, i) =>
    r.status === "rejected" ? [`chunk ${i + 1}/${chunks.length}: ${r.reason.message}`] : []
  );

  if (translatedChunks.length || !failures.length) {
    const translatedNested = unflatten(Object.assign({}, ...translatedChunks));
    const finalJson = target.existingJson ? deepMerge(target.existingJson, translatedNested) : translatedNested;

    await fs.mkdir(path.dirname(target.dest), { recursive: true });
    await fs.writeFile(target.dest, JSON.stringify(finalJson, null, 2) + "\n", "utf-8");
  }

  if (failures.length) {
    if (chunks.length === 1) throw results[0].reason;
    const savedKeys = translatedChunks.reduce((n, chunk) => n + Object.keys(chunk).length, 0);
    const err = new Error(
      `${failures.length} of ${chunks.length} chunks failed` +
        (savedKeys ? ` (saved ${plural(savedKeys, "key")}, run again to retry the rest)` : "")
    );
    err.details = failures;
    throw err;
  }

  return target.existingJson
    ? `${plural(target.missingKeys, "missing key")} translated`
    : `new file, ${plural(target.missingKeys, "key")} translated`;
}

// ── Markdown translation ─────────────────────────────────────────────────────

async function translateMarkdownFile(sourcePath, destPath, sourceLang, targetLang, client, contextPrompt) {
  const content = await fs.readFile(sourcePath, "utf-8");

  const prompt = `${contextPrompt ? contextPrompt + "\n\n" : ""}Translate the following markdown from "${sourceLang}" to "${targetLang}".
Preserve all markdown formatting, code blocks, URLs, and file paths.
Output ONLY the translated markdown. No explanation, no wrapping.

${content}`;

  const result = await generateText({ ...client, prompt, temperature: 0.3 });
  const translated = result.text.trim();

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, translated + "\n", "utf-8");
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Expand the config into one target per source file and language, and work
 * out what each target still needs. Only reads local files.
 */
async function planTargets(config, { sourceLang, langs, chunkSize, configDir }) {
  const targets = [];
  const sourceOf = new Map(); // target path → source path

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
      for (const lang of langs) {
        const dest = targetPath(srcFile, sourceLang, lang, targetFormat);
        const relDest = path.relative(configDir, dest);

        // Overlapping patterns can produce the same target more than once.
        // Translate it once, so parallel runs never write the same file.
        if (sourceOf.has(dest)) {
          if (sourceOf.get(dest) !== srcFile) {
            const first = path.relative(configDir, sourceOf.get(dest));
            console.warn(`Skipping ${path.relative(configDir, srcFile)} → ${relDest}: already translated from ${first}`);
          }
          continue;
        }
        sourceOf.set(dest, srcFile);

        const target = { type, srcFile, dest, relDest, lang, contextPrompt };
        try {
          if (type === "json") {
            await planJsonFile(target, chunkSize);
          } else {
            target.upToDate = existsSync(dest);
          }
        } catch (err) {
          target.error = err;
        }
        targets.push(target);
      }
    }
  }

  return targets;
}

function describePlan(target) {
  if (target.type !== "json") return target.upToDate ? "already exists" : "new file (1 request)";
  if (target.upToDate) return `up to date (${plural(target.totalKeys, "key")})`;

  const requests = plural(target.chunks.length, "request");
  return target.existingJson
    ? `${target.missingKeys} of ${plural(target.totalKeys, "key")} missing (${requests})`
    : `new file, ${plural(target.totalKeys, "key")} (${requests})`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full translation pipeline for a loaded config.
 *
 * Works out what is missing first, then translates it with up to
 * `concurrency` AI requests in flight at once — across files, languages and
 * the chunks of large JSON files.
 *
 * @param {object}  config   Loaded polyglotus config
 * @param {object}  client   OpenAI-compatible client config ({ baseUrl, apiKey, model })
 * @param {object}  opts     CLI options (dryRun, verbose, chunkSize, requestDelay, concurrency, targetLangs override)
 */
export async function runTranslation(config, client, opts = {}) {
  const {
    dryRun = false,
    verbose = false,
    chunkSize = 100,
    requestDelay = 1000,
    concurrency = 4,
    targetLangs,
  } = opts;

  const sourceLang = config.sourceLang || "en";
  const langs = targetLangs || config.targetLangs;
  const configDir = config._configDir || process.cwd();

  const targets = await planTargets(config, { sourceLang, langs, chunkSize, configDir });

  let totalErrors = 0;
  let planLines = 0;
  for (const target of targets) {
    if (target.error) {
      console.error(`  ✖ ${target.relDest} — ${target.error.message}`);
      totalErrors++;
      planLines++;
    } else if (dryRun || verbose) {
      console.log(`  ${target.upToDate ? "✔" : "●"} ${target.relDest} — ${describePlan(target)}`);
      planLines++;
    }
  }
  const gap = planLines ? "\n" : "";

  const pending = targets.filter((t) => !t.error && !t.upToDate);
  const totalSkipped = targets.filter((t) => !t.error && t.upToDate).length;
  const totalRequests = pending.reduce((n, t) => n + (t.type === "json" ? t.chunks.length : 1), 0);
  const plan = `${plural(pending.length, "file")} (${plural(totalRequests, "request")})`;

  if (dryRun) {
    console.log(pending.length ? `${gap}Would translate ${plan}.` : `${gap}Nothing to translate.`);
    return { totalSuccess: 0, totalSkipped, totalErrors };
  }
  if (pending.length === 0) {
    return { totalSuccess: 0, totalSkipped, totalErrors };
  }

  console.log(`${gap}Translating ${plan}...`);

  const progress = createProgress({ totalRequests, totalFiles: pending.length });
  const limit = createLimiter(concurrency);
  const ctx = {
    sourceLang,
    client,
    progress,
    logChunks: verbose || !progress.live,
    // Run one AI request: wait for a free parallel slot and the request delay,
    // and show the request in the progress display while it is in flight.
    request: (target, label, fn) =>
      limit(async () => {
        await throttleRequest(requestDelay);
        target.startedAt ??= Date.now();
        const finish = progress.startRequest(label);
        try {
          return await fn();
        } finally {
          finish();
        }
      }),
  };

  let results;
  try {
    results = await Promise.all(pending.map((target) => translateTarget(target, ctx)));
  } finally {
    progress.stop();
  }

  const totalSuccess = results.filter(Boolean).length;
  totalErrors += results.length - totalSuccess;

  return { totalSuccess, totalSkipped, totalErrors };
}

/**
 * Translate one target file and log the outcome. Resolves to whether it succeeded.
 */
async function translateTarget(target, ctx) {
  const { progress } = ctx;
  try {
    let summary;
    if (target.type === "json") {
      summary = await translateJsonFile(target, ctx);
    } else {
      await ctx.request(target, target.relDest, () =>
        translateMarkdownFile(target.srcFile, target.dest, ctx.sourceLang, target.lang, ctx.client, target.contextPrompt)
      );
      summary = "translated";
    }

    const took = target.startedAt ? ` in ${formatDuration(Date.now() - target.startedAt)}` : "";
    progress.log(`  ${progress.finishFile(true)} ✔ ${target.relDest} — ${summary}${took}`);
    return true;
  } catch (err) {
    progress.error(`  ${progress.finishFile(false)} ✖ ${target.relDest} — ${err.message}`);
    for (const line of err.details ?? []) progress.error(`        ${line}`);
    return false;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a function that runs async tasks with at most `max` of them in
 * flight at once. Queued tasks start in the order they were added.
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

// The earliest time the next API request may start. Each request reserves its
// slot before waiting, so even parallel requests start at least `requestDelay`
// apart, regardless of which file/language/chunk they belong to.
let nextRequestAt = 0;

async function throttleRequest(requestDelay) {
  if (!requestDelay) return;
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + requestDelay;
  if (startAt > now) await sleep(startAt - now);
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
