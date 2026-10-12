"use strict";
/* Alani Emotion dashboard — vanilla JS, no libraries, no external requests.
   Every piece of server/model text (file names, transcripts, prompts) is put on the
   page with textContent (via h()), never innerHTML: the transcript is ASR/model
   output and must be treated as untrusted. */

const view = document.getElementById("view");
const nav = document.getElementById("nav");

// ---------- vocabulary ----------
const STAGES = [
  { id: "truncating", label: "Check the video", weight: 2, tau: 5 },
  { id: "frames", label: "Sample frames", weight: 6, tau: 8 },
  { id: "face", label: "Read the face (action units, gaze, head pose)", weight: 30, tau: 45 },
  { id: "finalizing", label: "Draw the annotated frame", weight: 8, tau: 10 },
  { id: "audio", label: "Extract the audio", weight: 4, tau: 6 },
  { id: "transcript", label: "Transcribe the speech", weight: 20, tau: 35 },
  { id: "voice", label: "Measure the voice", weight: 6, tau: 10 },
  { id: "vlm_valence", label: "Ask the model: tone (valence)", weight: 12, tau: 12 },
  { id: "vlm_arousal", label: "Ask the model: energy (arousal)", weight: 12, tau: 12 },
];
// One colour per step for the timing bar (readable on white, distinguishable without relying on red/green alone).
const STAGE_COLORS = {
  truncating: "#8a8f98", frames: "#56b4e9", face: "#0072b2", finalizing: "#cc79a7", audio: "#e69f00",
  transcript: "#009e73", voice: "#7b4fa3", vlm_valence: "#d55e00", vlm_arousal: "#a3283a",
};
const MODALITIES = [
  { id: "AU", name: "AU", hint: "Facial action units: which face muscles move" },
  { id: "T", name: "T", hint: "Transcript: what is said (Whisper)" },
  { id: "VO", name: "VO", hint: "Voice: pitch, loudness, speaking rate (openSMILE)" },
  { id: "ET", name: "ET", hint: "Eye gaze direction" },
  { id: "HT", name: "HT", hint: "Head pose: pitch, yaw, roll" },
];
const PRESETS = [
  { name: "Full (all 5)", set: ["AU", "T", "VO", "ET", "HT"] },
  { name: "Face only (AU)", set: ["AU"] },
  { name: "Face + speech (AU+T)", set: ["AU", "T"] },
];
const QUADS = {
  PA: { name: "Positive · Active", color: "var(--pa)", desc: "A pleasant, energised state", shape: "circle", x: 1, y: 1 },
  NA: { name: "Negative · Active", color: "var(--na)", desc: "An unpleasant, energised state", shape: "triangle", x: 0, y: 1 },
  ND: { name: "Negative · Deactivated", color: "var(--nd)", desc: "An unpleasant, subdued state", shape: "square", x: 0, y: 0 },
  PD: { name: "Positive · Deactivated", color: "var(--pd)", desc: "A pleasant, calm state", shape: "diamond", x: 1, y: 0 },
};
const AU_NAMES = {
  AU01: "Inner brow raiser", AU02: "Outer brow raiser", AU04: "Brow lowerer", AU05: "Upper lid raiser", AU06: "Cheek raiser",
  AU07: "Lid tightener", AU09: "Nose wrinkler", AU10: "Upper lip raiser", AU12: "Lip corner puller", AU14: "Dimpler",
  AU15: "Lip corner depressor", AU17: "Chin raiser", AU20: "Lip stretcher", AU23: "Lip tightener", AU25: "Lips part",
  AU26: "Jaw drop", AU28: "Lip suck", AU45: "Blink",
};
const ACTIVE = ["queued", "running", "uploading"];
const VIDEO_TYPES = /\.(mov|mp4|avi|mkv|webm)$/i;

// ---------- tiny DOM helpers ----------
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") for (const [name, value] of Object.entries(v)) node.style.setProperty(name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), value);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  append(node, kids);
  return node;
}
function append(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}
const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, props, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) if (v != null) node.setAttribute(k, v);
  append(node, kids);
  return node;
}
const fmtSeconds = (x) => (x == null ? "—" : x < 60 ? `${x.toFixed(1)} s` : `${Math.floor(x / 60)}m ${Math.round(x % 60)}s`);
const fmtClock = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const modLabel = (list) => list.join(" + ");

function toast(message, bad) {
  const node = h("div", { class: "toast" + (bad ? " bad" : ""), role: "status" }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 4200);
}

function zoom(src) {
  const overlay = h("div", { class: "zoom", onclick: () => overlay.remove() }, h("img", { src, alt: "Enlarged view" }));
  document.body.append(overlay);
}

// ---------- API ----------
let config = null;

async function api(path, { method = "GET", json, body, headers = {}, raw = false } = {}) {
  const init = { method, credentials: "same-origin", headers: { ...headers } };
  if (method !== "GET") init.headers["X-Requested-With"] = "alani-web";
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path, init);
  if (raw) return res;
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (res.status === 401 && path !== "/api/login") {
    config = null;
    route();
    throw new Error("Please log in");
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---------- routing ----------
let timers = [];
function later(fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; }
function every(fn, ms) { const id = setInterval(fn, ms); timers.push(id); return id; }
function stopTimers() { timers.forEach((t) => { clearTimeout(t); clearInterval(t); }); timers = []; }

let epoch = 0; // bumped by every route(); a page still loading for an older route stops itself

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

async function route() {
  epoch += 1;
  stopTimers();
  view.replaceChildren();
  if (!config) {
    let session;
    try { session = await (await fetch("/api/session", { credentials: "same-origin" })).json(); } catch (_) { session = {}; }
    if (!session.authenticated) return renderLogin();
    try { config = await api("/api/config"); } catch (_) { return renderLogin(); }
  }
  nav.hidden = false;
  document.getElementById("foot-text").textContent =
    `Prediction from ${config.modelName} via OpenRouter, circumplex model (ValAro two-step prompting). Uploads are deleted automatically after ${config.retentionHours} hours unless pinned.`;
  const match = location.hash.match(/^#\/job\/([0-9a-f]{12})$/);
  if (match) return renderJob(match[1]);
  return renderHome();
}
window.addEventListener("hashchange", route);
document.getElementById("logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (_) { /* already logged out */ }
  config = null;
  nav.hidden = true;
  go("#/");
});

// ---------- login ----------
function renderLogin() {
  nav.hidden = true;
  const error = h("div", { class: "form-error", role: "alert" });
  const input = h("input", { type: "password", id: "pw", autocomplete: "current-password", required: true, autofocus: true });
  const button = h("button", { class: "primary", type: "submit" }, "Enter");
  const form = h("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      error.textContent = "";
      try {
        await api("/api/login", { method: "POST", json: { password: input.value } });
        config = null;
        route();
      } catch (e) {
        error.textContent = e.message;
        button.disabled = false;
        input.select();
      }
    },
  }, h("label", { for: "pw" }, "Password"), input, error, h("div", { class: "row", style: { marginTop: ".8rem" } }, button));
  view.append(h("div", { class: "login card" },
    h("h1", null, "Alani Emotion"),
    h("p", { class: "muted" }, "Emotion recognition from video — live thesis demo. Enter the demo password to continue."),
    form));
  input.focus();
}

// ---------- home ----------
const chosen = { file: null, modalities: new Set(MODALITIES.map((m) => m.id)), cacheAll: true, autoRetry: true };

function modalityChips(set, onChange) {
  const wrap = h("div", { class: "chips", role: "group", "aria-label": "Modalities" });
  const refresh = () => wrap.querySelectorAll(".chip").forEach((chip) => chip.setAttribute("aria-pressed", String(set.has(chip.dataset.id))));
  for (const m of MODALITIES) {
    wrap.append(h("button", {
      type: "button", class: "chip", "data-id": m.id, title: m.hint, "aria-pressed": String(set.has(m.id)),
      onclick: () => { set.has(m.id) ? set.delete(m.id) : set.add(m.id); refresh(); onChange && onChange(); },
    }, m.name));
  }
  const presets = h("div", { class: "row", style: { marginTop: ".6rem" } }, h("span", { class: "muted small" }, "Presets:"),
    PRESETS.map((p) => h("button", { type: "button", class: "preset", onclick: () => { set.clear(); p.set.forEach((x) => set.add(x)); refresh(); onChange && onChange(); } }, p.name)));
  return h("div", null, wrap, presets, h("p", { class: "muted small", style: { marginTop: ".5rem" } },
    MODALITIES.map((m) => `${m.name} = ${m.hint}`).join("  ·  ")));
}

function modelBadge(models) {
  const text = { cold: "Models: not loaded yet", warming: "Models: warming up…", ready: "Models: ready", failed: "Models: failed to load" }[models.state] || models.state;
  return h("span", { class: `badge ${models.state}`, title: models.error || "" }, text);
}

async function renderHome() {
  const dropText = h("div", { class: "big" }, "Drop a video here, or click to choose a file");
  const dropSub = h("div", { class: "muted small" }, `.mp4 .mov .avi .mkv .webm — up to ${config.maxUploadMb} MB. On a phone this opens the camera.`);
  const fileInput = h("input", { type: "file", accept: "video/*,.mov,.mp4,.avi,.mkv,.webm", capture: "user", hidden: true });
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", "aria-label": "Choose a video to analyse" }, dropText, dropSub);
  const badgeSlot = h("span");
  const warmButton = h("button", { type: "button", onclick: warmUp }, "Warm up models");
  const startButton = h("button", { class: "primary", type: "button", disabled: true, onclick: startUpload }, "Analyse");
  const progressBar = h("div", { class: "bar live" }, h("span"));
  const progressText = h("p", { class: "muted small" });
  const progressBox = h("div", { hidden: true }, progressBar, progressText);
  const recordSlot = h("div", { class: "record", hidden: true });
  const recordButton = h("button", { type: "button", onclick: openRecorder }, "● Record with camera");
  const canRecord = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder;

  const choose = (file) => {
    if (!file) return;
    if (!VIDEO_TYPES.test(file.name)) return toast("That does not look like a video (.mp4 .mov .avi .mkv .webm)", true);
    if (file.size > config.maxUploadMb * 1048576) return toast(`That file is ${fmtBytes(file.size)}; the limit is ${config.maxUploadMb} MB`, true);
    chosen.file = file;
    dropText.textContent = file.name;
    dropSub.textContent = `${fmtBytes(file.size)} — ready. Pick the modalities below, then press Analyse.`;
    startButton.disabled = false;
  };
  fileInput.addEventListener("change", () => choose(fileInput.files[0]));
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); choose(e.dataTransfer.files[0]); });

  async function warmUp() {
    try { const r = await api("/api/warmup", { method: "POST" }); refreshBadge(r.models); toast(r.started ? "Loading the models in the background" : "Models are already loading or loaded"); pollStatus(); } catch (e) { toast(e.message, true); }
  }
  function refreshBadge(models) { badgeSlot.replaceChildren(modelBadge(models)); warmButton.hidden = models.state === "ready" || models.state === "warming"; }
  function pollStatus() {
    later(async () => {
      try { const st = await api("/api/status"); refreshBadge(st.models); if (st.models.state === "warming") pollStatus(); } catch (_) { /* ignore */ }
    }, 2500);
  }
  refreshBadge(config.models);
  if (config.models.state === "warming") pollStatus();

  function startUpload() {
    if (!chosen.file || chosen.modalities.size === 0) return toast("Choose a video and at least one modality", true);
    startButton.disabled = true;
    progressBox.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Requested-With", "alani-web");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(chosen.file.name));
    xhr.setRequestHeader("X-Modalities", MODALITIES.map((m) => m.id).filter((id) => chosen.modalities.has(id)).join("."));
    xhr.setRequestHeader("X-Cache-Mode", chosen.cacheAll ? "d" : "s");
    xhr.setRequestHeader("X-Auto-Retry", chosen.autoRetry ? "1" : "0");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((100 * e.loaded) / e.total);
      progressBar.firstChild.style.width = pct + "%";
      progressText.textContent = `Uploading ${fmtBytes(e.loaded)} of ${fmtBytes(e.total)} (${pct}%)`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
      if (xhr.status === 201) { chosen.file = null; go(`#/job/${data.jobId}`); return; }
      if (xhr.status === 401) { config = null; return route(); }
      progressBox.hidden = true;
      startButton.disabled = false;
      toast(data.error || `Upload failed (${xhr.status})`, true);
    };
    xhr.onerror = () => { progressBox.hidden = true; startButton.disabled = false; toast("The upload was interrupted — check the connection and try again", true); };
    progressText.textContent = "Starting the upload…";
    xhr.send(chosen.file);
  }

  async function openRecorder() {
    recordSlot.hidden = false;
    recordSlot.replaceChildren(h("p", { class: "muted" }, "Asking for camera and microphone…"));
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }); } catch (e) {
      recordSlot.replaceChildren(h("p", { class: "form-error" }, "Could not open the camera: " + (e.message || e.name)));
      return;
    }
    const preview = h("video", { autoplay: true, muted: true, playsinline: true });
    preview.srcObject = stream;
    const type = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const pieces = [];
    recorder.ondataavailable = (e) => e.data.size && pieces.push(e.data);
    const timer = h("span", { class: "muted" }, "0:00");
    let startedAt = 0;
    const stopStream = () => stream.getTracks().forEach((t) => t.stop());
    const toggle = h("button", { class: "primary", type: "button" }, "● Start recording");
    const cancel = h("button", { type: "button", onclick: () => { stopStream(); recordSlot.hidden = true; } }, "Cancel");
    toggle.addEventListener("click", () => {
      if (recorder.state === "inactive") {
        recorder.start(1000); startedAt = Date.now(); toggle.textContent = "■ Stop"; cancel.hidden = true;
        every(() => { timer.textContent = fmtClock((Date.now() - startedAt) / 1000); }, 500);
      } else recorder.stop();
    });
    recorder.onstop = () => {
      stopStream();
      const mime = recorder.mimeType || "video/webm";
      const blob = new Blob(pieces, { type: mime });
      const file = new File([blob], `recording-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`, { type: mime });
      recordSlot.hidden = true;
      choose(file);
    };
    recordSlot.replaceChildren(preview, h("div", { class: "row", style: { marginTop: ".6rem" } }, toggle, cancel, timer),
      h("p", { class: "muted small" }, "Only the first 2:00 is analysed — 30–60 seconds is plenty."));
  }

  const savedSlot = h("div");
  const recentSlot = h("div");

  view.append(
    h("section", { class: "card" },
      h("div", { class: "row spread" }, h("h1", null, "Analyse a video"), h("div", { class: "row" }, badgeSlot, warmButton)),
      fileInput, drop,
      canRecord ? h("div", { class: "row", style: { marginTop: ".8rem" } }, recordButton, h("span", { class: "muted small" }, "or record straight from this device's camera")) : null,
      recordSlot),
    h("section", { class: "card" },
      h("h2", null, "What should the model use?"),
      modalityChips(chosen.modalities),
      h("label", { class: "row small", style: { marginTop: ".8rem" } },
        h("input", { type: "checkbox", checked: chosen.cacheAll, onchange: (e) => { chosen.cacheAll = e.target.checked; } }),
        "Compute and remember every modality (so re-analysing with other modalities later is fast)"),
      h("label", { class: "row small", style: { marginTop: ".5rem" } },
        h("input", { type: "checkbox", checked: chosen.autoRetry, onchange: (e) => { chosen.autoRetry = e.target.checked; } }),
        "Retry automatically if the model provider is busy (rate-limited) — keeps trying for up to 30 minutes"),
      h("p", { class: "notice", style: { marginTop: ".8rem" } },
        `Only the first ${fmtClock(config.maxClipSeconds)} of a clip is analysed. The first run after the server wakes can take several minutes — press "Warm up models" first if you can.`),
      h("div", { class: "row", style: { marginTop: ".8rem" } }, startButton),
      progressBox),
    savedSlot, recentSlot);

  try {
    const { jobs } = await api("/api/jobs");
    const pinned = jobs.filter((j) => j.pinned);
    if (pinned.length) savedSlot.append(h("section", { class: "card" }, h("h2", null, "Saved demos"), jobList(pinned)));
    const recent = jobs.filter((j) => !j.pinned).slice(0, 12);
    if (recent.length) recentSlot.append(h("section", { class: "card" }, h("h2", null, "Recent runs"), jobList(recent)));
  } catch (_) { /* the list is a convenience */ }
}

function jobList(jobs) {
  return h("ul", { class: "list" }, jobs.map((j) => h("li", null,
    h("a", { href: `#/job/${j.id}` }, j.original_filename),
    h("span", { class: `pill ${j.status}` }, j.status === "done" ? (QUADS[j.short] ? `${QUADS[j.short].name} (${j.short})` : "done") : j.status),
    h("span", { class: "muted small" }, modLabel(j.modalities)),
    h("span", { class: "muted small", style: { marginLeft: "auto" } }, fmtWhen(j.created_at)))));
}

// ---------- job page ----------
async function renderJob(id) {
  const mine = epoch;
  const holder = h("div");
  view.append(holder);
  let progressUi = null;
  let pollStart = Date.now();

  async function load() {
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch (e) {
      if (mine !== epoch) return;
      holder.replaceChildren(h("section", { class: "card" }, h("h1", null, "Run not found"), h("p", { class: "muted" }, "It may have been deleted or expired."), h("a", { class: "button primary", href: "#/" }, "Back")));
      return;
    }
    if (mine !== epoch) return;
    if (ACTIVE.includes(job.status)) {
      if (!progressUi) { progressUi = buildProgress(); holder.replaceChildren(progressUi.root); }
      progressUi.update(job);
      later(load, Date.now() - pollStart > 300000 ? 4000 : 1500);
    } else {
      progressUi = null;
      holder.replaceChildren(job.status === "done" ? resultView(job) : problemView(job));
    }
  }
  await load();
}

// One row per step: done (with its seconds), reused from an earlier run (with the seconds it originally
// took), not needed, running, failed here, or still waiting. Used by the progress page and the failed page.
function stepRows(job) {
  const progress = job.progress || {};
  return STAGES.map((st) => {
    const status = (progress.status || {})[st.id] || "pending";
    const running = job.status === "running" && job.stage === st.id && status === "pending";
    const failed = job.status === "error" && job.stage === st.id && status === "pending";
    const timing = (progress.timings || {})[st.id];
    const reused = (progress.cached || {})[st.id];
    const mark = failed ? "✕" : status === "done" ? "✓" : status === "cached" ? "•" : status === "skipped" ? "–" : "";
    let note = "";
    if (failed) note = "failed here";
    else if (status === "done") note = fmtSeconds(timing);
    else if (status === "cached") note = reused != null ? `reused · took ${fmtSeconds(reused)} earlier` : "already computed";
    else if (status === "skipped") note = "not needed";
    else if (running) note = "working…";
    return h("li", { class: failed ? "failed" : running ? "active" : status }, h("span", { class: "dot" }, mark), st.label, h("span", { class: "time" }, note));
  });
}

function buildProgress() {
  const percent = h("div", { class: "percent" }, "0%");
  const fill = h("span");
  const bar = h("div", { class: "bar live", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  const nowTitle = h("div", { class: "now" }, "Getting ready…");
  const nowText = h("p", { class: "muted" });
  const elapsed = h("span", { class: "muted small" });
  const queueNote = h("p", { class: "notice", hidden: true });
  const steps = h("ul", { class: "steps" });
  const title = h("h1", null, "Analysing…");
  const root = h("section", { class: "card" },
    h("div", { class: "row spread" }, title, elapsed),
    h("div", { class: "row", style: { margin: ".6rem 0" } }, percent, h("span", { class: "muted small" }, "overall progress")),
    bar, queueNote, nowTitle, nowText, steps,
    h("p", { class: "muted small" }, "There is no fixed time estimate: the step times below are what each step actually took. You can leave this page open or come back to it from “Recent runs”."));

  let lastStage = null;
  let stageSince = Date.now();
  let model = { percent: 0, status: {}, stage: "queued", running: false, startedMs: Date.now() };

  function tick() {
    const planned = STAGES.filter((st) => !["cached", "skipped"].includes(model.status[st.id]));
    const total = planned.reduce((n, st) => n + st.weight, 0) || 1;
    const active = STAGES.find((st) => st.id === model.stage);
    let value = model.percent;
    if (model.running && active) {
      const share = (100 * active.weight) / total;
      value += share * 0.92 * (1 - Math.exp(-(Date.now() - stageSince) / 1000 / active.tau));
    }
    value = Math.min(99, value);
    fill.style.width = value.toFixed(1) + "%";
    bar.setAttribute("aria-valuenow", String(Math.round(value)));
    percent.textContent = Math.round(value) + "%";
    elapsed.textContent = "Elapsed " + fmtSeconds((Date.now() - model.startedMs) / 1000);
  }
  every(tick, 250);

  function update(job) {
    if (job.stage !== lastStage) { lastStage = job.stage; stageSince = Date.now(); }
    model = { percent: job.progress.percent || 0, status: job.progress.status || {}, stage: job.stage, running: job.status === "running", startedMs: Date.parse(job.started_at || job.created_at) };
    title.textContent = job.original_filename;
    const waiting = job.status === "queued" && job.queue_position > 0;
    queueNote.hidden = !(job.status === "queued");
    queueNote.textContent = waiting ? `Waiting in line — ${job.queue_position} analysis${job.queue_position === 1 ? "" : "es"} ahead of this one.` : "Starting — waiting for the server to pick this up.";
    const active = STAGES.find((st) => st.id === job.stage);
    nowTitle.textContent = job.status === "queued" ? "Waiting for its turn" : (active ? active.label : "Working");
    nowText.textContent = job.stage_detail || "";
    steps.replaceChildren(...stepRows(job));
    tick();
  }
  return { root, update };
}

function problemView(job) {
  const interrupted = job.status === "interrupted";
  const retryBox = h("input", { type: "checkbox", checked: job.auto_retry !== false });
  return h("section", { class: "card" },
    h("h1", null, interrupted ? "This analysis was interrupted" : "The analysis failed"),
    h("p", null, h("b", null, job.original_filename), " ", h("span", { class: `pill ${job.status}` }, job.status)),
    h("p", { class: "form-error", role: "alert" }, job.error || "Something went wrong."),
    h("p", { class: "muted small" }, "Steps that finished before the failure are kept: a re-run reuses them and shows how long they took."),
    h("ul", { class: "steps" }, stepRows(job)),
    h("label", { class: "row small", style: { marginTop: ".8rem" } }, retryBox, "Retry automatically if the model provider is busy (rate-limited)"),
    h("div", { class: "row", style: { marginTop: ".8rem" } },
      h("button", { class: "primary", type: "button", onclick: () => rerun(job.id, job.modalities, retryBox.checked) }, "Re-run"),
      h("button", { class: "danger", type: "button", onclick: () => removeJob(job.id) }, "Delete"),
      h("a", { class: "button", href: "#/" }, "Back")));
}

async function rerun(id, modalities, autoRetry) {
  try { const r = await api(`/api/jobs/${id}/rerun`, { method: "POST", json: { modalities, autoRetry } }); go(`#/job/${r.jobId}`); } catch (e) { toast(e.message, true); }
}
async function removeJob(id) {
  if (!confirm("Delete this run and its uploaded video?")) return;
  try { await api(`/api/jobs/${id}`, { method: "DELETE" }); toast("Deleted"); go("#/"); } catch (e) { toast(e.message, true); }
}

// ---------- results ----------
function shapeIcon(shape, color, size = 74) {
  const c = size / 2;
  const fill = { fill: color, stroke: "none" };
  const node = { circle: () => s("circle", { cx: c, cy: c, r: c * 0.8, ...fill }), square: () => s("rect", { x: c * 0.25, y: c * 0.25, width: c * 1.5, height: c * 1.5, rx: 8, ...fill }),
    triangle: () => s("polygon", { points: `${c},${c * 0.15} ${c * 1.85},${c * 1.8} ${c * 0.15},${c * 1.8}`, ...fill }), diamond: () => s("polygon", { points: `${c},${c * 0.1} ${c * 1.9},${c} ${c},${c * 1.9} ${c * 0.1},${c}`, ...fill }) }[shape]();
  return s("svg", { viewBox: `0 0 ${size} ${size}`, "aria-hidden": "true" }, node);
}

function circumplex(short) {
  const size = 360, pad = 30, half = (size - pad * 2) / 2;
  const svg = s("svg", { class: "circumplex", viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": `Circumplex model: predicted quadrant ${QUADS[short].name}` });
  for (const [code, q] of Object.entries(QUADS)) {
    const x = pad + q.x * half, y = pad + (1 - q.y) * half;
    const on = code === short;
    svg.append(s("rect", { x, y, width: half, height: half, fill: on ? q.color : "#fff", "fill-opacity": on ? 0.16 : 1, stroke: "#ece3dc" }));
    svg.append(s("text", { x: x + half / 2, y: y + 24, "text-anchor": "middle", "font-size": 13, "font-weight": on ? 800 : 600, fill: on ? q.color : "#7a6d65" }, q.name));
    svg.append(s("text", { x: x + half / 2, y: y + 42, "text-anchor": "middle", "font-size": 11, fill: "#7a6d65" }, code));
  }
  svg.append(s("line", { x1: pad, y1: size / 2, x2: size - pad, y2: size / 2, stroke: "#bdaea3", "stroke-width": 1.5 }));
  svg.append(s("line", { x1: size / 2, y1: pad, x2: size / 2, y2: size - pad, stroke: "#bdaea3", "stroke-width": 1.5 }));
  const q = QUADS[short];
  const cx = pad + q.x * half + half / 2, cy = pad + (1 - q.y) * half + half / 2 + 8;
  const mark = shapeIcon(q.shape, q.color, 40);
  mark.setAttribute("x", cx - 20); mark.setAttribute("y", cy - 20); mark.setAttribute("width", 40); mark.setAttribute("height", 40);
  svg.append(mark);
  svg.append(s("text", { x: size / 2, y: size - 8, "text-anchor": "middle", "font-size": 12, fill: "#7a6d65" }, "Valence: negative  ←  →  positive"));
  svg.append(s("text", { x: 12, y: size / 2, "text-anchor": "middle", "font-size": 12, fill: "#7a6d65", transform: `rotate(-90 12 ${size / 2})` }, "Arousal: deactivated  ←  →  active"));
  return svg;
}

function dial(label, degrees, range) {
  const v = Math.max(-range, Math.min(range, degrees));
  const angle = (v / range) * 90 * (Math.PI / 180);
  const nx = 60 + 44 * Math.sin(angle), ny = 64 - 44 * Math.cos(angle);
  return h("div", { class: "dial" },
    s("svg", { viewBox: "0 0 120 76", "aria-hidden": "true" },
      s("path", { d: "M 10 64 A 50 50 0 0 1 110 64", fill: "none", stroke: "#f3d3bd", "stroke-width": 8, "stroke-linecap": "round" }),
      s("line", { x1: 60, y1: 64, x2: 60, y2: 18, stroke: "#ece3dc", "stroke-width": 1.5 }),
      s("line", { x1: 60, y1: 64, x2: nx, y2: ny, stroke: "#da8552", "stroke-width": 4, "stroke-linecap": "round" }),
      s("circle", { cx: 60, cy: 64, r: 5, fill: "#a85a2c" })),
    h("b", null, `${degrees >= 0 ? "+" : ""}${degrees.toFixed(1)}°`), label);
}
const deg = (rad) => (rad * 180) / Math.PI;

function card(title, ...kids) { return h("section", { class: "card" }, h("h2", null, title), ...kids); }

function resultView(job) {
  const r = job.result;
  const q = QUADS[r.short] || { name: r.prediction, color: "var(--accent)", desc: "", shape: "circle" };
  const base = `/api/jobs/${job.id}/media/`;
  const root = h("div");

  root.append(h("section", { class: "card hero", style: { "--q": q.color } },
    shapeIcon(q.shape, q.color),
    h("div", null,
      h("div", { class: "label" }, q.name, h("span", { class: "code" }, r.short)),
      h("p", { class: "muted" }, `${q.desc}. Quadrant prediction (binary valence × binary arousal) from ${modLabel(r.modalities_used)}.`),
      h("p", { class: "small muted" }, `${job.original_filename} · analysed in ${fmtSeconds(r.total_seconds)} · ${r.frame_count} frames`),
      r.truncated ? h("p", { class: "notice" }, `Only the first ${fmtClock(r.clip_seconds)} of your ${fmtClock(r.full_seconds)} clip was analysed.`) : null)));

  const photo = r.has_annotated ? "annotated.png" : "first_frame.jpg";
  const mainImage = h("img", { class: "annot", src: base + photo, alt: "The analysed frame with face landmarks and action-unit bars", onclick: () => zoom(base + photo) });
  const strip = h("div", { class: "strip" }, (r.frames || []).map((name) => h("img", { src: base + "frames/" + name, alt: "Sampled frame", loading: "lazy", onclick: () => zoom(base + "frames/" + name) })));
  root.append(h("div", { class: "grid2" },
    card("Circumplex", circumplex(r.short), h("p", { class: "muted small" }, "Quadrant prediction (binary valence × binary arousal). The model gives a quadrant, not a score.")),
    card(r.has_annotated ? "Annotated frame" : "First frame", mainImage, strip)));

  // action units
  const aus = Object.entries(r.au_values || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const auCard = card("Facial action units",
    aus.length ? h("div", { class: "bars" }, aus.map(([id, v]) => h("div", { class: "bar-row" },
      h("span", null, `${id} ${AU_NAMES[id] || ""}`), h("div", { class: "track" }, h("div", { class: "fill", style: { width: Math.min(100, (v / 5) * 100) + "%" } })), h("span", { class: "val" }, v.toFixed(2)))))
      : h("p", { class: "muted" }, "No action-unit data for this run."),
    h("p", { class: "muted small" }, "Intensity on a 0–5 scale, averaged over the sampled frames; the strongest eight are shown."));
  const pose = r.pose_features || {};
  const dials = [];
  if (pose.head_yaw_mean != null) dials.push(dial("Head yaw (left / right)", deg(pose.head_yaw_mean), 45));
  if (pose.head_pitch_mean != null) dials.push(dial("Head pitch (down / up)", deg(pose.head_pitch_mean), 45));
  if (pose.head_roll_mean != null) dials.push(dial("Head roll (tilt)", deg(pose.head_roll_mean), 45));
  if (pose.gaze_x_mean != null) dials.push(dial("Gaze horizontal", deg(pose.gaze_x_mean), 45));
  if (pose.gaze_y_mean != null) dials.push(dial("Gaze vertical", deg(pose.gaze_y_mean), 45));
  const poseCard = card("Gaze and head pose",
    dials.length ? h("div", { class: "dials" }, dials) : h("p", { class: "muted" }, "No gaze or head-pose data for this run."),
    r.head_string ? h("pre", { class: "text" }, r.head_string) : null, r.eye_string ? h("pre", { class: "text" }, r.eye_string) : null);
  root.append(h("div", { class: "grid2" }, auCard, poseCard));

  const hasT = r.modalities_used.includes("T");
  const hasVO = r.modalities_used.includes("VO");
  root.append(h("div", { class: "grid2" },
    card("Transcript", r.transcript ? h("blockquote", { class: "quote" }, r.transcript) : h("p", { class: "muted" }, hasT ? "No speech was detected." : "Transcript was not used in this run."),
      h("p", { class: "muted small" }, "Machine transcription — it can be wrong; the model is told to disregard it if it is garbled.")),
    card("Voice", r.voice_string ? h("pre", { class: "text" }, r.voice_string) : h("p", { class: "muted" }, hasVO ? "No usable audio was found." : "Voice features were not used in this run."))));

  root.append(h("section", { class: "card" }, h("h2", null, "What the model saw"),
    h("p", { class: "muted small" }, "Two questions, asked one after the other with the sampled frames attached. The answer to the first is given to the second."),
    h("details", null, h("summary", null, `1 · Valence prompt → “${r.valence_raw}”`), h("pre", { class: "text" }, r.valence_prompt)),
    h("details", null, h("summary", null, `2 · Arousal prompt → “${r.arousal_raw}”`), h("pre", { class: "text" }, r.arousal_prompt))));

  // timings: this run's steps, plus the steps reused from earlier runs of the clip (hatched) with the seconds they took then
  const reusedSeconds = r.stage_cached_seconds || {};
  const segments = STAGES.map((st) => {
    const own = r.stage_timings[st.id];
    const sec = own != null ? own : reusedSeconds[st.id];
    return sec == null ? null : { st, sec, reused: own == null, color: STAGE_COLORS[st.id] };
  }).filter(Boolean);
  const sum = segments.reduce((n, x) => n + x.sec, 0) || 1;
  const reusedTotal = segments.filter((x) => x.reused).reduce((n, x) => n + x.sec, 0);
  root.append(card("Timing",
    h("div", { class: "stack-bar", role: "img", "aria-label": "Time spent per step" }, segments.map((x) =>
      h("div", { class: x.reused ? "reused" : "", title: `${x.st.label}: ${fmtSeconds(x.sec)}${x.reused ? " (reused from an earlier run)" : ""}`, style: { width: (100 * x.sec) / sum + "%", backgroundColor: x.color } }))),
    h("ul", { class: "legend" }, segments.map((x) => h("li", null,
      h("i", { class: x.reused ? "reused" : "", style: { backgroundColor: x.color } }), h("span", null, x.st.label), h("b", null, fmtSeconds(x.sec)), x.reused ? h("em", null, "earlier run") : null))),
    h("p", { class: "small" }, h("b", null, `This run: ${fmtSeconds(r.total_seconds)}`),
      reusedTotal > 0 ? ` · steps reused from earlier runs of this clip took ${fmtSeconds(reusedTotal)} · everything together ≈ ${fmtSeconds(sum)}` : ""),
    reusedTotal > 0 ? h("p", { class: "muted small" }, "Hatched segments were not repeated: their time is what they took when they were first computed.") : null));

  // re-analyse + runs
  const set = new Set(job.modalities);
  const retryAgain = h("input", { type: "checkbox", checked: job.auto_retry !== false });
  const rerunButton = h("button", { class: "primary", type: "button", onclick: () => set.size ? rerun(job.id, [...set], retryAgain.checked) : toast("Pick at least one modality", true) }, "Re-analyse");
  root.append(card("Try other modalities",
    h("p", { class: "muted small" }, "Run the same clip again with a different set. Anything already computed is reused, so this is usually fast."),
    modalityChips(set),
    h("label", { class: "row small", style: { marginTop: ".8rem" } }, retryAgain, "Retry automatically if the model provider is busy (rate-limited)"),
    h("div", { class: "row", style: { marginTop: ".8rem" } }, rerunButton),
    job.runs.length > 1 ? h("table", { style: { marginTop: "1rem" } },
      h("thead", null, h("tr", null, ["Modalities", "Prediction", "Time", "Status"].map((t) => h("th", null, t)))),
      h("tbody", null, job.runs.map((run) => h("tr", { class: run.id === job.id ? "current" : "" },
        h("td", null, h("a", { href: `#/job/${run.id}` }, modLabel(run.modalities))),
        h("td", null, run.short ? `${QUADS[run.short] ? QUADS[run.short].name : run.prediction} (${run.short})` : "—"),
        h("td", null, fmtSeconds(run.total_seconds), run.reused_seconds ? h("span", { class: "muted small" }, ` + ${fmtSeconds(run.reused_seconds)} reused`) : null), h("td", null, run.status))))) : null));

  // actions
  const saveButton = h("button", { type: "button", onclick: save }, job.saved ? "Saved to Discord ✓ (send again)" : "Save to Discord");
  async function save() {
    saveButton.disabled = true;
    try { await api(`/api/jobs/${job.id}/save`, { method: "POST" }); toast("Sent to the Discord channel"); saveButton.textContent = "Saved to Discord ✓ (send again)"; } catch (e) { toast(e.message, true); }
    saveButton.disabled = false;
  }
  const pinButton = h("button", { type: "button", onclick: async () => {
    try { await api(`/api/jobs/${job.id}/pin`, { method: "POST", json: { pinned: !job.pinned } }); job.pinned = !job.pinned; pinButton.textContent = job.pinned ? "Unpin demo" : "Pin as demo"; toast(job.pinned ? "Pinned — it will not be deleted automatically" : "Unpinned"); } catch (e) { toast(e.message, true); }
  } }, job.pinned ? "Unpin demo" : "Pin as demo");
  const jsonButton = h("button", { type: "button", onclick: () => {
    const blob = new Blob([JSON.stringify({ file: job.original_filename, created_at: job.created_at, modalities: job.modalities, result: r }, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `emotion-${job.id}.json` }); a.click(); URL.revokeObjectURL(a.href);
  } }, "Download result (JSON)");
  const videoBox = h("details", { ontoggle: (e) => { if (e.target.open && !e.target.querySelector("video")) e.target.append(h("video", { controls: true, preload: "metadata", src: base + "input", style: { width: "100%", marginTop: ".6rem", borderRadius: "12px" } })); } },
    h("summary", null, "Play the uploaded clip"));
  root.append(card("Keep or share",
    h("div", { class: "row no-print" }, saveButton, pinButton, jsonButton,
      r.has_annotated ? h("a", { class: "button", href: base + "annotated.png", download: `annotated-${job.id}.png` }, "Download annotated frame") : null,
      h("button", { type: "button", onclick: () => window.print() }, "Print"),
      h("button", { class: "danger", type: "button", onclick: () => removeJob(job.id) }, "Delete this run")),
    h("p", { class: "muted small" }, "“Save to Discord” posts the image, prediction, modalities, timings, transcript and prompts to the emotion channel."), videoBox));
  return root;
}

route();
