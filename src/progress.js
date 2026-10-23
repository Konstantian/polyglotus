/**
 * Progress display for a translation run.
 *
 * In an interactive terminal it keeps a live footer under the log output:
 * one line per AI request in flight plus an overall progress bar, redrawn
 * several times a second. When stdout is not a terminal (CI, pipes, files)
 * it only prints the log lines.
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REDRAW_INTERVAL = 100;
const MAX_REQUEST_LINES = 10;

// Characters most terminals draw two columns wide (CJK, fullwidth forms, emoji).
const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

/**
 * @param {object} opts
 * @param {number} opts.totalRequests  Number of AI requests the run will make
 * @param {number} opts.totalFiles     Number of files the run will write
 */
export function createProgress({ totalRequests, totalFiles }) {
  const out = process.stdout;
  const live = Boolean(out.isTTY) && process.env.TERM !== "dumb";
  const startedAt = Date.now();
  const inFlight = new Map();
  let nextId = 0;
  let doneRequests = 0;
  let doneFiles = 0;
  let failedFiles = 0;
  let footerHeight = 0;
  let frame = 0;
  let timer = null;

  // Escape sequence that moves the cursor back up over the footer and erases it.
  function eraseFooter() {
    const seq = footerHeight ? `\r\x1b[${footerHeight}A\x1b[J` : "";
    footerHeight = 0;
    return seq;
  }

  function drawFooter() {
    const now = Date.now();
    const width = (out.columns || 80) - 1;
    const maxRequestLines = Math.max(0, Math.min(MAX_REQUEST_LINES, (out.rows || 24) - 4));
    const spinner = SPINNER[frame % SPINNER.length];
    const requests = [...inFlight.values()];

    const lines = [""];
    for (const request of requests.slice(0, maxRequestLines)) {
      lines.push(`  ${spinner} ${request.label} (${formatDuration(now - request.startedAt)})`);
    }
    if (requests.length > maxRequestLines) {
      lines.push(`    …and ${requests.length - maxRequestLines} more`);
    }
    lines.push(statusLine(now, width));

    footerHeight = lines.length;
    return lines.map((line) => fit(line, width)).join("\n") + "\n";
  }

  function statusLine(now, width) {
    const elapsed = now - startedAt;
    const ratio = totalRequests ? doneRequests / totalRequests : 1;
    const parts = [
      `${Math.floor(ratio * 100)}%`,
      `${doneRequests}/${totalRequests} requests`,
      `${doneFiles}/${totalFiles} files`,
    ];
    if (failedFiles) parts.push(`${failedFiles} failed`);
    parts.push(formatDuration(elapsed));
    if (doneRequests && doneRequests < totalRequests) {
      parts.push(`~${formatDuration((elapsed / doneRequests) * (totalRequests - doneRequests))} left`);
    }

    const info = parts.join(" · ");
    const barWidth = Math.max(10, Math.min(30, width - info.length - 3));
    const filled = Math.round(ratio * barWidth);
    return `  ${"█".repeat(filled)}${"░".repeat(barWidth - filled)} ${info}`;
  }

  function redraw() {
    frame++;
    out.write(eraseFooter() + drawFooter());
  }

  // Log lines go above the footer: erase it, print the line, draw it again.
  function print(stream, line) {
    if (timer) out.write(eraseFooter());
    stream.write(line + "\n");
    if (timer) out.write(drawFooter());
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    process.removeListener("SIGINT", onInterrupt);
    out.write(eraseFooter());
  }

  // Leave a clean terminal behind when the run is cancelled with Ctrl+C.
  function onInterrupt() {
    stop();
    process.exit(130);
  }

  if (live) {
    timer = setInterval(redraw, REDRAW_INTERVAL);
    timer.unref();
    process.on("SIGINT", onInterrupt);
    redraw();
  }

  return {
    live,
    log: (line) => print(process.stdout, line),
    error: (line) => print(process.stderr, line),

    /**
     * Show an AI request as in flight. Returns a function to call once it settles.
     */
    startRequest(label) {
      const id = nextId++;
      inFlight.set(id, { label, startedAt: Date.now() });
      return () => {
        inFlight.delete(id);
        doneRequests++;
      };
    },

    /**
     * Count a finished (or failed) file. Returns an "[n/total]" counter for its log line.
     */
    finishFile(ok) {
      doneFiles++;
      if (!ok) failedFiles++;
      return `[${String(doneFiles).padStart(String(totalFiles).length)}/${totalFiles}]`;
    },

    stop,
  };
}

/**
 * Format a duration in milliseconds as "4.2s", "42s", "3m 05s" or "1h 02m".
 */
export function formatDuration(ms) {
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// Cut a line to `width` terminal columns. Footer lines must never wrap, or the
// next redraw would not move far enough up to erase them.
function fit(line, width) {
  const chars = [...line];
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    used += WIDE_CHAR.test(chars[i]) ? 2 : 1;
    if (used > width) return chars.slice(0, Math.max(0, i - 1)).join("") + "…";
  }
  return line;
}
