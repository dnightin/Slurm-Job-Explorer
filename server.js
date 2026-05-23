const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 3017);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

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

function fetchSacctJobs(query) {
  const days = sanitizeNumber(query.get("days"), 14, 1, 365);
  const limit = sanitizeNumber(query.get("limit"), 500, 10, 5000);
  const start = query.get("start") || `now-${days}days`;
  const end = query.get("end") || "now";
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

  return new Promise((resolve) => {
    execFile("sacct", args, { timeout: 20000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          source: "sample",
          warning: `sacct unavailable or failed: ${stderr || error.message}`,
          jobs: createSampleJobs().slice(0, limit),
        });
        return;
      }

      resolve({
        source: "sacct",
        warning: null,
        jobs: parseSacctRows(stdout).slice(0, limit),
      });
    });
  });
}

function serveStatic(req, res) {
  const rawPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const requestPath = rawPath === "/" ? "/index.html" : rawPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/jobs") {
    sendJson(res, 200, await fetchSacctJobs(url.searchParams));
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Slurm Job History Explorer listening on http://${HOST}:${PORT}`);
});
