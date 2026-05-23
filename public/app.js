const chart = document.querySelector("#runtimeChart");
const ctx = chart.getContext("2d");
const form = document.querySelector("#filters");
const tooltip = document.querySelector("#tooltip");
const statusEl = document.querySelector("#status");
const jobCountEl = document.querySelector("#jobCount");
const medianRuntimeEl = document.querySelector("#medianRuntime");
const p95RuntimeEl = document.querySelector("#p95Runtime");
const sourceEl = document.querySelector("#source");

let plottedPoints = [];
let currentJobs = [];

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

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function resizeCanvas() {
  const rect = chart.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.round(rect.width * ratio);
  chart.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawChart(jobs) {
  resizeCanvas();

  const width = chart.clientWidth;
  const height = chart.clientHeight;
  const padding = { top: 24, right: 28, bottom: 52, left: 72 };
  ctx.clearRect(0, 0, width, height);

  const datedJobs = jobs
    .map((job) => ({ ...job, startMs: new Date(job.start || job.submit || job.end).getTime() }))
    .filter((job) => Number.isFinite(job.startMs) && Number.isFinite(job.runtimeSeconds));

  plottedPoints = [];

  if (!datedJobs.length) {
    ctx.fillStyle = "#66736d";
    ctx.font = "700 16px system-ui";
    ctx.fillText("No runtime data found for this window.", padding.left, padding.top + 20);
    return;
  }

  const minX = Math.min(...datedJobs.map((job) => job.startMs));
  const maxX = Math.max(...datedJobs.map((job) => job.startMs));
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
    const radius = Math.max(4, Math.min(9, 3 + Math.log2((job.allocCpus || 1) + 1)));
    const isCompleted = String(job.state).startsWith("COMPLETED");

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isCompleted ? "rgba(22, 122, 114, 0.78)" : "rgba(197, 102, 47, 0.78)";
    ctx.fill();
    ctx.strokeStyle = isCompleted ? "#0d4e49" : "#8f3f18";
    ctx.stroke();

    plottedPoints.push({ x, y, radius: radius + 3, job });
  });
}

function updateSummary(payload) {
  const runtimes = payload.jobs.map((job) => job.runtimeSeconds).filter(Number.isFinite);
  jobCountEl.textContent = payload.jobs.length.toLocaleString();
  medianRuntimeEl.textContent = formatRuntime(quantile(runtimes, 0.5));
  p95RuntimeEl.textContent = formatRuntime(quantile(runtimes, 0.95));
  sourceEl.textContent = payload.source;
  statusEl.textContent = payload.warning || `Showing ${payload.jobs.length.toLocaleString()} jobs from ${payload.source}.`;
}

async function loadJobs() {
  const params = new URLSearchParams(new FormData(form));
  statusEl.textContent = "Loading job history...";
  tooltip.hidden = true;

  try {
    const response = await fetch(`/api/jobs?${params.toString()}`);
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const payload = await response.json();
    currentJobs = payload.jobs;
    updateSummary(payload);
    drawChart(currentJobs);
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
  tooltip.style.left = `${hit.x}px`;
  tooltip.style.top = `${hit.y}px`;
  tooltip.innerHTML = `
    <strong>${hit.job.jobId} · ${hit.job.jobName || "job"}</strong>
    Runtime: ${formatRuntime(hit.job.runtimeSeconds)}<br>
    State: ${hit.job.state || "Unknown"}<br>
    User: ${hit.job.user || "Unknown"}<br>
    Start: ${formatDate(hit.job.start)}
  `;
});

chart.addEventListener("mouseleave", () => {
  tooltip.hidden = true;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadJobs();
});

window.addEventListener("resize", () => drawChart(currentJobs));

loadJobs();
