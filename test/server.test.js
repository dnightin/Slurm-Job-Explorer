const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  sanitizeNumber,
  sanitizeUser,
  parseDurationToSeconds,
  parseSacctDate,
  formatSacctDate,
  filterJobsByWindow,
  selectNewestJobs,
  parseJobsQuery,
  parseSacctRows,
  parseMemoryToBytes,
  computeCpuEfficiency,
  createSampleResult,
  createServer,
} = require("../server.js");

test("sanitizeNumber clamps to range and falls back on invalid input", () => {
  assert.equal(sanitizeNumber("50", 10, 1, 100), 50);
  assert.equal(sanitizeNumber("500", 10, 1, 100), 100);
  assert.equal(sanitizeNumber("-5", 10, 1, 100), 1);
  assert.equal(sanitizeNumber("abc", 10, 1, 100), 10);
  assert.equal(sanitizeNumber(null, 10, 1, 100), 10);
});

test("sanitizeUser accepts valid Slurm usernames and rejects everything else", () => {
  assert.equal(sanitizeUser("dnightin"), "dnightin");
  assert.equal(sanitizeUser(" aschult2 "), "aschult2");
  assert.equal(sanitizeUser("user.name-1,other_user"), "user.name-1,other_user");
  assert.equal(sanitizeUser(""), "");
  assert.equal(sanitizeUser(null), "");
  assert.equal(sanitizeUser("--user"), null);
  assert.equal(sanitizeUser("bad user"), null);
  assert.equal(sanitizeUser("bad;rm -rf"), null);
});

test("parseDurationToSeconds handles sacct elapsed formats", () => {
  assert.equal(parseDurationToSeconds("00:00:30"), 30);
  assert.equal(parseDurationToSeconds("01:02:03"), 3723);
  assert.equal(parseDurationToSeconds("2-01:02:03"), 2 * 86400 + 3723);
  assert.equal(parseDurationToSeconds("05:06"), 306);
  assert.equal(parseDurationToSeconds("Unknown"), null);
  assert.equal(parseDurationToSeconds("INVALID"), null);
  assert.equal(parseDurationToSeconds(""), null);
  assert.equal(parseDurationToSeconds(undefined), null);
});

test("parseSacctDate rejects sentinel and invalid values", () => {
  assert.equal(parseSacctDate("Unknown"), null);
  assert.equal(parseSacctDate("INVALID"), null);
  assert.equal(parseSacctDate(""), null);
  assert.equal(parseSacctDate("not-a-date"), null);
  assert.ok(parseSacctDate("2026-07-31T04:30:01") instanceof Date);
});

test("formatSacctDate round-trips through parseSacctDate", () => {
  const date = new Date(2026, 6, 31, 4, 30, 1);
  assert.equal(formatSacctDate(date), "2026-07-31T04:30:01");
});

test("parseSacctRows drops rows with no jobId or unparseable elapsed", () => {
  const stdout = [
    "123|job|user|acct|part|COMPLETED|2026-07-31T00:00:00|2026-07-31T00:00:01|2026-07-31T00:05:01|00:05:00|4|00:00:00|100M",
    "|job2|user|acct|part|COMPLETED|2026-07-31T00:00:00|2026-07-31T00:00:01|2026-07-31T00:05:01|00:05:00|4|00:00:00|100M",
    "124|job3|user|acct|part|COMPLETED|2026-07-31T00:00:00|2026-07-31T00:00:01|2026-07-31T00:05:01|Unknown|4|00:00:00|100M",
  ].join("\n");

  const rows = parseSacctRows(stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, "123");
  assert.equal(rows[0].runtimeSeconds, 300);
});

test("parseMemoryToBytes handles sacct memory units", () => {
  assert.equal(parseMemoryToBytes("2048K"), 2048 * 1024);
  assert.equal(parseMemoryToBytes("3200M"), 3200 * 1024 ** 2);
  assert.equal(parseMemoryToBytes("1.50G"), 1.5 * 1024 ** 3);
  assert.equal(parseMemoryToBytes("512"), 512);
  assert.equal(parseMemoryToBytes(""), null);
  assert.equal(parseMemoryToBytes("n/a"), null);
});

test("computeCpuEfficiency divides CPU time by allocated core time", () => {
  const job = { state: "COMPLETED", runtimeSeconds: 600, allocCpus: 4, totalCpu: "20:00.000" };
  assert.equal(computeCpuEfficiency(job), 0.5);
  assert.equal(computeCpuEfficiency({ ...job, state: "RUNNING" }), null);
  assert.equal(computeCpuEfficiency({ ...job, allocCpus: 0 }), null);
  assert.equal(computeCpuEfficiency({ ...job, runtimeSeconds: 0 }), null);
  assert.equal(computeCpuEfficiency({ ...job, totalCpu: "" }), null);
});

test("parseSacctRows takes peak memory from job steps and computes wait time", () => {
  const stdout = [
    "200|sim|ada|acct|batch|COMPLETED|2026-07-31T00:00:00|2026-07-31T00:10:00|2026-07-31T00:20:00|00:10:00|2|00:15:00|",
    "200.batch|batch|||||2026-07-31T00:10:00|2026-07-31T00:10:00|2026-07-31T00:20:00|00:10:00|2|00:14:00|1500M",
    "200.extern|extern|||||2026-07-31T00:10:00|2026-07-31T00:10:00|2026-07-31T00:20:00|00:10:00|2|00:00:01|4K",
    "200.0|mpi|||||2026-07-31T00:11:00|2026-07-31T00:11:00|2026-07-31T00:19:00|00:08:00|2|00:00:59|2G",
    "201|idle|ada|acct|batch|PENDING|2026-07-31T00:00:00|Unknown|Unknown|00:00:00|1|00:00:00|",
  ].join("\n");

  const rows = parseSacctRows(stdout);
  assert.deepEqual(rows.map((row) => row.jobId), ["200", "201"]);
  assert.equal(rows[0].maxRssBytes, 2 * 1024 ** 3);
  assert.equal(rows[0].waitSeconds, 600);
  assert.equal(rows[0].cpuEfficiency, 0.75);
  assert.equal(rows[1].maxRssBytes, null);
  assert.equal(rows[1].waitSeconds, null);
  assert.equal(rows[1].cpuEfficiency, null);
});

test("filterJobsByWindow keeps only jobs whose start falls in range", () => {
  const jobs = [
    { start: "2026-07-30T00:00:00" },
    { start: "2026-07-31T12:00:00" },
    { start: "2026-08-02T00:00:00" },
  ];
  const result = filterJobsByWindow(
    jobs,
    new Date(2026, 6, 31, 0, 0, 0),
    new Date(2026, 6, 31, 23, 59, 59)
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].start, "2026-07-31T12:00:00");
});

test("selectNewestJobs keeps the newest jobs, reports truncation, and adds startMs", () => {
  const jobs = [
    { jobId: "1", start: "2026-07-31T01:00:00" },
    { jobId: "2", start: "2026-07-31T03:00:00" },
    { jobId: "3", start: "Unknown", submit: "2026-07-31T02:00:00" },
    { jobId: "4", start: "2026-08-05T00:00:00" },
  ];
  const result = selectNewestJobs(
    jobs,
    new Date(2026, 6, 31, 0, 0, 0),
    new Date(2026, 6, 31, 23, 59, 59),
    2
  );
  assert.deepEqual(result.jobs.map((job) => job.jobId), ["2", "3"]);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.jobs[1].startMs, new Date(2026, 6, 31, 2, 0, 0).getTime());
});

test("parseJobsQuery rejects invalid users, dates, and oversized windows", () => {
  const parse = (query) => parseJobsQuery(new URLSearchParams(query));

  assert.throws(() => parse("user=bad;user"), { status: 400 });
  assert.throws(() => parse("start=not-a-date"), { status: 400 });
  assert.throws(() => parse("start=2026-08-02T00:00:00&end=2026-08-01T00:00:00"), { status: 400 });
  assert.throws(() => parse("start=1970-01-01T00:00:00&end=2026-08-01T00:00:00"), { status: 400 });

  const options = parse("days=7&limit=50&user=ada,grace&end=2026-08-01T00:00:00");
  assert.equal(options.limit, 50);
  assert.equal(options.user, "ada,grace");
  assert.equal(options.end - options.start, 7 * 24 * 60 * 60 * 1000);
});

test("createSampleResult filters by every user in a comma list", () => {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const result = createSampleResult({ limit: 5000, user: "ada,grace", start, end });
  const users = new Set(result.jobs.map((job) => job.user));
  assert.equal(result.source, "sample");
  assert.deepEqual([...users].sort(), ["ada", "grace"]);
});

// Puts a fake `sacct` shell script first on PATH for the duration of run().
async function withFakeSacct(script, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sacct-"));
  fs.writeFileSync(path.join(dir, "sacct"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    await run();
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(text));
    let response = "";
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("a malformed Host header does not crash the server", async () => {
  await withServer(async (baseUrl, port) => {
    const response = await rawRequest(port, "GET /api/jobs?user=bad%3B HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 400/);

    const followUp = await fetch(`${baseUrl}/`);
    assert.equal(followUp.status, 200);
  });
});

test("/api/jobs returns 400 for an invalid user", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs?user=bad%3Buser`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Invalid user/);
  });
});

test("/api/jobs returns 502 instead of sample data when sacct is missing", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs`);
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /not found/);
    });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("/api/jobs returns the newest sacct rows with totals", { skip: process.platform === "win32" }, async () => {
  const today = new Date();
  const stamp = (hour) => formatSacctDate(new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour));
  const rows = [1, 2, 3].map((hour) =>
    `${hour}|job${hour}|ada|acct|batch|COMPLETED|${stamp(hour)}|${stamp(hour)}|${stamp(hour)}|00:01:00|1|00:00:30|10M`
  );
  // Today's early hours fall in a 1-day window ending at end of day.
  const end = formatSacctDate(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59));

  await withFakeSacct(`printf '${rows.join("\\n")}\\n'`, async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs?days=1&limit=10&end=${end}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.source, "sacct");
      assert.equal(payload.total, 3);
      assert.equal(payload.truncated, false);
      assert.deepEqual(payload.jobs.map((job) => job.jobId), ["3", "2", "1"]);
      assert.ok(payload.jobs.every((job) => Number.isFinite(job.startMs)));
    });
  });
});

test("/api/jobs reports a sacct failure as 502 without leaking stderr", { skip: process.platform === "win32" }, async () => {
  await withFakeSacct("echo 'secret slurmdbd host details' >&2; exit 1", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs`);
      assert.equal(response.status, 502);
      const { error } = await response.json();
      assert.doesNotMatch(error, /secret/);
    });
  });
});
