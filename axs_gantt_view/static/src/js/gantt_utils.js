/** @odoo-module **/
/* AXSync Gantt View - date, scale and scheduling helpers (framework independent). */

const { DateTime } = luxon;

export const DAY = 86400000;
export const HOUR = 3600000;
export const ROW_HEIGHT = 34;

export const PALETTE = [
    "#4A90C2", "#E8875B", "#62B07F", "#9B6FC6", "#E4B83F", "#4DB6AC",
    "#D9667B", "#7D8FA5", "#A1887F", "#5C6BC0", "#8BC34A", "#F06292",
];

export function fmt(str, ...args) {
    let i = 0;
    return String(str).replace(/%s/g, () => (i < args.length ? args[i++] : ""));
}

export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function colorFor(value) {
    if (value === null || value === undefined || value === false) {
        return null;
    }
    let index;
    if (Array.isArray(value)) {
        index = value[0];
    } else if (typeof value === "number") {
        index = value;
    } else {
        index = 0;
        for (const ch of String(value)) {
            index = (index * 31 + ch.charCodeAt(0)) % 997;
        }
    }
    return PALETTE[Math.abs(index) % PALETTE.length];
}

// ---------------------------------------------------------------------------
// server <-> epoch conversion
// ---------------------------------------------------------------------------

export function parseServerValue(value, type) {
    if (!value) {
        return null;
    }
    if (type === "date") {
        return DateTime.fromISO(value).startOf("day").toMillis();
    }
    return DateTime.fromSQL(value, { zone: "utc" }).toMillis();
}

/** Date fields are inclusive: a task ending on the 3rd lasts until the 4th at 00:00. */
export function parseStop(value, type) {
    const ms = parseServerValue(value, type);
    if (ms === null) {
        return null;
    }
    return type === "date" ? DateTime.fromMillis(ms).plus({ days: 1 }).toMillis() : ms;
}

export function serializeStart(ms, type) {
    if (ms === null || ms === undefined) {
        return false;
    }
    const dt = DateTime.fromMillis(ms);
    return type === "date" ? dt.toFormat("yyyy-MM-dd") : dt.toUTC().toFormat("yyyy-MM-dd HH:mm:ss");
}

export function serializeStop(ms, type) {
    if (ms === null || ms === undefined) {
        return false;
    }
    if (type === "date") {
        return DateTime.fromMillis(ms).minus({ milliseconds: 1 }).toFormat("yyyy-MM-dd");
    }
    return DateTime.fromMillis(ms).toUTC().toFormat("yyyy-MM-dd HH:mm:ss");
}

export function formatDate(ms, withTime = true) {
    if (ms === null || ms === undefined) {
        return "";
    }
    const dt = DateTime.fromMillis(ms);
    return withTime ? dt.toLocaleString(DateTime.DATETIME_SHORT) : dt.toLocaleString(DateTime.DATE_SHORT);
}

export function formatDuration(ms, hoursPerDay = 8, allDay = false) {
    if (!ms || ms < 0) {
        return allDay ? "0d" : "0h";
    }
    const days = Math.floor(ms / DAY);
    const hours = Math.round((ms - days * DAY) / HOUR);
    if (allDay || hours === 0) {
        return `${Math.round(ms / DAY * 10) / 10}d`;
    }
    if (!days) {
        return `${hours}h`;
    }
    return `${days}d ${hours}h`;
}

// ---------------------------------------------------------------------------
// scales and axis
// ---------------------------------------------------------------------------

export const SCALES = {
    hour: { unit: "hour", width: 46, pad: { days: 2 }, snap: { minutes: 15 } },
    day: { unit: "day", width: 40, pad: { days: 14 }, snap: { days: 1 } },
    week: { unit: "day", width: 18, pad: { weeks: 6 }, snap: { days: 1 } },
    month: { unit: "day", width: 5, pad: { months: 4 }, snap: { days: 1 } },
    quarter: { unit: "day", width: 1.8, pad: { months: 12 }, snap: { days: 1 } },
    year: { unit: "day", width: 0.7, pad: { years: 3 }, snap: { days: 1 } },
};
export const SCALE_ORDER = ["hour", "day", "week", "month", "quarter", "year"];

function headerKeys(scale) {
    switch (scale) {
        case "hour":
            return {
                top: (d) => d.toFormat("yyyy-MM-dd"),
                topLabel: (d) => d.toFormat("ccc dd LLL yyyy"),
                bottom: (d) => d.toFormat("yyyy-MM-dd HH"),
                bottomLabel: (d) => d.toFormat("HH"),
            };
        case "day":
            return {
                top: (d) => d.toFormat("yyyy-MM"),
                topLabel: (d) => d.toFormat("LLLL yyyy"),
                bottom: (d) => d.toFormat("yyyy-MM-dd"),
                bottomLabel: (d) => `${d.toFormat("ccccc")} ${d.toFormat("dd")}`,
            };
        case "week":
            return {
                top: (d) => d.toFormat("yyyy-MM"),
                topLabel: (d) => d.toFormat("LLLL yyyy"),
                bottom: (d) => `${d.weekYear}-${d.weekNumber}`,
                bottomLabel: (d) => `W${d.weekNumber} · ${d.startOf("week").toFormat("dd LLL")}`,
                bottomShort: (d) => `W${d.weekNumber}`,
            };
        case "month":
            return {
                top: (d) => d.toFormat("yyyy"),
                topLabel: (d) => d.toFormat("yyyy"),
                bottom: (d) => d.toFormat("yyyy-MM"),
                bottomLabel: (d) => d.toFormat("LLLL"),
                bottomShort: (d) => d.toFormat("LLL"),
            };
        case "quarter":
            return {
                top: (d) => d.toFormat("yyyy"),
                topLabel: (d) => d.toFormat("yyyy"),
                bottom: (d) => `${d.year}-Q${d.quarter}`,
                bottomLabel: (d) => `Q${d.quarter}`,
            };
        default:
            return {
                top: (d) => String(Math.floor(d.year / 5) * 5),
                topLabel: (d) => `${Math.floor(d.year / 5) * 5} - ${Math.floor(d.year / 5) * 5 + 4}`,
                bottom: (d) => String(d.year),
                bottomLabel: (d) => String(d.year),
            };
    }
}

/**
 * Build the time axis: a list of contiguous cells (hours or days) with an x
 * position. Hidden days get a width of 0 so the mapping stays monotonic.
 */
export function buildAxis({ start, stop, scale, zoom, hiddenWeekdays, hideDays, hiddenDates }) {
    const conf = SCALES[scale];
    const unitWidth = conf.width * zoom;
    const keys = headerKeys(scale);
    const cells = [];
    let cursor = DateTime.fromMillis(start).startOf(conf.unit === "hour" ? "hour" : "day");
    const end = DateTime.fromMillis(stop);
    const maxCells = conf.unit === "hour" ? 24 * 400 : 366 * 40;
    let x = 0;
    while (cursor < end && cells.length < maxCells) {
        const next = conf.unit === "hour" ? cursor.plus({ hours: 1 }) : cursor.plus({ days: 1 });
        const weekday = cursor.weekday - 1; // 0 = Monday
        const hidden = Boolean(hideDays) && (hiddenWeekdays.has(weekday) || Boolean(hiddenDates && hiddenDates.has(cursor.toFormat("yyyy-MM-dd"))));
        const w = hidden ? 0 : unitWidth;
        cells.push({ start: cursor.toMillis(), end: next.toMillis(), x, w, dt: cursor, weekday, hidden });
        x += w;
        cursor = next;
    }
    const groups = (keyFn, labelFn, shortFn) => {
        const result = [];
        let current = null;
        for (const cell of cells) {
            const key = keyFn(cell.dt);
            if (!current || current.key !== key) {
                current = { key, x: cell.x, w: 0, start: cell.start, end: cell.end, dt: cell.dt };
                current.label = labelFn(cell.dt);
                current.short = shortFn ? shortFn(cell.dt) : current.label;
                result.push(current);
            }
            current.w += cell.w;
            current.end = cell.end;
        }
        return result.filter((g) => g.w > 0);
    };
    return {
        scale,
        unitWidth,
        cells,
        width: x,
        start: cells.length ? cells[0].start : start,
        stop: cells.length ? cells[cells.length - 1].end : stop,
        top: groups(keys.top, keys.topLabel),
        bottom: groups(keys.bottom, keys.bottomLabel, keys.bottomShort),
    };
}

function searchCell(cells, ms) {
    let lo = 0;
    let hi = cells.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cells[mid].start <= ms) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

export function dateToX(axis, ms) {
    const cells = axis.cells;
    if (!cells.length) {
        return 0;
    }
    if (ms <= cells[0].start) {
        return cells[0].x - ((cells[0].start - ms) / (cells[0].end - cells[0].start)) * axis.unitWidth;
    }
    const last = cells[cells.length - 1];
    if (ms >= last.end) {
        return axis.width + ((ms - last.end) / (last.end - last.start)) * axis.unitWidth;
    }
    const cell = cells[searchCell(cells, ms)];
    return cell.x + ((ms - cell.start) / (cell.end - cell.start)) * cell.w;
}

export function xToDate(axis, x) {
    const cells = axis.cells;
    if (!cells.length) {
        return Date.now();
    }
    if (x <= 0) {
        const c = cells[0];
        return c.start + (x / axis.unitWidth) * (c.end - c.start);
    }
    if (x >= axis.width) {
        const c = cells[cells.length - 1];
        return c.end + ((x - axis.width) / axis.unitWidth) * (c.end - c.start);
    }
    let lo = 0;
    let hi = cells.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cells[mid].x <= x) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    while (lo < cells.length - 1 && cells[lo].w === 0) {
        lo++;
    }
    const cell = cells[lo];
    if (!cell.w) {
        return cell.start;
    }
    return cell.start + ((x - cell.x) / cell.w) * (cell.end - cell.start);
}

/** Index range of items (sorted by x) intersecting [x0, x1]. */
export function visibleSlice(items, x0, x1) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].x + items[mid].w < x0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const result = [];
    for (let i = lo; i < items.length && items[i].x <= x1; i++) {
        result.push(items[i]);
    }
    return result;
}

export function snapDelta(deltaMs, scale, allDay) {
    if (allDay || SCALES[scale].snap.days) {
        const days = Math.round(deltaMs / DAY);
        return { days };
    }
    const minutes = Math.round(deltaMs / 60000 / 15) * 15;
    return { minutes };
}

export function shiftMs(ms, delta) {
    return DateTime.fromMillis(ms).plus(delta).toMillis();
}

// ---------------------------------------------------------------------------
// working time
// ---------------------------------------------------------------------------

export function dayKey(ms) {
    return DateTime.fromMillis(ms).toFormat("yyyy-MM-dd");
}

export function buildLeaveDays(leaves) {
    const days = new Map();
    for (const leave of leaves || []) {
        let cursor = DateTime.fromSQL(leave.start, { zone: "utc" }).toLocal().startOf("day");
        const end = DateTime.fromSQL(leave.stop, { zone: "utc" }).toLocal();
        let guard = 0;
        while (cursor < end && guard < 400) {
            days.set(cursor.toFormat("yyyy-MM-dd"), leave.name);
            cursor = cursor.plus({ days: 1 });
            guard++;
        }
    }
    return days;
}

export function workingDaysBetween(start, stop, workdays, leaveDays) {
    const result = [];
    let cursor = DateTime.fromMillis(start).startOf("day");
    const end = DateTime.fromMillis(stop);
    let guard = 0;
    while (cursor < end && guard < 1000) {
        const key = cursor.toFormat("yyyy-MM-dd");
        if (workdays.has(cursor.weekday - 1) && !leaveDays.has(key)) {
            result.push(key);
        }
        cursor = cursor.plus({ days: 1 });
        guard++;
    }
    return result;
}

// ---------------------------------------------------------------------------
// critical path (on the current schedule)
// ---------------------------------------------------------------------------

/**
 * tasks: [{id, start, stop}], links: [{source, target, type, lag}] (lag in days)
 * Returns {tasks:Set, links:Set} of critical ids. A task is critical when it
 * cannot be delayed without delaying the end of the plan (total float ~ 0).
 */
export function computeCriticalPath(tasks, links) {
    const byId = new Map(tasks.filter((t) => t.start !== null && t.stop !== null).map((t) => [t.id, t]));
    const result = { tasks: new Set(), links: new Set() };
    if (!byId.size) {
        return result;
    }
    const succ = new Map();
    const indeg = new Map([...byId.keys()].map((id) => [id, 0]));
    const usable = links.filter((l) => byId.has(l.source) && byId.has(l.target));
    for (const link of usable) {
        if (!succ.has(link.source)) {
            succ.set(link.source, []);
        }
        succ.get(link.source).push(link);
        indeg.set(link.target, indeg.get(link.target) + 1);
    }
    // topological order (Kahn); tasks in a loop are ignored
    const order = [];
    const queue = [...[...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)];
    while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const link of succ.get(id) || []) {
            indeg.set(link.target, indeg.get(link.target) - 1);
            if (indeg.get(link.target) === 0) {
                queue.push(link.target);
            }
        }
    }
    const projectEnd = Math.max(...[...byId.values()].map((t) => t.stop));
    const lateFinish = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
        const task = byId.get(order[i]);
        const duration = task.stop - task.start;
        let lf = projectEnd;
        for (const link of succ.get(task.id) || []) {
            const s = byId.get(link.target);
            const sLF = lateFinish.get(s.id);
            if (sLF === undefined) {
                continue;
            }
            const sLS = sLF - (s.stop - s.start);
            const lag = (link.lag || 0) * DAY;
            let candidate;
            switch (link.type) {
                case "ss":
                    candidate = sLS - lag + duration;
                    break;
                case "ff":
                    candidate = sLF - lag;
                    break;
                case "sf":
                    candidate = sLF - lag + duration;
                    break;
                default:
                    candidate = sLS - lag;
            }
            lf = Math.min(lf, candidate);
        }
        lateFinish.set(task.id, lf);
    }
    const tolerance = HOUR;
    for (const [id, lf] of lateFinish.entries()) {
        const task = byId.get(id);
        if (lf - task.stop <= tolerance) {
            result.tasks.add(id);
        }
    }
    for (const link of usable) {
        if (result.tasks.has(link.source) && result.tasks.has(link.target)) {
            result.links.add(link.id);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// progress overlay
// ---------------------------------------------------------------------------

export function plannedProgressAt(tasks, ms) {
    let total = 0;
    let done = 0;
    for (const t of tasks) {
        const w = Math.max(t.stop - t.start, HOUR);
        total += w;
        if (ms >= t.stop) {
            done += w;
        } else if (ms > t.start) {
            done += w * ((ms - t.start) / (t.stop - t.start));
        }
    }
    return total ? (done / total) * 100 : 0;
}

export function actualProgress(tasks) {
    let total = 0;
    let done = 0;
    for (const t of tasks) {
        const w = Math.max(t.stop - t.start, HOUR);
        total += w;
        done += w * Math.max(0, Math.min(100, t.progress || 0)) / 100;
    }
    return total ? (done / total) * 100 : 0;
}

export function download(content, filename, mimetype) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimetype });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 1000);
}

export function base64ToBlob(b64, mimetype) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimetype });
}
