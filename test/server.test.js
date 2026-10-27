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
  selectWindowJobs,
  parseJobsQuery,
  parseSacctRows,
  parseStepPeakMemory,
  parseMemoryToBytes,
  computeCpuEfficiency,
  createSampleResult,
  createServer,
  clearSacctCache,
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

test("parseSacctRows skips step rows and computes wait time and efficiency", () => {
  const stdout = [
    "200|sim|ada|acct|batch|COMPLETED|2026-07-31T00:00:00|2026-07-31T00:10:00|2026-07-31T00:20:00|00:10:00|2|00:15:00|",
    "200.batch|batch|||||2026-07-31T00:10:00|2026-07-31T00:10:00|2026-07-31T00:20:00|00:10:00|2|00:14:00|1500M",
    "201|idle|ada|acct|batch|PENDING|2026-07-31T00:00:00|Unknown|Unknown|00:00:00|1|00:00:00|",
  ].join("\n");

  const rows = parseSacctRows(stdout);
  assert.deepEqual(rows.map((row) => row.jobId), ["200", "201"]);
  assert.equal(rows[0].waitSeconds, 600);
  assert.equal(rows[0].cpuEfficiency, 0.75);
  assert.equal(rows[1].waitSeconds, null);
  assert.equal(rows[1].cpuEfficiency, null);
});

test("parseStepPeakMemory takes the largest MaxRSS across each job's steps", () => {
  const peaks = parseStepPeakMemory(["200|", "200.batch|1500M", "200.extern|4K", "200.0|2G", "201|", "202.batch|"].join("\n"));
  assert.equal(peaks.get("200"), 2 * 1024 ** 3);
  assert.equal(peaks.has("201"), false);
  assert.equal(peaks.has("202"), false);
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

test("selectWindowJobs sorts newest first, reports truncation, and adds startMs", () => {
  const jobs = [
    { jobId: "1", start: "2026-07-31T01:00:00" },
    { jobId: "2", start: "2026-07-31T03:00:00" },
    { jobId: "3", start: "Unknown", submit: "2026-07-31T02:00:00" },
    { jobId: "4", start: "2026-08-05T00:00:00" },
  ];
  const result = selectWindowJobs(
    jobs,
    new Date(2026, 6, 31, 0, 0, 0),
    new Date(2026, 6, 31, 23, 59, 59),
    2
  );
  assert.deepEqual(result.jobs.map((job) => job.jobId), ["2", "3"]);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.jobs[1].startMs, new Date(2026, 6, 31, 2, 0, 0).getTime());
  assert.equal(result.windowStartMs, new Date(2026, 6, 31, 0, 0, 0).getTime());
  assert.equal(result.windowEndMs, new Date(2026, 6, 31, 23, 59, 59).getTime());
});

test("selectWindowJobs samples evenly across the window when over the limit", () => {
  // 100 jobs, one per hour; the newest-only approach would keep hours 90-99.
  const base = new Date(2026, 6, 1, 0, 0, 0).getTime();
  const jobs = Array.from({ length: 100 }, (_, hour) => ({
    jobId: String(hour),
    start: formatSacctDate(new Date(base + hour * 3600 * 1000)),
  }));
  const result = selectWindowJobs(jobs, new Date(base), new Date(base + 100 * 3600 * 1000), 10);

  assert.equal(result.jobs.length, 10);
  assert.equal(result.total, 100);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.jobs.map((job) => job.jobId), ["99", "89", "79", "69", "59", "49", "39", "29", "19", "9"]);
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
  clearSacctCache();
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

test("/api/jobs fetches peak memory with a second, job-scoped sacct query", { skip: process.platform === "win32" }, async () => {
  const today = new Date();
  const stamp = formatSacctDate(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 1));
  const end = formatSacctDate(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59));
  const allocation = `300|sim|ada|acct|batch|COMPLETED|${stamp}|${stamp}|${stamp}|00:10:00|2|00:10:00|`;
  // The main query must ask for allocations only; steps come from the --jobs query.
  const script = [
    'case "$*" in',
    `  *"--jobs 300"*) printf '300|\\n300.batch|512M\\n300.0|1G\\n' ;;`,
    `  *--allocations*) printf '${allocation}\\n' ;;`,
    "  *) exit 3 ;;",
    "esac",
  ].join("\n");

  await withFakeSacct(script, async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs?days=1&end=${end}`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.warning, null);
      assert.equal(payload.jobs[0].maxRssBytes, 1024 ** 3);
    });
  });
});

test("narrower windows and single-user views reuse a cached sacct pull", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sacct-cache-"));
  const rowsFile = path.join(dir, "rows.txt");
  const callLog = path.join(dir, "calls.log");
  const hoursAgo = (hours) => formatSacctDate(new Date(Date.now() - hours * 3600 * 1000));
  // Two jobs a day for 20 days, alternating users.
  const rows = Array.from({ length: 40 }, (_, i) => {
    const at = hoursAgo(i * 12 + 1);
    return `${500 + i}|job|${i % 2 ? "grace" : "ada"}|acct|batch|COMPLETED|${at}|${at}|${at}|00:10:00|1|00:05:00|`;
  });
  fs.writeFileSync(rowsFile, `${rows.join("\n")}\n`);
  const script = [
    `echo "$*" >> ${callLog}`,
    'case "$*" in',
    "  *--jobs*) exit 0 ;;",
    `  *) cat ${rowsFile} ;;`,
    "esac",
  ].join("\n");
  const mainCalls = () => fs.readFileSync(callLog, "utf8").split("\n").filter((line) => line.includes("--allocations")).length;
  const jobsCalls = () => fs.readFileSync(callLog, "utf8").split("\n").filter((line) => line.includes("--jobs")).length;

  await withFakeSacct(script, async () => {
    await withServer(async (baseUrl) => {
      const get = async (query) => (await fetch(`${baseUrl}/api/jobs?limit=5000&${query}`)).json();

      const month = await get("days=30");
      assert.equal(month.fromCache, false);
      assert.equal(month.total, 40);
      assert.equal(mainCalls(), 1);
      assert.equal(jobsCalls(), 1);

      const week = await get("days=7");
      assert.equal(week.fromCache, true);
      assert.equal(week.total, 14);
      assert.equal(week.fetchedAt, month.fetchedAt);
      assert.equal(mainCalls(), 1);
      assert.equal(jobsCalls(), 1, "finished jobs' peak memory is remembered");

      const ada = await get("days=7&user=ada");
      assert.equal(ada.fromCache, true);
      assert.ok(ada.jobs.every((job) => job.user === "ada"));
      assert.equal(mainCalls(), 1);

      assert.equal((await get("days=90")).fromCache, false);
      assert.equal(mainCalls(), 2);

      assert.equal((await get("days=7&refresh=1")).fromCache, false);
      assert.equal(mainCalls(), 3);
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an abandoned /api/jobs request stops its sacct process", { skip: process.platform === "win32" }, async () => {
  const pidFile = path.join(os.tmpdir(), `fake-sacct-pid-${process.pid}`);
  await withFakeSacct(`echo $$ > ${pidFile}; exec sleep 30`, async () => {
    await withServer(async (baseUrl) => {
      const controller = new AbortController();
      const request = fetch(`${baseUrl}/api/jobs`, { signal: controller.signal }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      controller.abort();
      await request;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    });
  });
  fs.rmSync(pidFile, { force: true });
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
