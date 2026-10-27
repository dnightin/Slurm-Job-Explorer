const chart = document.querySelector("#runtimeChart");
const ctx = chart.getContext("2d");
const form = document.querySelector("#filters");
const tooltip = document.querySelector("#tooltip");
const daysEl = document.querySelector("#days");
const statusEl = document.querySelector("#status");
const noticeEl = document.querySelector("#notice");
const datasetMetaEl = document.querySelector("#datasetMeta");
const jobCountEl = document.querySelector("#jobCount");
const medianRuntimeEl = document.querySelector("#medianRuntime");
const longestRuntimeEl = document.querySelector("#longestRuntime");
const successRateEl = document.querySelector("#successRate");
const problemJobsEl = document.querySelector("#problemJobs");
const problemJobsCaptionEl = document.querySelector("#problemJobsCaption");
const resetZoomButton = document.querySelector("#resetZoom");
const logScaleEl = document.querySelector("#logScale");
const stateLegendEl = document.querySelector("#stateLegend");
const userFilterEl = document.querySelector("#userFilter");
const jobsTableBodyEl = document.querySelector("#jobsTableBody");

// Categorical palette validated with the dataviz skill's validate_palette.js
// (--pairs all, since points overlap freely in a scatter chart): all adjacent
// and all-pairs checks clear except two documented, mitigated exceptions —
// CVD separation in the 6-8 floor band (legal with secondary encoding, which
// this chart has: the legend and tooltip always show the state as text, and
// the accessible table lists it in plain text too) and sub-3:1 fill contrast
// for Completed/Timeout against the white chart surface (mitigated the same
// way, plus every dot carries a darker solid stroke ring for definition).
// Out of memory was added as a seventh hue and re-validated all-pairs: the
// worst pair is unchanged. Node fail is a neutral like Other and is told
// apart by its diamond shape rather than by an eighth hue.
const STATE_STYLES = {
  COMPLETED: { label: "Completed", fill: "rgba(0, 131, 0, 0.78)", stroke: "#005100" },
  FAILED: { label: "Failed", fill: "rgba(227, 73, 72, 0.78)", stroke: "#8d2d2d" },
  CANCELLED: { label: "Cancelled", fill: "rgba(74, 58, 167, 0.78)", stroke: "#2e2468" },
  TIMEOUT: { label: "Timeout", fill: "rgba(237, 161, 0, 0.78)", stroke: "#936400" },
  RUNNING: { label: "Running", fill: "rgba(42, 120, 214, 0.78)", stroke: "#1a4a85" },
  PENDING: { label: "Pending", fill: "rgba(27, 175, 122, 0.78)", stroke: "#116d4c" },
  OUT_OF_MEMORY: { label: "Out of memory", fill: "rgba(176, 58, 140, 0.78)", stroke: "#6b2355" },
  NODE_FAIL: { label: "Node fail", fill: "rgba(59, 69, 64, 0.78)", stroke: "#1f2622", shape: "diamond" },
  OTHER: { label: "Other", fill: "rgba(102, 115, 109, 0.72)", stroke: "#4f5a55" },
};

const POINT_RADIUS = 6;

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

function renderStateLegend(jobs) {
  const states = [...new Set(jobs.map((job) => normalizeState(job.state)))];
  const orderedStates = Object.keys(STATE_STYLES).filter((state) => states.includes(state));

  stateLegendEl.innerHTML = orderedStates
    .map((state) => {
      const style = STATE_STYLES[state];
      const shapeClass = style.shape ? ` class="${style.shape}"` : "";
      return `<span><i${shapeClass} style="background:${style.fill}; border-color:${style.stroke}"></i>${style.label}</span>`;
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

function renderAccessibleTable(jobs) {
  jobsTableBodyEl.innerHTML = jobs
    .map((job) => `
      <tr>
        <td>${escapeHtml(job.jobId)}</td>
        <td>${escapeHtml(job.jobName || "-")}</td>
        <td>${escapeHtml(job.user || "Unknown")}</td>
        <td>${escapeHtml(job.state || "Unknown")}</td>
        <td>${escapeHtml(formatDate(job.start))}</td>
        <td>${escapeHtml(formatRuntime(job.runtimeSeconds))}</td>
      </tr>
    `)
    .join("");
}

function applyFilters() {
  currentJobs = getFilteredJobs();
  renderStateLegend(currentJobs);
  renderAccessibleTable(currentJobs);
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

// startMs comes from the server, which dates each job by Start, then Submit,
// then End, the same rule it uses to filter the window.
function getDatedJobs(jobs) {
  return jobs.filter((job) => Number.isFinite(job.startMs) && Number.isFinite(job.runtimeSeconds));
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
  const truncatedText = lastPayload.truncated
    ? ` These are the newest ${loadedJobs.length.toLocaleString()} of ${lastPayload.total.toLocaleString()} jobs in the window; raise Limit to see more.`
    : "";
  const sourceText = `Showing ${currentJobs.length.toLocaleString()} of ${loadedJobs.length.toLocaleString()} jobs${filteredText} from ${formatSourceLabel(lastPayload.source)}.${truncatedText}`;
  if (isZoomed()) {
    statusEl.textContent = `${sourceText} Zoomed to ${visibleCount.toLocaleString()} visible jobs.`;
    return;
  }

  statusEl.textContent = sourceText;
}

function formatSourceLabel(source) {
  if (source === "sample") return "sample data";
  if (source === "sacct") return "live sacct data";
  return source || "-";
}

function updateDatasetMeta() {
  const selectedUser = userFilterEl.value || "All users";
  const selectedWindow = daysEl.options[daysEl.selectedIndex]?.textContent || `${daysEl.value} days`;
  const source = formatSourceLabel(lastPayload?.source);
  const range = fullTimeRange ? formatDateRange(fullTimeRange.min, fullTimeRange.max) : "-";

  datasetMetaEl.textContent = `Window: ${selectedWindow} · User: ${selectedUser} · Source: ${source} · Range: ${range}`;
}

function createLinearScale(runtimes) {
  const max = Math.max(60, Math.max(...runtimes) * 1.08);
  return {
    fraction: (value) => value / max,
    ticks: [0, 1, 2, 3, 4].map((i) => ({ value: (max / 4) * i, label: formatRuntime((max / 4) * i) })),
  };
}

// Round durations people recognize, used as log-axis gridlines.
const LOG_TICKS = [
  { value: 1, label: "1s" },
  { value: 10, label: "10s" },
  { value: 60, label: "1m" },
  { value: 600, label: "10m" },
  { value: 3600, label: "1h" },
  { value: 6 * 3600, label: "6h" },
  { value: 86400, label: "1d" },
  { value: 7 * 86400, label: "7d" },
  { value: 30 * 86400, label: "30d" },
  { value: 365 * 86400, label: "1y" },
];

// Runtimes under a second (including pending jobs at 0) sit on the 1s floor.
function createLogScale(runtimes) {
  const clamp = (value) => Math.max(1, value);
  const minRuntime = clamp(Math.min(...runtimes));
  const maxRuntime = clamp(Math.max(...runtimes));
  const lowTick = [...LOG_TICKS].reverse().find((tick) => tick.value <= minRuntime) || LOG_TICKS[0];
  const highTick = LOG_TICKS.find((tick) => tick.value >= maxRuntime) || LOG_TICKS[LOG_TICKS.length - 1];
  const low = Math.log10(lowTick.value);
  // A little headroom so the longest job doesn't sit on the top edge.
  const high = Math.max(low + 1, Math.log10(maxRuntime) + 0.1, Math.log10(highTick.value));

  return {
    fraction: (value) => (Math.log10(clamp(value)) - low) / (high - low),
    ticks: LOG_TICKS.filter((tick) => tick.value >= lowTick.value && Math.log10(tick.value) <= high),
  };
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
    ctx.fillStyle = "#57645e";
    ctx.font = "700 16px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "No runtime data found for this window.",
      (plotArea.left + plotArea.right) / 2,
      (plotArea.top + plotArea.bottom) / 2
    );
    return;
  }

  const minX = range ? range.min : Math.min(...datedJobs.map((job) => job.startMs));
  const maxX = range ? range.max : Math.max(...datedJobs.map((job) => job.startMs));
  const runtimes = datedJobs.map((job) => job.runtimeSeconds);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xRange = Math.max(1, maxX - minX);
  const yScale = logScaleEl.checked ? createLogScale(runtimes) : createLinearScale(runtimes);

  const xFor = (value) => padding.left + ((value - minX) / xRange) * plotWidth;
  const yFor = (value) => padding.top + plotHeight - yScale.fraction(value) * plotHeight;

  ctx.strokeStyle = "#dbe2dc";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66736d";
  ctx.font = "12px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  yScale.ticks.forEach((tick) => {
    const y = yFor(tick.value);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(tick.label, padding.left - 12, y);
  });

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
    const stateStyle = getStateStyle(job.state);

    ctx.beginPath();
    if (stateStyle.shape === "diamond") {
      const r = POINT_RADIUS + 1;
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    } else {
      ctx.arc(x, y, POINT_RADIUS, 0, Math.PI * 2);
    }
    ctx.fillStyle = stateStyle.fill;
    ctx.fill();
    ctx.strokeStyle = stateStyle.stroke;
    ctx.stroke();

    plottedPoints.push({ x, y, radius: POINT_RADIUS + 4, job });
  });
}

const NON_COMPLETED_STATE_ORDER = ["FAILED", "OUT_OF_MEMORY", "TIMEOUT", "NODE_FAIL", "CANCELLED", "PENDING", "RUNNING", "OTHER"];

function updateSummary() {
  const runtimes = currentJobs.map((job) => job.runtimeSeconds).filter(Number.isFinite);
  const stateCounts = currentJobs.reduce((counts, job) => {
    const state = normalizeState(job.state);
    counts[state] = (counts[state] || 0) + 1;
    return counts;
  }, {});
  const completedJobs = stateCounts.COMPLETED || 0;
  const problemJobs = Math.max(0, currentJobs.length - completedJobs);
  const successRate = currentJobs.length ? Math.round((completedJobs / currentJobs.length) * 100) : null;
  const problemBreakdown = NON_COMPLETED_STATE_ORDER
    .filter((state) => stateCounts[state])
    .map((state) => `${STATE_STYLES[state].label} ${stateCounts[state]}`)
    .join(" · ");

  jobCountEl.textContent = currentJobs.length.toLocaleString();
  medianRuntimeEl.textContent = formatRuntime(quantile(runtimes, 0.5));
  longestRuntimeEl.textContent = formatRuntime(runtimes.length ? Math.max(...runtimes) : null);
  successRateEl.textContent = successRate == null ? "-" : `${successRate}%`;
  problemJobsEl.textContent = problemJobs.toLocaleString();
  problemJobsCaptionEl.textContent = problemBreakdown || "non-completed";
  problemJobsCaptionEl.title = problemBreakdown;
  updateDatasetMeta();
  updateStatusText(currentJobs.length);
}

function showNotice(message, kind) {
  noticeEl.textContent = message || "";
  noticeEl.dataset.kind = kind || "";
  noticeEl.hidden = !message;
}

async function readError(response) {
  try {
    const payload = await response.json();
    if (payload.error) return payload.error;
  } catch {
    // Not JSON; fall through to the status code.
  }
  return `Request failed with ${response.status}`;
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
  const requestedUser = params.get("user") || "";
  statusEl.textContent = "Loading job history...";
  tooltip.hidden = true;

  try {
    const response = await fetch(`/api/jobs?${params.toString()}`);
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json();
    lastPayload = payload;
    showNotice(payload.warning, payload.source === "sample" ? "info" : "warning");
    loadedJobs = payload.jobs;
    // The server already scopes jobs to requestedUser (if set), so only an
    // unfiltered fetch reflects the full set of users for this window.
    if (!requestedUser) {
      renderUserFilter(loadedJobs);
    }
    applyFilters();
  } catch (error) {
    lastPayload = null;
    loadedJobs = [];
    renderUserFilter(loadedJobs);
    applyFilters();
    showNotice(error.message, "error");
    statusEl.textContent = "No data loaded.";
  }
}

chart.addEventListener("mousemove", (event) => {
  const rect = chart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  let hit = null;
  let hitDistance = Infinity;
  for (const point of plottedPoints) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= point.radius && distance < hitDistance) {
      hit = point;
      hitDistance = distance;
    }
  }

  if (!hit) {
    tooltip.hidden = true;
    return;
  }

  tooltip.hidden = false;
  tooltip.style.borderLeftColor = getStateStyle(hit.job.state).stroke;
  tooltip.innerHTML = `
    <strong>${escapeHtml(hit.job.jobId)} · ${escapeHtml(hit.job.jobName || "job")}</strong>
    Runtime: ${formatRuntime(hit.job.runtimeSeconds)}<br>
    State: ${escapeHtml(hit.job.state || "Unknown")}<br>
    User: ${escapeHtml(hit.job.user || "Unknown")}<br>
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

let pinchState = null;

function getTouchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function getTouchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

chart.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 2 || !fullTimeRange || !timeRange || !plotArea) return;

  event.preventDefault();
  tooltip.hidden = true;
  pinchState = {
    distance: getTouchDistance(event.touches),
    range: { ...timeRange },
  };
}, { passive: false });

chart.addEventListener("touchmove", (event) => {
  if (!pinchState || event.touches.length !== 2) return;

  event.preventDefault();

  const rect = chart.getBoundingClientRect();
  const midpoint = getTouchMidpoint(event.touches);
  const pointerX = Math.max(plotArea.left, Math.min(plotArea.right, midpoint.x - rect.left));
  const pointerRatio = (pointerX - plotArea.left) / Math.max(1, plotArea.right - plotArea.left);

  const distance = getTouchDistance(event.touches);
  const scale = pinchState.distance / Math.max(1, distance);
  const baseSpan = pinchState.range.max - pinchState.range.min;
  const fullSpan = fullTimeRange.max - fullTimeRange.min;
  const minSpan = Math.max(60 * 1000, fullSpan / 500);
  const nextSpan = Math.max(minSpan, Math.min(fullSpan, baseSpan * scale));
  const anchor = pinchState.range.min + baseSpan * pointerRatio;

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

chart.addEventListener("touchend", (event) => {
  if (event.touches.length < 2) pinchState = null;
});

logScaleEl.addEventListener("change", () => {
  tooltip.hidden = true;
  drawChart(currentJobs);
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
  loadJobs();
});

window.addEventListener("resize", () => drawChart(currentJobs));

loadJobs();
