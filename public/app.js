const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const SOON_MS = 30 * 60 * 1000;
const LOCAL_KEY = "fiba3x3_schedule_v1";

const state = {
  items: [],
  offsetMs: 0,
  storageMode: "remote",
  editingId: null,
};

function serverNow() {
  return new Date(Date.now() + state.offsetMs);
}

function parseLocal(iso) {
  return new Date(iso);
}

function loadLocalSaved() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLocalItems(items) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
  } catch {
    toast("無法儲存到此瀏覽器", true);
  }
}

async function loadLocalItems() {
  const saved = loadLocalSaved();
  if (Array.isArray(saved) && saved.length) return saved;
  try {
    const res = await fetch("schedule-static.json");
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data) ? data : data.items || [];
      saveLocalItems(items);
      return items;
    }
  } catch {
    // 沒有靜態資料時從空表開始
  }
  return [];
}

function nextLetterClient(used) {
  const usedSet = new Set(used);
  let i = 0;
  while (true) {
    const candidate = i < 26
      ? String.fromCharCode(97 + i)
      : "a" + String.fromCharCode(97 + (i - 26));
    if (!usedSet.has(candidate)) return candidate;
    i += 1;
  }
}

function makeLocalItem(letter, dateStr, timeStr, event, region, operation,
                       description, endTime, endDate, relation, tool) {
  const iso = (d, t) => `${d}T${t}:00+08:00`;
  return {
    id: `local-${letter}`,
    letter,
    date: dateStr,
    time: timeStr,
    datetime: iso(dateStr, timeStr),
    event,
    region,
    operation,
    description,
    end_time: endTime,
    end_date: endDate,
    end_datetime: endTime && endDate ? iso(endDate, endTime) : null,
    relation,
    tool,
    source: "local",
  };
}

function addLocalPair(items, payload) {
  const used = items.map((i) => i.letter);
  const startLetter = nextLetterClient(used);
  used.push(startLetter);
  const endLetter = nextLetterClient(used);

  const [sh, sm] = payload.time.split(":").map(Number);
  const [eh, em] = payload.end_time.split(":").map(Number);
  let endDate = payload.date;
  if (eh * 60 + em <= sh * 60 + sm) {
    const d = new Date(`${payload.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }

  const isLive = payload.operation === "直播";
  const startOp = isLive ? "Live" : "開始錄影";
  const endOp = isLive ? "End Live" : "停止錄影";
  const start = makeLocalItem(
    startLetter, payload.date, payload.time, payload.event, payload.region,
    startOp, payload.description, payload.end_time, endDate, endLetter, payload.tool,
  );
  const end = makeLocalItem(
    endLetter, endDate, payload.end_time, payload.event, payload.region,
    endOp, payload.description, null, null, null, payload.tool,
  );
  return [start, end];
}

function updateLocalItem(items, payload) {
  const item = items.find((i) => i.id === payload.id);
  if (!item) return [];
  const iso = (d, t) => `${d}T${t}:00+08:00`;
  const pairStart = !!item.end_time;
  const newRelation = payload.relation || null;
  const relationChanged = newRelation !== (item.relation || null);
  const target = newRelation
    ? items.find((x) => x.letter === newRelation) || null
    : null;

  let endTime = pairStart ? payload.end_time : null;
  let endDate = null;
  if (endTime) {
    endDate = payload.date;
    const [sh, sm] = payload.time.split(":").map(Number);
    const [eh, em] = payload.end_time.split(":").map(Number);
    if (eh * 60 + em <= sh * 60 + sm) {
      const d = new Date(`${payload.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      endDate = d.toISOString().slice(0, 10);
    }
  }

  item.date = payload.date;
  item.time = payload.time;
  item.datetime = iso(payload.date, payload.time);
  item.event = payload.event;
  item.region = payload.region;
  item.description = payload.description;
  item.tool = payload.tool;
  item.relation = newRelation;
  item.end_time = endTime;
  item.end_date = endDate;
  item.end_datetime = endTime && endDate ? iso(endDate, endTime) : null;

  if (pairStart && payload.operation === "直播" && item.operation !== "Live") {
    item.operation = "Live";
    if (target && !relationChanged) target.operation = "End Live";
  } else if (pairStart && payload.operation === "開始錄影" && item.operation !== "開始錄影") {
    item.operation = "開始錄影";
    if (target && !relationChanged) target.operation = "停止錄影";
  }

  if (target && endTime && !relationChanged) {
    target.date = endDate;
    target.time = endTime;
    target.datetime = iso(endDate, endTime);
    target.event = payload.event;
    target.region = payload.region;
    target.description = payload.description;
    target.tool = payload.tool;
  }

  return [item, target].filter(Boolean);
}

function updateModeChip() {
  const chip = document.getElementById("mode-chip");
  if (!chip) return;
  chip.hidden = state.storageMode !== "local";
  chip.textContent = "網頁版 · 此瀏覽器儲存";
}

function makeEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function fmtClock(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const week = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${d} ${MONTHS[m - 1]} ${y} 週${WEEKDAYS[week]}`;
}

function hkDateString(now) {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function durationText(startIso, endIso) {
  const diff = parseLocal(endIso).getTime() - parseLocal(startIso).getTime();
  const mins = Math.max(0, Math.round(diff / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function itemStatus(item) {
  const now = serverNow().getTime();
  const start = parseLocal(item.datetime).getTime();
  const end = item.end_datetime ? parseLocal(item.end_datetime).getTime() : null;
  if (end !== null && now >= start && now <= end) return "active";
  if (now >= start) return "past";
  if (start - now <= SOON_MS) return "soon";
  return "future";
}

function opClass(op) {
  if (op === "開始錄影") return "op-start";
  if (op === "停止錄影") return "op-stop";
  if (op === "Live") return "op-live";
  if (op === "End Live") return "op-endlive";
  return "op-action";
}

function toolClass(tool) {
  if (tool === "obs-1") return "tool-obs1";
  if (tool === "obs-2") return "tool-obs2";
  if (tool === "vMix") return "tool-vmix";
  return "";
}

function railColor(tool) {
  if (tool === "obs-1") return "#2563eb";
  if (tool === "obs-2") return "#0d9488";
  if (tool === "vMix") return "#d97706";
  return "#64748b";
}

function buildRow(item) {
  const row = makeEl("div", "row");
  row.dataset.id = item.id;
  row.dataset.dt = item.datetime;

  const timeCell = makeEl("div", "time-cell");
  timeCell.appendChild(makeEl("span", "row-id", item.letter));
  const stack = makeEl("span", "time-stack");
  stack.appendChild(makeEl("span", "time-main", item.time));
  stack.appendChild(makeEl("span", "state-tag"));
  timeCell.appendChild(stack);

  const eventBadge = makeEl("span", "event-badge", item.event || "—");
  const regionCell = makeEl("span", "region", item.region || "—");
  const opBadge = makeEl("span", `op-badge ${opClass(item.operation)}`, item.operation || "—");

  const desc = makeEl("span", "desc", item.description || "—");

  const endCell = makeEl("span", "end-cell");
  if (item.end_time) {
    endCell.appendChild(document.createTextNode(item.end_time));
    const note = makeEl("span", "end-note", durationText(item.datetime, item.end_datetime));
    endCell.appendChild(note);
  } else {
    endCell.textContent = "—";
  }

  const relCell = makeEl("span", "rel-link");
  if (item.relation) {
    relCell.appendChild(makeEl("span", "rel-arrow", "→"));
    relCell.appendChild(document.createTextNode(` ${item.relation}`));
  } else {
    relCell.textContent = "—";
  }

  const toolBadge = item.tool
    ? makeEl("span", `tool-badge ${toolClass(item.tool)}`, item.tool)
    : makeEl("span", "tool-badge", "—");

  const edit = makeEl("button", "edit-btn", "編輯");
  edit.type = "button";
  edit.title = "編輯";

  const del = makeEl("button", "delete-btn", "✕");
  del.type = "button";
  del.title = "刪除";

  const actions = makeEl("div", "row-actions");
  actions.append(edit, del);

  row.append(timeCell, eventBadge, regionCell, opBadge, desc, endCell, relCell, toolBadge, actions);
  return row;
}

function render() {
  const body = document.getElementById("schedule-body");
  const rail = document.getElementById("rail");
  body.innerHTML = "";

  const sorted = [...state.items].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const relationCount = sorted.filter((i) => i.relation).length;
  const railW = relationCount ? Math.min(180, 12 + relationCount * 14) : 0;
  document.documentElement.style.setProperty("--rail-w", `${railW}px`);
  if (rail) {
    rail.style.display = relationCount ? "" : "none";
    rail.style.width = `${railW}px`;
  }

  const groups = new Map();
  for (const item of sorted) {
    if (!groups.has(item.date)) groups.set(item.date, []);
    groups.get(item.date).push(item);
  }

  const today = hkDateString(serverNow());
  groups.forEach((rows, date) => {
    const head = makeEl("div", "date-head");
    head.appendChild(makeEl("span", "date-label", dateLabel(date)));
    const count = makeEl("span", "date-count", `${rows.length} 列`);
    head.appendChild(count);
    if (date === today) head.appendChild(makeEl("span", "today-chip", "今日"));
    body.appendChild(head);
    rows.forEach((item) => body.appendChild(buildRow(item)));
  });

  updateStatuses();
  renderNextAction();
  drawRail();
}

function updateStatuses() {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  document.querySelectorAll(".row").forEach((row) => {
    const item = byId.get(row.dataset.id);
    if (!item) return;
    const status = itemStatus(item);
    row.classList.toggle("is-past", status === "past");
    row.classList.toggle("is-soon", status === "soon");
    row.classList.toggle("is-active", status === "active");
    const tag = row.querySelector(".state-tag");
    if (tag) {
      tag.textContent =
        status === "soon" ? "30 分鐘內" : status === "active" ? "進行中" : status === "past" ? "已過" : "";
    }
  });
}

function renderNextAction() {
  const el = document.getElementById("next-action");
  if (!el) return;
  const soon = state.items
    .filter((i) => itemStatus(i) === "soon")
    .sort((a, b) => a.datetime.localeCompare(b.datetime))[0];
  if (soon) {
    const tool = soon.tool ? ` · ${soon.tool}` : "";
    el.textContent = `下一步 ${soon.time} ${soon.operation}${tool}`;
    return;
  }
  const active = state.items
    .filter((i) => itemStatus(i) === "active")
    .sort((a, b) => a.datetime.localeCompare(b.datetime))[0];
  if (active) {
    el.textContent = `進行中 ${active.time} ${active.operation} · ${active.tool || "—"}`;
    return;
  }
  el.textContent = "30 分鐘內沒有操作";
}

function drawRail() {
  const rail = document.getElementById("rail");
  const body = document.getElementById("schedule-body");
  if (!rail || !body) return;
  rail.innerHTML = "";

  const relations = state.items
    .filter((i) => i.relation)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  if (!relations.length) return;

  const svgNS = "http://www.w3.org/2000/svg";
  const laneW = 14;
  const padX = 6;
  const railW = Math.min(180, 12 + relations.length * laneW);
  document.documentElement.style.setProperty("--rail-w", `${railW}px`);
  rail.style.width = `${railW}px`;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", railW);
  svg.setAttribute("height", body.offsetHeight);
  rail.appendChild(svg);

  const rowEls = new Map();
  document.querySelectorAll(".row").forEach((r) => rowEls.set(r.dataset.id, r));

  relations.forEach((item, idx) => {
    const startEl = rowEls.get(item.id);
    const target = state.items.find((i) => i.letter === item.relation);
    const endEl = target ? rowEls.get(target.id) : null;
    if (!startEl || !endEl) return;

    const y1 = startEl.offsetTop + startEl.offsetHeight / 2;
    const y2 = endEl.offsetTop + endEl.offsetHeight / 2;
    const x = padX + idx * laneW + laneW / 2;
    const color = railColor(item.tool);

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", x);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", 2);
    svg.appendChild(line);

    for (const cy of [y1, y2]) {
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", 3.5);
      dot.setAttribute("fill", color);
      dot.setAttribute("stroke", "#fff");
      dot.setAttribute("stroke-width", 1.5);
      svg.appendChild(dot);
    }

    const arrow = document.createElementNS(svgNS, "polygon");
    arrow.setAttribute("points", `${x - 4},${y2 - 7} ${x + 4},${y2 - 7} ${x},${y2 - 1}`);
    arrow.setAttribute("fill", color);
    svg.appendChild(arrow);

    const midY = (y1 + y2) / 2;
    const label = document.createElementNS(svgNS, "g");
    label.setAttribute("transform", `translate(${x}, ${midY})`);
    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", 0);
    text.setAttribute("y", 4);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", 11);
    text.setAttribute("font-weight", 700);
    text.setAttribute("fill", color);
    text.setAttribute("stroke", "#fff");
    text.setAttribute("stroke-width", 3);
    text.setAttribute("paint-order", "stroke");
    text.textContent = item.relation;
    label.appendChild(text);
    svg.appendChild(label);
  });
}

function updateDuration() {
  const start = document.getElementById("field-time").value;
  const end = document.getElementById("field-end").value;
  const label = document.getElementById("duration-label");
  if (!start || !end) {
    label.textContent = "--";
    return;
  }
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  label.textContent = `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function updatePreview() {
  const time = document.getElementById("field-time").value || "--:--";
  const end = document.getElementById("field-end").value || "--:--";
  const operation = document.getElementById("field-operation").value;
  const event = document.getElementById("field-event").value;
  const region = document.getElementById("field-region").value.trim();
  const tool = document.getElementById("field-tool").value;
  const startOp = operation === "直播" ? "Live" : "開始錄影";
  const endOp = operation === "直播" ? "End Live" : "停止錄影";
  const meta = [event, region, tool].filter(Boolean).join(" · ");
  const suffix = meta ? ` · ${meta}` : "";

  document.getElementById("preview-start-time").textContent = time;
  document.getElementById("preview-start-op").textContent = startOp + suffix;
  document.getElementById("preview-end-time").textContent = end;
  document.getElementById("preview-end-op").textContent = endOp + suffix;
}

function refreshRegionSuggestions() {
  const regions = [...new Set(state.items.map((i) => i.region).filter(Boolean))];
  const dl = document.getElementById("region-suggestions");
  dl.innerHTML = "";
  regions.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r;
    dl.appendChild(opt);
  });
}

function setFormMode(mode, item) {
  state.editingId = mode === "edit" && item ? item.id : null;
  const startLike = !!(item && item.end_time);
  const relationInput = document.getElementById("field-relation");
  document.getElementById("form-title").textContent = mode === "edit" ? "編輯時間段" : "新增時間段";
  document.getElementById("submit-btn").textContent = mode === "edit" ? "更新" : "完成";
  document.getElementById("field-end").disabled = mode === "edit" && !startLike;
  relationInput.disabled = mode !== "edit";
  relationInput.placeholder = mode === "edit" ? "例如 c" : "完成時自動產生";
}

function resetForm() {
  document.getElementById("entry-form").reset();
  document.getElementById("field-date").value = "2026-08-22";
  document.getElementById("field-event").value = "Challenger";
  document.getElementById("field-operation").value = "開始錄影";
  document.getElementById("field-tool").value = "obs-1";
  setFormMode("add");
  updateDuration();
  updatePreview();
}

function startEdit(item) {
  document.getElementById("field-date").value = item.date;
  document.getElementById("field-time").value = item.time;
  document.getElementById("field-event").value = item.event || "Challenger";
  document.getElementById("field-region").value = item.region || "";
  document.getElementById("field-description").value = item.description || "";
  document.getElementById("field-end").value = item.end_time || "";
  document.getElementById("field-tool").value = item.tool && ["obs-1", "obs-2", "vMix"].includes(item.tool)
    ? item.tool
    : "obs-1";
  document.getElementById("field-relation").value = item.relation || "";
  const isLive = item.operation === "Live" || item.operation === "End Live";
  document.getElementById("field-operation").value = isLive ? "直播" : "開始錄影";
  setFormMode("edit", item);
  updateDuration();
  updatePreview();
  document.querySelector(".form-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

async function loadSchedule() {
  let remote = null;
  try {
    const res = await fetch("api/schedule");
    if (res.ok) remote = await res.json();
  } catch {
    // 後端不存在時使用網頁版模式
  }
  if (remote && Array.isArray(remote.items)) {
    state.storageMode = "remote";
    state.items = remote.items;
    state.offsetMs = parseLocal(remote.now).getTime() - Date.now();
  } else {
    state.storageMode = "local";
    state.items = await loadLocalItems();
    state.offsetMs = 0;
  }
  refreshRegionSuggestions();
  render();
  updateModeChip();
}

function bindFormEvents() {
  const form = document.getElementById("entry-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      id: state.editingId,
      date: document.getElementById("field-date").value,
      time: document.getElementById("field-time").value,
      event: document.getElementById("field-event").value,
      region: document.getElementById("field-region").value.trim(),
      operation: document.getElementById("field-operation").value,
      description: document.getElementById("field-description").value.trim(),
      end_time: document.getElementById("field-end").value,
      tool: document.getElementById("field-tool").value,
      relation: document.getElementById("field-relation").value.trim(),
    };
    if (!payload.time || !payload.region) {
      toast("請填寫所有欄位", true);
      return;
    }
    const editing = Boolean(state.editingId);
    const editingItem = editing
      ? state.items.find((i) => i.id === state.editingId)
      : null;
    if (editing) {
      const rel = payload.relation;
      if (rel && rel === editingItem.letter) {
        toast("關聯不能指向自己", true);
        return;
      }
      if (rel && !state.items.some((i) => i.id !== editingItem.id && i.letter === rel)) {
        toast("找不到關聯的字母", true);
        return;
      }
    }
    const startLike = !!(editingItem && editingItem.end_time);
    if (!editing || startLike) {
      if (!payload.end_time) {
        toast("請填寫所有欄位", true);
        return;
      }
      if (payload.time === payload.end_time) {
        toast("結束時間不能與開始時間相同", true);
        return;
      }
    }
    try {
      if (editing) {
        if (state.storageMode === "local") {
          updateLocalItem(state.items, payload);
          state.items.sort((a, b) => a.datetime.localeCompare(b.datetime));
          saveLocalItems(state.items);
          await loadSchedule();
          resetForm();
          toast("已更新（已儲存到此瀏覽器）");
        } else {
          const res = await fetch(`api/schedule?id=${encodeURIComponent(state.editingId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "更新失敗");
          await loadSchedule();
          resetForm();
          toast("已更新");
        }
      } else if (state.storageMode === "local") {
        const pair = addLocalPair(state.items, payload);
        state.items = [...state.items, ...pair].sort((a, b) =>
          a.datetime.localeCompare(b.datetime),
        );
        saveLocalItems(state.items);
        await loadSchedule();
        resetForm();
        toast("已新增 2 個時間段（已儲存到此瀏覽器）");
      } else {
        const res = await fetch("api/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "新增失敗");
        await loadSchedule();
        resetForm();
        toast("已新增 2 個時間段");
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  form.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => {
      updateDuration();
      updatePreview();
    });
    el.addEventListener("change", () => {
      updateDuration();
      updatePreview();
    });
  });

  document.getElementById("reset-form").addEventListener("click", resetForm);

  document.getElementById("schedule-body").addEventListener("click", async (e) => {
    const relCell = e.target.closest(".rel-link");
    if (relCell) {
      const row = relCell.closest(".row");
      const item = state.items.find((i) => i.id === row.dataset.id);
      if (item) startEdit(item);
      return;
    }
    const editBtn = e.target.closest(".edit-btn");
    if (editBtn) {
      const row = editBtn.closest(".row");
      const item = state.items.find((i) => i.id === row.dataset.id);
      if (item) startEdit(item);
      return;
    }
    const btn = e.target.closest(".delete-btn");
    if (!btn) return;
    const row = btn.closest(".row");
    const item = state.items.find((i) => i.id === row.dataset.id);
    const label = item ? `${item.time} ${item.operation}` : row.dataset.id;
    if (!confirm(`刪除 ${label}？`)) return;
    try {
      if (state.storageMode === "local") {
        state.items = state.items.filter((i) => i.id !== row.dataset.id);
        saveLocalItems(state.items);
      } else {
        const res = await fetch(`api/schedule?id=${encodeURIComponent(row.dataset.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error("刪除失敗");
      }
      await loadSchedule();
      toast("已刪除");
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function init() {
  bindFormEvents();
  resetForm();
  loadSchedule().catch((err) => {
    toast(err.message, true);
    document.getElementById("next-action").textContent = "連線失敗";
  });

  setInterval(() => {
    document.getElementById("clock").textContent = fmtClock(serverNow());
    updateStatuses();
    renderNextAction();
  }, 1000);

  window.addEventListener("resize", drawRail);
}

document.addEventListener("DOMContentLoaded", init);
