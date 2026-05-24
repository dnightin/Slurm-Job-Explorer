const chart = document.querySelector("#runtimeChart");
const ctx = chart.getContext("2d");
const form = document.querySelector("#filters");
const tooltip = document.querySelector("#tooltip");
const daysEl = document.querySelector("#days");
const statusEl = document.querySelector("#status");
const datasetMetaEl = document.querySelector("#datasetMeta");
const jobCountEl = document.querySelector("#jobCount");
const medianRuntimeEl = document.querySelector("#medianRuntime");
const longestRuntimeEl = document.querySelector("#longestRuntime");
const successRateEl = document.querySelector("#successRate");
const problemJobsEl = document.querySelector("#problemJobs");
const sourceEl = document.querySelector("#source");
const resetZoomButton = document.querySelector("#resetZoom");
const stateLegendEl = document.querySelector("#stateLegend");
const userFilterEl = document.querySelector("#userFilter");

const STATE_STYLES = {
  COMPLETED: { label: "Completed", fill: "rgba(22, 122, 114, 0.78)", stroke: "#0d4e49" },
  FAILED: { label: "Failed", fill: "rgba(193, 67, 67, 0.78)", stroke: "#8f2424" },
  CANCELLED: { label: "Cancelled", fill: "rgba(112, 102, 173, 0.78)", stroke: "#4f4787" },
  TIMEOUT: { label: "Timeout", fill: "rgba(197, 102, 47, 0.78)", stroke: "#8f3f18" },
  RUNNING: { label: "Running", fill: "rgba(48, 112, 185, 0.78)", stroke: "#245380" },
  PENDING: { label: "Pending", fill: "rgba(117, 126, 44, 0.78)", stroke: "#5d641f" },
  OTHER: { label: "Other", fill: "rgba(102, 115, 109, 0.72)", stroke: "#4f5a55" },
};

const RUNTIME_BUCKETS = [
  { label: "0-12 hours", maxSeconds: 12 * 60 * 60, radius: 4 },
  { label: "13-72 hours", maxSeconds: 72 * 60 * 60, radius: 6 },
  { label: "73 hours-1 week", maxSeconds: 7 * 24 * 60 * 60, radius: 8 },
  { label: "2 weeks", maxSeconds: 28 * 24 * 60 * 60, radius: 10 },
  { label: "28+ days", maxSeconds: Infinity, radius: 13 },
];

let plottedPoints = [];
let loadedJobs = [];
let currentJobs = [];
let fullTimeRange = null;
let timeRange = null;
let lastPayload = null;
let plotArea = null;

function formatRuntime(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 7200 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDateRange(start, end) {
  if (!start || !end) return "-";

  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function normalizeState(state) {
  const normalized = String(state || "OTHER").toUpperCase().split(/[ +]/)[0];
  return STATE_STYLES[normalized] ? normalized : "OTHER";
}

function getStateStyle(state) {
  return STATE_STYLES[normalizeState(state)];
}

function getRuntimeBucket(runtimeSeconds) {
  const bucket = RUNTIME_BUCKETS.findIndex((range) => runtimeSeconds <= range.maxSeconds);
  return bucket === -1 ? RUNTIME_BUCKETS.length - 1 : bucket;
}

function renderStateLegend(jobs) {
  const states = [...new Set(jobs.map((job) => normalizeState(job.state)))];
  const orderedStates = Object.keys(STATE_STYLES).filter((state) => states.includes(state));

  stateLegendEl.innerHTML = orderedStates
    .map((state) => {
      const style = STATE_STYLES[state];
      return `<span><i style="background:${style.fill}; border-color:${style.stroke}"></i>${style.label}</span>`;
    })
    .join("");
}

function renderUserFilter(jobs) {
  const selectedUser = userFilterEl.value;
  const users = [...new Set(jobs.map((job) => job.user).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const nextValue = users.includes(selectedUser) ? selectedUser : "";

  userFilterEl.innerHTML = [
    '<option value="">All users</option>',
    ...users.map((user) => `<option value="${escapeHtml(user)}">${escapeHtml(user)}</option>`),
  ].join("");
  userFilterEl.value = nextValue;
}

function getFilteredJobs() {
  const selectedUser = userFilterEl.value;
  if (!selectedUser) return loadedJobs;
  return loadedJobs.filter((job) => job.user === selectedUser);
}

function applyFilters() {
  currentJobs = getFilteredJobs();
  renderStateLegend(currentJobs);
  setFullTimeRange(currentJobs);
  updateSummary();
  drawChart(currentJobs);
}

function resizeCanvas() {
  const rect = chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.round(rect.width * ratio);
  chart.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function getDatedJobs(jobs) {
  return jobs
    .map((job) => ({ ...job, startMs: new Date(job.start || job.submit || job.end).getTime() }))
    .filter((job) => Number.isFinite(job.startMs) && Number.isFinite(job.runtimeSeconds));
}

function setFullTimeRange(jobs) {
  const datedJobs = getDatedJobs(jobs);
  if (!datedJobs.length) {
    fullTimeRange = null;
    timeRange = null;
    return;
  }

  const min = Math.min(...datedJobs.map((job) => job.startMs));
  const max = Math.max(...datedJobs.map((job) => job.startMs));
  const pad = Math.max(1, (max - min) * 0.02);
  fullTimeRange = { min: min - pad, max: max + pad };
  timeRange = { ...fullTimeRange };
}

function isZoomed() {
  if (!fullTimeRange || !timeRange) return false;
  return timeRange.min > fullTimeRange.min || timeRange.max < fullTimeRange.max;
}

function updateZoomControl() {
  resetZoomButton.disabled = !isZoomed();
}

function updateStatusText(visibleCount) {
  if (!lastPayload) return;

  const selectedUser = userFilterEl.value;
  const filteredText = selectedUser ? ` for ${selectedUser}` : "";
  const sourceText = lastPayload.warning || `Showing ${currentJobs.length.toLocaleString()} of ${loadedJobs.length.toLocaleString()} jobs${filteredText} from ${lastPayload.source}.`;
  if (isZoomed()) {
    statusEl.textContent = `${sourceText} Zoomed to ${visibleCount.toLocaleString()} visible jobs.`;
    return;
  }

  statusEl.textContent = sourceText;
}

function updateDatasetMeta() {
  const selectedUser = userFilterEl.value || "All users";
  const selectedWindow = daysEl.options[daysEl.selectedIndex]?.textContent || `${daysEl.value} days`;
  const source = lastPayload?.source || "-";
  const range = fullTimeRange ? formatDateRange(fullTimeRange.min, fullTimeRange.max) : "-";

  datasetMetaEl.textContent = `${selectedWindow} · ${selectedUser} · ${source} · ${range}`;
}

function drawChart(jobs) {
  resizeCanvas();

  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const padding = { top: 24, right: 28, bottom: 52, left: 72 };
  plotArea = {
    left: padding.left,
    right: width - padding.right,
    top: padding.top,
    bottom: height - padding.bottom,
  };
  ctx.clearRect(0, 0, width, height);

  const range = timeRange || fullTimeRange;
  const datedJobs = getDatedJobs(jobs).filter((job) => {
    if (!range) return true;
    return job.startMs >= range.min && job.startMs <= range.max;
  });

  plottedPoints = [];
  updateZoomControl();
  updateStatusText(datedJobs.length);

  if (!datedJobs.length) {
    ctx.fillStyle = "#66736d";
    ctx.font = "700 16px system-ui";
    ctx.fillText("No runtime data found for this window.", padding.left, padding.top + 20);
    return;
  }

  const minX = range ? range.min : Math.min(...datedJobs.map((job) => job.startMs));
  const maxX = range ? range.max : Math.max(...datedJobs.map((job) => job.startMs));
  const maxRuntime = Math.max(...datedJobs.map((job) => job.runtimeSeconds));
  const yMax = Math.max(60, maxRuntime * 1.08);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xRange = Math.max(1, maxX - minX);

  const xFor = (value) => padding.left + ((value - minX) / xRange) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - (value / yMax) * plotHeight;

  ctx.strokeStyle = "#dbe2dc";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66736d";
  ctx.font = "12px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= 4; i += 1) {
    const runtime = (yMax / 4) * i;
    const y = yFor(runtime);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(formatRuntime(runtime), padding.left - 12, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i += 1) {
    const value = minX + (xRange / 4) * i;
    const x = xFor(value);
    ctx.fillText(formatDate(value), x, height - padding.bottom + 18);
  }

  ctx.strokeStyle = "#9aa8a1";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  datedJobs.forEach((job) => {
    const x = xFor(job.startMs);
    const y = yFor(job.runtimeSeconds);
    const bucket = getRuntimeBucket(job.runtimeSeconds);
    const runtimeBucket = RUNTIME_BUCKETS[bucket];
    const radius = runtimeBucket.radius;
    const stateStyle = getStateStyle(job.state);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = stateStyle.fill;
    ctx.fill();
    ctx.strokeStyle = stateStyle.stroke;
    ctx.stroke();

    plottedPoints.push({ x, y, radius: radius + 4, job, bucket: runtimeBucket });
  });
}

function updateSummary() {
  const runtimes = currentJobs.map((job) => job.runtimeSeconds).filter(Number.isFinite);
  const completedJobs = currentJobs.filter((job) => normalizeState(job.state) === "COMPLETED").length;
  const problemJobs = Math.max(0, currentJobs.length - completedJobs);
  const successRate = currentJobs.length ? Math.round((completedJobs / currentJobs.length) * 100) : null;

  jobCountEl.textContent = currentJobs.length.toLocaleString();
  medianRuntimeEl.textContent = formatRuntime(quantile(runtimes, 0.5));
  longestRuntimeEl.textContent = formatRuntime(runtimes.length ? Math.max(...runtimes) : null);
  successRateEl.textContent = successRate == null ? "-" : `${successRate}%`;
  problemJobsEl.textContent = problemJobs.toLocaleString();
  sourceEl.textContent = lastPayload?.source || "-";
  updateDatasetMeta();
  updateStatusText(currentJobs.length);
}

function positionTooltip(hit) {
  const margin = 12;
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const tooltipRect = tooltip.getBoundingClientRect();
  let left = hit.x + margin;
  let top = hit.y - tooltipRect.height / 2;

  if (left + tooltipRect.width + margin > width) {
    left = hit.x - tooltipRect.width - margin;
  }

  left = Math.max(margin, Math.min(width - tooltipRect.width - margin, left));
  top = Math.max(margin, Math.min(height - tooltipRect.height - margin, top));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

async function loadJobs() {
  const params = new URLSearchParams(new FormData(form));
  statusEl.textContent = "Loading job history...";
  tooltip.hidden = true;

  try {
    const response = await fetch(`/api/jobs?${params.toString()}`);
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const payload = await response.json();
    lastPayload = payload;
    loadedJobs = payload.jobs;
    renderUserFilter(loadedJobs);
    applyFilters();
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

chart.addEventListener("mousemove", (event) => {
  const rect = chart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = plottedPoints.find((point) => Math.hypot(point.x - x, point.y - y) <= point.radius);

  if (!hit) {
    tooltip.hidden = true;
    return;
  }

  tooltip.hidden = false;
  tooltip.innerHTML = `
    <strong>${hit.job.jobId} · ${hit.job.jobName || "job"}</strong>
    Runtime: ${formatRuntime(hit.job.runtimeSeconds)}<br>
    Runtime size: ${hit.bucket.label}<br>
    State: ${hit.job.state || "Unknown"}<br>
    User: ${hit.job.user || "Unknown"}<br>
    Start: ${formatDate(hit.job.start)}
  `;
  positionTooltip(hit);
});

chart.addEventListener("wheel", (event) => {
  if (!fullTimeRange || !timeRange || !plotArea) return;

  event.preventDefault();
  tooltip.hidden = true;

  const rect = chart.getBoundingClientRect();
  const pointerX = Math.max(plotArea.left, Math.min(plotArea.right, event.clientX - rect.left));
  const pointerRatio = (pointerX - plotArea.left) / Math.max(1, plotArea.right - plotArea.left);
  const currentSpan = timeRange.max - timeRange.min;
  const fullSpan = fullTimeRange.max - fullTimeRange.min;
  const minSpan = Math.max(60 * 1000, fullSpan / 500);
  const scale = event.deltaY < 0 ? 0.82 : 1.22;
  const nextSpan = Math.max(minSpan, Math.min(fullSpan, currentSpan * scale));
  const anchor = timeRange.min + currentSpan * pointerRatio;

  let nextMin = anchor - nextSpan * pointerRatio;
  let nextMax = nextMin + nextSpan;

  if (nextMin < fullTimeRange.min) {
    nextMin = fullTimeRange.min;
    nextMax = nextMin + nextSpan;
  }

  if (nextMax > fullTimeRange.max) {
    nextMax = fullTimeRange.max;
    nextMin = nextMax - nextSpan;
  }

  timeRange = { min: nextMin, max: nextMax };
  drawChart(currentJobs);
}, { passive: false });

chart.addEventListener("mouseleave", () => {
  tooltip.hidden = true;
});

resetZoomButton.addEventListener("click", () => {
  if (!fullTimeRange) return;
  timeRange = { ...fullTimeRange };
  drawChart(currentJobs);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadJobs();
});

daysEl.addEventListener("change", () => {
  loadJobs();
});

userFilterEl.addEventListener("change", () => {
  tooltip.hidden = true;
  applyFilters();
});

window.addEventListener("resize", () => drawChart(currentJobs));

loadJobs();
