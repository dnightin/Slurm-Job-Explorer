const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeNumber,
  sanitizeUser,
  parseDurationToSeconds,
  parseSacctDate,
  formatSacctDate,
  filterJobsByWindow,
  parseSacctRows,
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
  assert.equal(sanitizeUser("--user"), "");
  assert.equal(sanitizeUser("bad user"), "");
  assert.equal(sanitizeUser("bad;rm -rf"), "");
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
