const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 3017);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DEMO_MODE = process.argv.includes("--demo") || process.env.DEMO_MODE === "1";
const SACCT_TIMEOUT_MS = Number(process.env.SACCT_TIMEOUT_MS) || 60000;
const SACCT_MAX_BUFFER_MB = Number(process.env.SACCT_MAX_BUFFER_MB) || 64;
const MAX_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

class RequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function sanitizeNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseDurationToSeconds(value) {
  if (!value || value === "Unknown" || value === "INVALID") return null;

  const daySplit = String(value).split("-");
  const clock = daySplit.pop();
  const days = daySplit.length ? Number(daySplit[0]) : 0;
  const pieces = clock.split(":").map(Number);

  if (pieces.some((piece) => !Number.isFinite(piece))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (pieces.length === 3) {
    [hours, minutes, seconds] = pieces;
  } else if (pieces.length === 2) {
    [minutes, seconds] = pieces;
  } else if (pieces.length === 1) {
    [seconds] = pieces;
  } else {
    return null;
  }

  return (((days * 24 + hours) * 60 + minutes) * 60) + seconds;
}

function parseSacctDate(value) {
  if (!value || value === "Unknown" || value === "INVALID") return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed;
}

function formatSacctDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${[
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":")}`;
}

function getJobStartMs(job) {
  const date = parseSacctDate(job.start) || parseSacctDate(job.submit) || parseSacctDate(job.end);
  return date ? date.getTime() : null;
}

function filterJobsByWindow(jobs, startDate, endDate) {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  return jobs.filter((job) => {
    const jobStartMs = getJobStartMs(job);
    return jobStartMs != null && jobStartMs >= startMs && jobStartMs <= endMs;
  });
}

// Newest first, so the row limit drops the oldest jobs rather than the newest.
// Each job gets the startMs the server dated it by, so the browser plots the
// same jobs the summary counts.
function selectNewestJobs(jobs, startDate, endDate, limit) {
  const windowJobs = filterJobsByWindow(jobs, startDate, endDate)
    .map((job) => ({ ...job, startMs: getJobStartMs(job) }))
    .sort((a, b) => b.startMs - a.startMs);

  return {
    jobs: windowJobs.slice(0, limit),
    total: windowJobs.length,
    truncated: windowJobs.length > limit,
  };
}

function parseSacctRows(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);

  return lines
    .map((line) => {
      const [
        jobId,
        jobName,
        user,
        account,
        partition,
        state,
        submit,
        start,
        end,
        elapsed,
        allocCpus,
        totalCpu,
        maxRss,
      ] = line.split("|");

      const runtimeSeconds = parseDurationToSeconds(elapsed);
      if (!jobId || runtimeSeconds == null) return null;

      return {
        jobId,
        jobName,
        user,
        account,
        partition,
        state,
        submit,
        start,
        end,
        elapsed,
        runtimeSeconds,
        allocCpus: Number(allocCpus) || 0,
        totalCpu,
        maxRss,
      };
    })
    .filter(Boolean);
}

function createSampleJobs() {
  const now = Date.now();
  const states = ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"];
  return Array.from({ length: 80 }, (_, index) => {
    const submittedAt = new Date(now - (80 - index) * 1000 * 60 * 45);
    const runtimeSeconds = Math.round(90 + Math.pow(index % 17, 1.8) * 70 + Math.random() * 900);
    return {
      jobId: String(12000 + index),
      jobName: ["align", "mpi-solve", "postproc", "train", "array"][index % 5],
      user: ["ada", "grace", "linus", "margaret"][index % 4],
      account: "research",
      partition: ["batch", "gpu", "debug"][index % 3],
      state: states[index % states.length],
      submit: submittedAt.toISOString(),
      start: new Date(submittedAt.getTime() + 1000 * 60 * (index % 8)).toISOString(),
      end: new Date(submittedAt.getTime() + runtimeSeconds * 1000).toISOString(),
      elapsed: formatSeconds(runtimeSeconds),
      runtimeSeconds,
      allocCpus: [1, 2, 4, 8, 16, 32][index % 6],
      totalCpu: "",
      maxRss: "",
    };
  });
}

function formatSeconds(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days}-${clock}` : clock;
}

const VALID_USER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Returns "" for no filter and null for a value that is not a valid user list.
function sanitizeUser(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const segments = trimmed.split(",").map((segment) => segment.trim());
  if (!segments.every((segment) => VALID_USER_SEGMENT.test(segment))) return null;

  return segments.join(",");
}

function parseOptionalDate(query, name) {
  const value = query.get(name);
  if (value === null || value === "") return null;

  const date = parseSacctDate(value);
  if (!date) throw new RequestError(`Invalid ${name} date: ${value}`);
  return date;
}

function parseJobsQuery(query) {
  const days = sanitizeNumber(query.get("days"), 14, 1, MAX_WINDOW_DAYS);
  const limit = sanitizeNumber(query.get("limit"), 500, 10, 5000);
  const user = sanitizeUser(query.get("user"));
  if (user === null) throw new RequestError(`Invalid user: ${query.get("user")}`);

  const end = parseOptionalDate(query, "end") || new Date();
  const start = parseOptionalDate(query, "start") || new Date(end.getTime() - days * DAY_MS);
  if (start > end) throw new RequestError("start must be before end");
  if (end - start > MAX_WINDOW_DAYS * DAY_MS) {
    throw new RequestError(`Window is longer than ${MAX_WINDOW_DAYS} days`);
  }

  return { limit, user, start, end };
}

function createSampleResult({ limit, user, start, end }) {
  const users = new Set(user ? user.split(",") : []);
  const sampleJobs = createSampleJobs().filter((job) => !users.size || users.has(job.user));
  return {
    source: "sample",
    warning: "Demo mode: showing generated sample data, not real cluster jobs.",
    ...selectNewestJobs(sampleJobs, start, end, limit),
  };
}

function fetchSacctJobs(options) {
  const { limit, user } = options;
  const start = formatSacctDate(options.start);
  const end = formatSacctDate(options.end);
  const fields = [
    "JobIDRaw",
    "JobName",
    "User",
    "Account",
    "Partition",
    "State",
    "Submit",
    "Start",
    "End",
    "Elapsed",
    "AllocCPUS",
    "TotalCPU",
    "MaxRSS",
  ].join(",");

  const args = [
    "--parsable2",
    "--noheader",
    "--duplicates",
    "--allocations",
    "--format",
    fields,
    "--starttime",
    start,
    "--endtime",
    end,
  ];

  if (user) {
    args.push("--user", user);
  }

  const execOptions = { timeout: SACCT_TIMEOUT_MS, maxBuffer: SACCT_MAX_BUFFER_MB * 1024 * 1024 };

  return new Promise((resolve, reject) => {
    execFile("sacct", args, execOptions, (error, stdout, stderr) => {
      if (error) {
        console.error(`sacct failed: ${error.message}${stderr ? `\n${stderr}` : ""}`);
        const sacctError = new Error(describeSacctError(error));
        sacctError.status = 502;
        reject(sacctError);
        return;
      }

      resolve({
        source: "sacct",
        warning: null,
        ...selectNewestJobs(parseSacctRows(stdout), options.start, options.end, limit),
      });
    });
  });
}

function describeSacctError(error) {
  if (error.code === "ENOENT") return "sacct was not found on the server's PATH.";
  // Checked before `killed`, because exceeding maxBuffer also kills the child.
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `sacct output exceeded ${SACCT_MAX_BUFFER_MB} MB. Try a shorter window or a user filter.`;
  }
  if (error.killed) return `sacct did not finish within ${SACCT_TIMEOUT_MS / 1000} seconds. Try a shorter window.`;
  return "sacct failed. See the server log for details.";
}

function getJobs(query) {
  const options = parseJobsQuery(query);
  return DEMO_MODE ? createSampleResult(options) : fetchSacctJobs(options);
}

function serveStatic(req, res) {
  const rawPath = new URL(req.url, "http://localhost").pathname;
  const requestPath = rawPath === "/" ? "/index.html" : rawPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  if (resolvedPath !== PUBLIC_DIR && !resolvedPath.startsWith(PUBLIC_DIR + path.sep)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    send(res, 200, content, {
      "Content-Type": MIME_TYPES[path.extname(resolvedPath)] || "application/octet-stream",
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // A fixed base, not the Host header, so a malformed Host cannot throw here.
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/api/jobs") {
        sendJson(res, 200, await getJobs(url.searchParams));
        return;
      }

      serveStatic(req, res);
    } catch (error) {
      const status = error.status || (error.code === "ERR_INVALID_URL" ? 400 : 500);
      if (status === 500) console.error(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Slurm Job History Explorer listening on http://${HOST}:${PORT}${DEMO_MODE ? " (demo mode, sample data)" : ""}`);
  });
}

module.exports = {
  sanitizeNumber,
  sanitizeUser,
  parseDurationToSeconds,
  parseSacctDate,
  formatSacctDate,
  getJobStartMs,
  filterJobsByWindow,
  selectNewestJobs,
  parseJobsQuery,
  parseSacctRows,
  createSampleJobs,
  createSampleResult,
  formatSeconds,
  createServer,
};
