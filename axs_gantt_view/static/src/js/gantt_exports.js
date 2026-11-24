/** @odoo-module **/
/* AXSync Gantt View - export builders (JSON, MS Project XML, Primavera XER, iCal, PNG, PDF). */

import { buildAxis, dateToX, DAY, HOUR, escapeHtml } from "./gantt_utils";

const { DateTime } = luxon;

function iso(ms) {
    return ms === null || ms === undefined ? "" : DateTime.fromMillis(ms).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}
function sqlLocal(ms) {
    return ms === null || ms === undefined ? "" : DateTime.fromMillis(ms).toFormat("yyyy-MM-dd HH:mm");
}

/** tasks: flattened export rows [{ref, id, name, level, parentRef, start, stop, progress, milestone, resource}] */
export function buildJson({ title, model, tasks, links }) {
    return JSON.stringify(
        {
            format: "axsync-gantt",
            version: 1,
            title,
            model,
            exported_at: DateTime.utc().toISO(),
            tasks: tasks.map((t) => ({
                id: t.ref,
                name: t.name,
                parent: t.parentRef ?? null,
                start: t.start === null ? null : DateTime.fromMillis(t.start).toUTC().toISO(),
                end: t.stop === null ? null : DateTime.fromMillis(t.stop).toUTC().toISO(),
                progress: t.progress ?? null,
                milestone: Boolean(t.milestone),
                resource: t.resource || "",
                deadline: t.deadline ? DateTime.fromMillis(t.deadline).toUTC().toISO() : null,
            })),
            links: links.map((l) => ({ source: l.source, target: l.target, type: l.type, lag: l.lag || 0 })),
        },
        null,
        2
    );
}

const MSP_TYPES = { ff: 0, fs: 1, sf: 2, ss: 3 };

export function buildMsProjectXml({ title, tasks, links }) {
    const uid = new Map(tasks.map((t, i) => [t.ref, i + 1]));
    const preds = new Map();
    for (const l of links) {
        if (!preds.has(l.target)) {
            preds.set(l.target, []);
        }
        preds.get(l.target).push(l);
    }
    const scheduled = tasks.filter((t) => t.start !== null);
    const start = scheduled.length ? Math.min(...scheduled.map((t) => t.start)) : Date.now();
    const stop = scheduled.length ? Math.max(...scheduled.map((t) => t.stop ?? t.start)) : Date.now();
    const lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Project xmlns="http://schemas.microsoft.com/project">',
        `  <Name>${escapeHtml(title)}</Name>`,
        `  <Title>${escapeHtml(title)}</Title>`,
        `  <StartDate>${iso(start)}</StartDate>`,
        `  <FinishDate>${iso(stop)}</FinishDate>`,
        "  <CalendarUID>1</CalendarUID>",
        "  <Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar></Calendar></Calendars>",
        "  <Tasks>",
    ];
    tasks.forEach((t, i) => {
        const s = t.start ?? start;
        const f = t.stop ?? s;
        const hours = Math.max(0, Math.round((f - s) / HOUR));
        lines.push("    <Task>");
        lines.push(`      <UID>${i + 1}</UID><ID>${i + 1}</ID>`);
        lines.push(`      <Name>${escapeHtml(t.name)}</Name>`);
        lines.push(`      <OutlineLevel>${(t.level || 0) + 1}</OutlineLevel>`);
        lines.push(`      <Start>${iso(s)}</Start><Finish>${iso(f)}</Finish>`);
        lines.push(`      <Duration>PT${hours}H0M0S</Duration><DurationFormat>7</DurationFormat>`);
        lines.push(`      <Milestone>${t.milestone ? 1 : 0}</Milestone>`);
        lines.push(`      <PercentComplete>${Math.round(t.progress || 0)}</PercentComplete>`);
        lines.push("      <Manual>1</Manual>");
        if (t.deadline) {
            lines.push(`      <Deadline>${iso(t.deadline)}</Deadline>`);
        }
        for (const l of preds.get(t.ref) || []) {
            if (!uid.has(l.source)) {
                continue;
            }
            lines.push(
                `      <PredecessorLink><PredecessorUID>${uid.get(l.source)}</PredecessorUID><Type>${MSP_TYPES[l.type] ?? 1}</Type><LinkLag>${Math.round((l.lag || 0) * 8 * 600)}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`
            );
        }
        lines.push("    </Task>");
    });
    lines.push("  </Tasks>", "</Project>", "");
    return lines.join("\n");
}

export function buildXer({ title, tasks, links, user }) {
    const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
    const scheduled = tasks.filter((t) => t.start !== null);
    const start = scheduled.length ? Math.min(...scheduled.map((t) => t.start)) : Date.now();
    const stop = scheduled.length ? Math.max(...scheduled.map((t) => t.stop ?? t.start)) : Date.now();
    const ids = new Map(tasks.map((t, i) => [t.ref, 1000 + i]));
    const out = [];
    const today = DateTime.now().toFormat("yyyy-MM-dd");
    out.push(["ERMHDR", "19.12", today, "Project", clean(user), clean(user), "dbxDatabaseNoName", "Project Management", "USD"].join("\t"));
    out.push("%T\tCALENDAR");
    out.push("%F\tclndr_id\tdefault_flag\tclndr_name\tproj_id\tbase_clndr_id\tlast_chng_date\tclndr_type\tday_hr_cnt\tweek_hr_cnt\tmonth_hr_cnt\tyear_hr_cnt\trsrc_private");
    out.push(`%R\t1\tY\tStandard\t\t\t${today} 00:00\tCA_Base\t8\t40\t172\t2000\tN`);
    out.push("%T\tPROJECT");
    out.push("%F\tproj_id\tproj_short_name\tclndr_id\tplan_start_date\tplan_end_date\tscd_end_date\tlast_recalc_date");
    out.push(`%R\t1\t${clean(title).slice(0, 40) || "AXSYNC"}\t1\t${sqlLocal(start)}\t${sqlLocal(stop)}\t${sqlLocal(stop)}\t${sqlLocal(Date.now())}`);
    out.push("%T\tPROJWBS");
    out.push("%F\twbs_id\tproj_id\tobs_id\tseq_num\tproj_node_flag\tstatus_code\twbs_short_name\twbs_name\tparent_wbs_id");
    out.push(`%R\t1\t1\t\t1\tY\tWS_Open\t${clean(title).slice(0, 20) || "WBS"}\t${clean(title)}\t`);
    out.push("%T\tTASK");
    out.push("%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tduration_type\tstatus_code\tcomplete_pct_type\tphys_complete_pct\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\ttarget_start_date\ttarget_end_date\tearly_start_date\tearly_end_date");
    tasks.forEach((t, i) => {
        const s = t.start ?? start;
        const f = t.stop ?? s;
        const hours = Math.max(0, Math.round((f - s) / HOUR));
        const pct = Math.round(t.progress || 0);
        const status = pct >= 100 ? "TK_Complete" : pct > 0 ? "TK_Active" : "TK_NotStart";
        out.push(
            [
                "%R", ids.get(t.ref), 1, 1, 1, `A${1000 + i * 10}`, clean(t.name),
                t.milestone ? "TT_FinMile" : "TT_Task", "DT_FixedDUR2", status, "CP_Phys", pct,
                hours, Math.round(hours * (1 - pct / 100)), sqlLocal(s), sqlLocal(f), sqlLocal(s), sqlLocal(f),
            ].join("\t")
        );
    });
    out.push("%T\tTASKPRED");
    out.push("%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt");
    links.forEach((l, i) => {
        if (ids.has(l.source) && ids.has(l.target)) {
            out.push(["%R", 5000 + i, ids.get(l.target), ids.get(l.source), 1, 1, `PR_${String(l.type || "fs").toUpperCase()}`, Math.round((l.lag || 0) * 8)].join("\t"));
        }
    });
    out.push("%E", "");
    return out.join("\r\n");
}

function icsEscape(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function icsFold(line) {
    const parts = [];
    let rest = line;
    while (rest.length > 74) {
        parts.push(rest.slice(0, 74));
        rest = " " + rest.slice(74);
    }
    parts.push(rest);
    return parts.join("\r\n");
}

export function buildIcs({ title, model, tasks, host }) {
    const stamp = DateTime.utc().toFormat("yyyyMMdd'T'HHmmss'Z'");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AXSync//Gantt View//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEscape(title)}`];
    for (const t of tasks) {
        if (t.start === null) {
            continue;
        }
        const stop = t.stop ?? t.start;
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${model}-${t.ref}@${host || "axsync"}`);
        lines.push(`DTSTAMP:${stamp}`);
        if (t.allDay) {
            lines.push(`DTSTART;VALUE=DATE:${DateTime.fromMillis(t.start).toFormat("yyyyMMdd")}`);
            lines.push(`DTEND;VALUE=DATE:${DateTime.fromMillis(Math.max(stop, t.start + DAY)).toFormat("yyyyMMdd")}`);
        } else {
            lines.push(`DTSTART:${DateTime.fromMillis(t.start).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`);
            lines.push(`DTEND:${DateTime.fromMillis(Math.max(stop, t.start + 60000)).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`);
        }
        lines.push(icsFold(`SUMMARY:${icsEscape(t.name)}`));
        const desc = [];
        if (t.progress !== null && t.progress !== undefined) {
            desc.push(`Progress: ${Math.round(t.progress)}%`);
        }
        if (t.resource) {
            desc.push(`Assigned: ${t.resource}`);
        }
        if (desc.length) {
            lines.push(icsFold(`DESCRIPTION:${icsEscape(desc.join("\n"))}`));
        }
        lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR", "");
    return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// image rendering (PNG / PDF)
// ---------------------------------------------------------------------------

const ROW = 26;
const HEAD = 46;

/**
 * Draw a static Gantt chart.
 * spec: {title, rows:[{kind, name, level, start, stop, progress, color, milestone, critical}], links, axis, gridWidth, dateLabels}
 */
export function drawGantt(canvas, spec) {
    const { rows, axis, gridWidth } = spec;
    const width = gridWidth + axis.width + 20;
    const height = HEAD + 30 + rows.length * ROW + 10;
    const ratio = spec.ratio || 1;
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#212529";
    ctx.fillText(spec.title || "", 10, 20);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#6c757d";
    ctx.fillText(spec.subtitle || "", 10, 36);
    const top = 30;
    const ox = gridWidth;
    // header
    ctx.fillStyle = "#f1f3f5";
    ctx.fillRect(0, top, width, HEAD);
    ctx.strokeStyle = "#dee2e6";
    ctx.lineWidth = 1;
    ctx.font = "bold 11px sans-serif";
    ctx.fillStyle = "#343a40";
    ctx.fillText(spec.nameLabel || "Name", 8, top + 28);
    for (const g of axis.top) {
        ctx.strokeRect(ox + g.x, top, g.w, HEAD / 2);
        if (g.w > 30) {
            ctx.fillText(g.label, ox + g.x + 4, top + 15, g.w - 8);
        }
    }
    ctx.font = "10px sans-serif";
    for (const g of axis.bottom) {
        ctx.strokeRect(ox + g.x, top + HEAD / 2, g.w, HEAD / 2);
        const label = g.w > 60 ? g.label : g.short;
        if (g.w > 14) {
            ctx.fillText(label, ox + g.x + 3, top + HEAD / 2 + 15, g.w - 5);
        }
    }
    const bodyTop = top + HEAD;
    // days off
    if (spec.offCells) {
        ctx.fillStyle = "rgba(108,117,125,0.08)";
        for (const c of spec.offCells) {
            ctx.fillRect(ox + c.x, bodyTop, Math.max(c.w, 0.5), rows.length * ROW);
        }
    }
    // rows
    rows.forEach((row, i) => {
        const y = bodyTop + i * ROW;
        if (row.kind === "group") {
            ctx.fillStyle = "#f8f9fa";
            ctx.fillRect(0, y, width, ROW);
        }
        ctx.strokeStyle = "#edf0f2";
        ctx.beginPath();
        ctx.moveTo(0, y + ROW);
        ctx.lineTo(width, y + ROW);
        ctx.stroke();
        ctx.fillStyle = "#212529";
        ctx.font = row.kind === "group" ? "bold 11px sans-serif" : "11px sans-serif";
        ctx.fillText(row.name, 8 + row.level * 14, y + 17, gridWidth - 16 - row.level * 14);
        if (row.start === null || row.start === undefined) {
            return;
        }
        const x1 = ox + dateToX(axis, row.start);
        const x2 = ox + dateToX(axis, row.stop ?? row.start);
        if (row.milestone) {
            ctx.fillStyle = row.critical ? "#d9534f" : "#495057";
            ctx.beginPath();
            ctx.moveTo(x1, y + 5);
            ctx.lineTo(x1 + 8, y + 13);
            ctx.lineTo(x1, y + 21);
            ctx.lineTo(x1 - 8, y + 13);
            ctx.closePath();
            ctx.fill();
            return;
        }
        const w = Math.max(x2 - x1, 3);
        if (row.kind === "group") {
            ctx.fillStyle = "#495057";
            ctx.fillRect(x1, y + 9, w, 6);
            return;
        }
        ctx.fillStyle = row.critical ? "#d9534f" : row.color || "#4A90C2";
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x1, y + 5, w, 16);
        ctx.globalAlpha = 1;
        if (row.progress) {
            ctx.fillRect(x1, y + 5, (w * Math.min(100, row.progress)) / 100, 16);
        }
    });
    // links
    const index = new Map(rows.map((r, i) => [r.id, i]));
    ctx.strokeStyle = "#868e96";
    for (const l of spec.links || []) {
        if (!index.has(l.source) || !index.has(l.target)) {
            continue;
        }
        const s = rows[index.get(l.source)];
        const t = rows[index.get(l.target)];
        if (s.start === null || t.start === null) {
            continue;
        }
        const sx = ox + dateToX(axis, l.type === "ss" || l.type === "sf" ? s.start : s.stop ?? s.start);
        const tx = ox + dateToX(axis, l.type === "ff" || l.type === "sf" ? t.stop ?? t.start : t.start);
        const sy = bodyTop + index.get(l.source) * ROW + ROW / 2;
        const ty = bodyTop + index.get(l.target) * ROW + ROW / 2;
        ctx.strokeStyle = l.critical ? "#d9534f" : "#868e96";
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 6, sy);
        ctx.lineTo(sx + 6, ty);
        ctx.lineTo(tx, ty);
        ctx.stroke();
    }
    // today
    const tx = ox + dateToX(axis, Date.now());
    if (tx > ox && tx < width) {
        ctx.strokeStyle = "#e8875b";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx, top);
        ctx.lineTo(tx, bodyTop + rows.length * ROW);
        ctx.stroke();
    }
    ctx.strokeStyle = "#ced4da";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, top);
    ctx.lineTo(ox, bodyTop + rows.length * ROW);
    ctx.stroke();
    return canvas;
}

/** Choose an axis so that the plan fits in maxWidth pixels. */
export function exportAxis({ start, stop, scale, zoom, hiddenWeekdays, hideDays, hiddenDates, maxWidth }) {
    let axis = buildAxis({ start, stop, scale, zoom, hiddenWeekdays, hideDays, hiddenDates });
    if (axis.width > maxWidth) {
        const factor = maxWidth / axis.width;
        axis = buildAxis({ start, stop, scale, zoom: zoom * factor, hiddenWeekdays, hideDays, hiddenDates });
        // labels become unreadable on a squeezed hour/day scale: switch to a coarser scale
        if (axis.unitWidth < 8 && (scale === "hour" || scale === "day")) {
            const base = buildAxis({ start, stop, scale: "week", zoom: 1, hiddenWeekdays, hideDays });
            axis = buildAxis({ start, stop, scale: "week", zoom: Math.min(1, maxWidth / base.width), hiddenWeekdays, hideDays });
        }
    }
    return axis;
}

export function offCellsFor(axis, isOff) {
    const result = [];
    for (const c of axis.cells) {
        if (c.w && isOff(c)) {
            const last = result[result.length - 1];
            if (last && Math.abs(last.x + last.w - c.x) < 0.01) {
                last.w += c.w;
            } else {
                result.push({ x: c.x, w: c.w });
            }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// minimal PDF writer: one JPEG image per page (A4 landscape)
// ---------------------------------------------------------------------------

function dataUrlToBytes(dataUrl) {
    const bin = atob(dataUrl.split(",")[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

export function buildPdf(canvases, { pageWidth = 842, pageHeight = 595, margin = 24 } = {}) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => {
        const bytes = typeof part === "string" ? enc.encode(part) : part;
        chunks.push(bytes);
        length += bytes.length;
    };
    const objStart = (n) => {
        offsets[n] = length;
        push(`${n} 0 obj\n`);
    };
    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const n = canvases.length;
    // object numbers: 1 catalog, 2 pages, then per page: page, content, image
    const pageObj = (i) => 3 + i * 3;
    objStart(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    objStart(2);
    const kids = canvases.map((_, i) => `${pageObj(i)} 0 R`).join(" ");
    push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
    canvases.forEach((canvas, i) => {
        const jpeg = dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
        const availW = pageWidth - 2 * margin;
        const availH = pageHeight - 2 * margin;
        const scale = Math.min(availW / canvas.width, availH / canvas.height);
        const w = canvas.width * scale;
        const h = canvas.height * scale;
        const x = margin;
        const y = pageHeight - margin - h;
        objStart(pageObj(i));
        push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${i} ${pageObj(i) + 2} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>\nendobj\n`);
        const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${i} Do Q\n`;
        objStart(pageObj(i) + 1);
        push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
        objStart(pageObj(i) + 2);
        push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
        push(jpeg);
        push("\nendstream\nendobj\n");
    });
    const total = 3 + n * 3;
    const xref = length;
    let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) {
        table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    push(table);
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let pos = 0;
    for (const c of chunks) {
        out.set(c, pos);
        pos += c.length;
    }
    return new Blob([out], { type: "application/pdf" });
}

