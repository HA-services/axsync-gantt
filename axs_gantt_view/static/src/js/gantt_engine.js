/** @odoo-module **/
/* AXSync Gantt View - rendering and interaction engine.
 *
 * The engine is plain JavaScript working on a DOM element so that the same
 * code runs on every supported Odoo version; the OWL controller only wires
 * it to the search model and to the web client services.
 */

import { _t } from "@web/core/l10n/translation";
import {
    DAY, HOUR, ROW_HEIGHT, SCALES, SCALE_ORDER, PALETTE,
    actualProgress, base64ToBlob, buildAxis, buildLeaveDays, colorFor, computeCriticalPath,
    dateToX, dayKey, download, escapeHtml, fmt, formatDate, formatDuration, parseServerValue,
    parseStop, plannedProgressAt, serializeStart, serializeStop, shiftMs, snapDelta, visibleSlice,
    workingDaysBetween, xToDate,
} from "./gantt_utils";
import {
    buildIcs, buildJson, buildMsProjectXml, buildPdf, buildXer, drawGantt, exportAxis, offCellsFor,
} from "./gantt_exports";

const { DateTime } = luxon;

const BAR_PAD = 7;

// semantic icon name -> [Font Awesome 4 class, Material Symbols name]
const ICONS = {
    add: ["fa-plus", "add"], today: ["fa-crosshairs", "my_location"], scale: ["fa-calendar", "calendar_today"],
    zoom_out: ["fa-search-minus", "zoom_out"], zoom_in: ["fa-search-plus", "zoom_in"], fit: ["fa-arrows-h", "width"],
    sort: ["fa-sort-amount-asc", "sort"], expand_all: ["fa-plus-square-o", "add_box"],
    collapse_all: ["fa-minus-square-o", "indeterminate_check_box"], group: ["fa-object-group", "tune"],
    tree: ["fa-sitemap", "account_tree"], undo: ["fa-undo", "undo"], grid: ["fa-list", "view_list"],
    resources: ["fa-users", "group"], critical: ["fa-bolt", "flash_on"], overlay: ["fa-line-chart", "show_chart"],
    markers: ["fa-flag", "flag"], xlsx: ["fa-file-excel-o", "table_chart"], pdf: ["fa-file-pdf-o", "picture_as_pdf"],
    png: ["fa-file-image-o", "image"], code: ["fa-file-code-o", "code"], text: ["fa-file-text-o", "description"],
    ics: ["fa-calendar-o", "calendar_today"], import: ["fa-upload", "upload"], export: ["fa-download", "download"],
    fullscreen: ["fa-expand", "fullscreen"], fullscreen_exit: ["fa-compress", "fullscreen_exit"],
    settings: ["fa-cog", "settings"], open: ["fa-external-link", "open_in_new"], edit: ["fa-pencil", "edit"],
    unschedule: ["fa-calendar-times-o", "event_busy"], check: ["fa-check", "check"], delete: ["fa-trash", "delete"],
    milestone: ["fa-diamond", "diamond"], pin: ["fa-thumb-tack", "push_pin"], caret_right: ["fa-caret-right", "arrow_right"],
    caret_down: ["fa-caret-down", "arrow_drop_down"], gantt: ["fa-tasks", "view_timeline"],
    spinner: ["fa-circle-o-notch", "progress_activity"],
};
let ICON_SET = "fa";

/** Choose the icon font: "fa" (Font Awesome, Odoo 16-19) or "ms" (Material Symbols, Odoo 20+). */
export function setIconSet(name) {
    ICON_SET = name;
}

function icon(name, extraClass = "") {
    const pair = ICONS[name] || [name, name];
    if (ICON_SET === "ms") {
        return `<i class="oi ${extraClass}" data-icon="${pair[1]}" aria-hidden="true"></i>`;
    }
    return `<i class="fa ${pair[0]} ${extraClass}" aria-hidden="true"></i>`;
}
const HEADER_H = 52;
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) {
                continue;
            }
            if (k === "text") {
                node.textContent = v;
            } else if (k === "html") {
                node.innerHTML = v;
            } else {
                node.setAttribute(k, v === true ? "" : v);
            }
        }
    }
    return node;
}

function svg(tag, attrs) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        node.setAttribute(k, v);
    }
    return node;
}

const CONSTRAINT_LABELS = () => ({
    asap: _t("As Soon As Possible"),
    snet: _t("Start No Earlier Than"),
    snlt: _t("Start No Later Than"),
    fnet: _t("Finish No Earlier Than"),
    fnlt: _t("Finish No Later Than"),
    mso: _t("Must Start On"),
    mfo: _t("Must Finish On"),
});
const LINK_LABELS = () => ({
    fs: _t("Finish to Start"),
    ss: _t("Start to Start"),
    ff: _t("Finish to Finish"),
    sf: _t("Start to Finish"),
});
const SCALE_LABELS = () => ({
    hour: _t("Hours"),
    day: _t("Days"),
    week: _t("Weeks"),
    month: _t("Months"),
    quarter: _t("Quarters"),
    year: _t("Years"),
});

export class GanttEngine {
    /**
     * @param {HTMLElement} root
     * @param {Object} options {services, resModel, archInfo, context, domain, title, isSmall}
     */
    constructor(root, options) {
        this.root = root;
        this.options = options;
        this.services = options.services;
        this.resModel = options.resModel;
        this.arch = options.archInfo;
        this.context = options.context || {};
        this.domain = options.domain || [];
        this.title = options.title || "";
        this.data = null;
        this.records = new Map();
        this.rows = [];
        this.undoStack = [];
        this.selectedId = null;
        this.searchText = "";
        this.critical = { tasks: new Set(), links: new Set() };
        this.prefsKey = `axs_gantt:${this.resModel}:${this.arch.viewId || "default"}`;
        this.prefs = Object.assign(
            {
                scale: null,
                zoom: 1,
                gridWidth: 520,
                gridVisible: true,
                resourceVisible: false,
                critical: false,
                overlay: false,
                markers: true,
                sort: "start_asc",
                groupBy: null,
                collapsed: [],
            },
            this._readPrefs()
        );
        this.collapsed = new Set(this.prefs.collapsed || []);
        this._raf = null;
        this._listeners = [];
        this._build();
    }

    // ------------------------------------------------------------------
    // preferences
    // ------------------------------------------------------------------
    _readPrefs() {
        try {
            return JSON.parse(window.localStorage.getItem(this.prefsKey) || "{}");
        } catch {
            return {};
        }
    }
    _savePrefs() {
        this.prefs.collapsed = [...this.collapsed].slice(0, 500);
        try {
            window.localStorage.setItem(this.prefsKey, JSON.stringify(this.prefs));
        } catch {
            // storage full or disabled: preferences are a convenience only
        }
    }

    // ------------------------------------------------------------------
    // DOM skeleton
    // ------------------------------------------------------------------
    _listen(target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        this._listeners.push([target, type, handler, opts]);
    }

    _build() {
        const root = this.root;
        root.innerHTML = "";
        root.classList.add("o_axs_gantt_root");
        root.tabIndex = 0;
        this.toolbar = el("div", "o_axs_gantt_toolbar");
        this.body = el("div", "o_axs_gantt_body");
        this.grid = el("div", "o_axs_gantt_grid");
        this.gridHeader = el("div", "o_axs_gantt_grid_header");
        this.gridRows = el("div", "o_axs_gantt_grid_rows");
        this.gridInner = el("div", "o_axs_gantt_grid_inner");
        this.gridRows.appendChild(this.gridInner);
        this.grid.append(this.gridHeader, this.gridRows);
        this.splitter = el("div", "o_axs_gantt_splitter", { title: _t("Drag to resize the task list") });
        this.chart = el("div", "o_axs_gantt_chart");
        this.header = el("div", "o_axs_gantt_header");
        this.headerTop = el("div", "o_axs_gantt_header_top");
        this.headerBottom = el("div", "o_axs_gantt_header_bottom");
        this.header.append(this.headerTop, this.headerBottom);
        this.canvas = el("div", "o_axs_gantt_canvas");
        this.bg = el("div", "o_axs_gantt_bg");
        this.linkLayer = svg("svg", { class: "o_axs_gantt_links" });
        const defs = svg("defs");
        for (const [id, color] of [["axs_arrow", "#868e96"], ["axs_arrow_crit", "#d9534f"], ["axs_arrow_sel", "#1f6feb"]]) {
            const marker = svg("marker", { id: `${id}_${this._uid()}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
            marker.appendChild(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: color }));
            defs.appendChild(marker);
            this[`_${id}`] = marker.id;
        }
        this.linkLayer.appendChild(defs);
        this.linkGroup = svg("g");
        this.linkLayer.appendChild(this.linkGroup);
        this.bars = el("div", "o_axs_gantt_bars");
        this.overlay = svg("svg", { class: "o_axs_gantt_overlay" });
        this.canvas.append(this.bg, this.linkLayer, this.bars, this.overlay);
        this.chart.append(this.header, this.canvas);
        this.body.append(this.grid, this.splitter, this.chart);
        this.resourcePanel = el("div", "o_axs_gantt_resources d-none");
        this.status = el("div", "o_axs_gantt_status");
        this.tooltip = el("div", "o_axs_gantt_tooltip d-none");
        this.popover = el("div", "o_axs_gantt_popover d-none");
        this.loading = el("div", "o_axs_gantt_loading d-none", { html: icon("spinner", "o_axs_gantt_spin fs-2") });
        this.empty = el("div", "o_axs_gantt_empty d-none");
        root.append(this.toolbar, this.body, this.resourcePanel, this.status, this.tooltip, this.popover, this.loading, this.empty);

        this._listen(this.chart, "scroll", () => this._onScroll(), { passive: true });
        this._listen(this.gridRows, "wheel", (ev) => {
            this.chart.scrollTop += ev.deltaY;
            ev.preventDefault();
        });
        this._listen(this.chart, "wheel", (ev) => this._onWheel(ev), { passive: false });
        this._listen(this.splitter, "pointerdown", (ev) => this._startSplitter(ev));
        this._listen(root, "keydown", (ev) => this._onKeydown(ev));
        this._listen(document, "pointerdown", (ev) => {
            if (!this.popover.contains(ev.target) && !ev.target.closest?.(".o_axs_gantt_bar, .o_axs_gantt_link_hit")) {
                this._closePopover();
            }
            if (!ev.target.closest?.(".o_axs_gantt_menu, .o_axs_gantt_menu_toggle")) {
                this._closeMenus();
            }
        });
        this._listen(document, "fullscreenchange", () => {
            this.root.classList.toggle("o_axs_gantt_fullscreen", document.fullscreenElement === this.root);
            this._scheduleRender(true);
        });
        this._listen(this.bars, "pointerdown", (ev) => this._onBarPointerDown(ev));
        this._listen(this.bars, "dblclick", (ev) => {
            const bar = ev.target.closest(".o_axs_gantt_bar");
            if (bar && bar.dataset.id) {
                this.openRecord(Number(bar.dataset.id));
            }
        });
        this._listen(this.bars, "pointermove", (ev) => this._onBarHover(ev));
        this._listen(this.bars, "pointerleave", () => this._hideTooltip());
        this._listen(this.canvas, "click", (ev) => this._onCanvasClick(ev));
        this._listen(this.linkGroup, "click", (ev) => this._onLinkClick(ev));
        this._listen(this.gridInner, "click", (ev) => this._onGridClick(ev));
        this._listen(this.gridInner, "dblclick", (ev) => {
            const row = ev.target.closest(".o_axs_gantt_row");
            if (row && row.dataset.recordId && !ev.target.closest("button")) {
                this.openRecord(Number(row.dataset.recordId));
            }
        });
        if (window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(() => this._scheduleRender(true));
            this._resizeObserver.observe(this.root);
        }
    }

    _uid() {
        GanttEngine._seq = (GanttEngine._seq || 0) + 1;
        return GanttEngine._seq;
    }

    destroy() {
        for (const [target, type, handler, opts] of this._listeners) {
            target.removeEventListener(type, handler, opts);
        }
        this._listeners = [];
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
        if (this._raf) {
            cancelAnimationFrame(this._raf);
        }
        this._destroyed = true;
        this.root.innerHTML = "";
    }

    // ------------------------------------------------------------------
    // data
    // ------------------------------------------------------------------
    get params() {
        const a = this.arch;
        let groupBy;
        if (this.groupOverride !== undefined) {
            groupBy = this.groupOverride ? [this.groupOverride] : [];
        } else if (this.searchGroupBy && this.searchGroupBy.length) {
            groupBy = this.searchGroupBy;
        } else if (this.prefs.groupBy !== null && this.prefs.groupBy !== undefined) {
            groupBy = this.prefs.groupBy ? [this.prefs.groupBy] : [];
        } else {
            groupBy = a.defaultGroupBy ? [a.defaultGroupBy] : [];
        }
        return {
            date_start: a.dateStart,
            date_stop: a.dateStop,
            progress: a.progress,
            parent_field: a.parentField,
            color: a.color,
            deadline: a.deadline,
            milestone: a.milestone,
            resource: a.resource,
            dependency_field: a.dependencyField,
            allocated_hours: a.allocatedHours,
            sequence: a.sequence,
            group_by: groupBy.map((g) => g.split(":")[0]),
            fields: a.fields.map((f) => f.name),
            group_options: a.groupByOptions,
            auto_schedule: a.autoSchedule,
        };
    }

    async load({ domain, context, groupBy } = {}) {
        if (domain) {
            this.domain = domain;
        }
        if (context) {
            this.context = context;
        }
        if (groupBy) {
            if (JSON.stringify(groupBy) !== JSON.stringify(this.searchGroupBy || [])) {
                // the user changed the grouping in the search bar: it wins over the toolbar choice
                this.groupOverride = undefined;
            }
            this.searchGroupBy = groupBy;
        }
        this._setLoading(true);
        try {
            const data = await this.services.orm.call("axs.gantt", "get_data", [this.resModel, this.params, this.domain], { context: this.context });
            if (this._destroyed) {
                return;
            }
            this._ingest(data);
            this._afterLoad();
        } catch (error) {
            this._setLoading(false);
            throw error;
        }
        this._setLoading(false);
    }

    _setLoading(value) {
        this.loading.classList.toggle("d-none", !value);
    }

    _ingest(data) {
        this.data = data;
        const p = data.params;
        this.p = p;
        this.fields = data.fields;
        this.settings = data.settings;
        this.access = data.access;
        const startType = this.fields[p.date_start]?.type;
        const stopType = p.date_stop ? this.fields[p.date_stop]?.type : startType;
        this.startType = startType;
        this.stopType = stopType;
        this.allDay = startType === "date";
        this.workdays = new Set(data.calendar.workdays);
        this.hoursPerDay = data.calendar.hours_per_day || 8;
        this.leaveDays = buildLeaveDays(data.calendar.leaves);
        this.hiddenWeekdays = new Set(data.settings.hidden_weekdays || []);
        if (!this.prefs.scale) {
            this.prefs.scale = this.arch.defaultScale || data.settings.default_scale || "week";
        }
        if (!SCALES[this.prefs.scale]) {
            this.prefs.scale = "week";
        }
        this.records = new Map();
        const groupFields = p.group_by || [];
        for (const raw of data.records) {
            let start = parseServerValue(raw[p.date_start], startType);
            let stop = p.date_stop ? parseStop(raw[p.date_stop], stopType) : null;
            const unscheduled = Boolean(raw.axs_unscheduled) || start === null;
            let milestone = raw.axs_task_type === "milestone" || (p.milestone ? Boolean(raw[p.milestone]) && raw[p.milestone] !== "task" : false);
            if (start !== null && (stop === null || stop < start)) {
                stop = start + (this.allDay ? DAY : (p.date_stop ? HOUR : DAY));
            }
            if (start !== null && stop === start) {
                milestone = true;
            }
            const resourceRaw = p.resource ? raw[p.resource] : false;
            let resources = [];
            if (Array.isArray(resourceRaw)) {
                resources = resourceRaw.length && Array.isArray(resourceRaw[0]) ? resourceRaw : resourceRaw.length === 2 && typeof resourceRaw[1] === "string" ? [resourceRaw] : [];
            }
            const rec = {
                id: raw.id,
                name: raw.display_name || `#${raw.id}`,
                start: unscheduled ? null : start,
                stop: unscheduled ? null : stop,
                origStart: start,
                origStop: stop,
                unscheduled,
                progress: p.progress ? Number(raw[p.progress] || 0) : null,
                parentId: p.parent_field && Array.isArray(raw[p.parent_field]) ? raw[p.parent_field][0] : null,
                color: p.color ? raw[p.color] : null,
                deadline: p.deadline ? parseStop(raw[p.deadline], this.fields[p.deadline]?.type) : null,
                milestone,
                resources,
                groupValues: groupFields.map((g) => raw[g]),
                constraintType: raw.axs_constraint_type || null,
                constraintDate: raw.axs_constraint_date ? parseServerValue(raw.axs_constraint_date, "datetime") : null,
                scheduleMode: raw.axs_schedule_mode || null,
                allocated: p.allocated_hours ? Number(raw[p.allocated_hours] || 0) : 0,
                raw,
            };
            this.records.set(rec.id, rec);
        }
        for (const rec of this.records.values()) {
            if (rec.parentId && !this.records.has(rec.parentId)) {
                rec.parentId = null;
            }
        }
        this.links = data.links.filter((l) => this.records.has(l.source) && this.records.has(l.target));
        this.markers = (data.markers || []).map((m) => ({ ...m, ms: parseServerValue(m.date, m.type || "date") })).filter((m) => m.ms !== null);
    }

    _afterLoad() {
        this._closePopover();
        this._computeCritical();
        this._buildRows();
        this._buildAxis();
        this._renderToolbar();
        this._renderGridHeader();
        this._updateLayout();
        if (!this._initialScrollDone) {
            this._initialScrollDone = true;
            this.scrollToDate(Date.now(), true);
        }
        this._scheduleRender(true);
        this._renderStatus();
    }

    // ------------------------------------------------------------------
    // rows
    // ------------------------------------------------------------------
    _sortRecords(list) {
        const sort = this.prefs.sort;
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        const byName = (a, b) => collator.compare(a.name, b.name);
        const nullLast = (a, b, key, dir) => {
            if (a[key] === null && b[key] === null) {
                return 0;
            }
            if (a[key] === null) {
                return 1;
            }
            if (b[key] === null) {
                return -1;
            }
            return dir * (a[key] - b[key]);
        };
        const cmp = {
            name_asc: byName,
            name_desc: (a, b) => -byName(a, b),
            start_asc: (a, b) => nullLast(a, b, "start", 1) || byName(a, b),
            start_desc: (a, b) => nullLast(a, b, "start", -1) || byName(a, b),
            stop_asc: (a, b) => nullLast(a, b, "stop", 1) || byName(a, b),
            progress_desc: (a, b) => nullLast(a, b, "progress", -1) || byName(a, b),
            default: null,
        }[sort];
        return cmp ? [...list].sort(cmp) : list;
    }

    _groupLabel(value, fname) {
        const meta = this.fields[fname] || {};
        if (value === false || value === null || value === undefined || (Array.isArray(value) && !value.length)) {
            return _t("None");
        }
        if (Array.isArray(value)) {
            if (Array.isArray(value[0])) {
                return value[0][1];
            }
            return value[1];
        }
        if (meta.type === "selection") {
            const found = (meta.selection || []).find((s) => s[0] === value);
            return found ? found[1] : String(value);
        }
        if (meta.type === "boolean") {
            return value ? _t("Yes") : _t("No");
        }
        return String(value);
    }

    _groupKey(value) {
        if (Array.isArray(value)) {
            if (!value.length) {
                return "false";
            }
            return Array.isArray(value[0]) ? String(value[0][0]) : String(value[0]);
        }
        return String(value);
    }

    _buildRows() {
        const text = this.searchText.trim().toLowerCase();
        let visible = new Set(this.records.keys());
        if (text) {
            visible = new Set();
            for (const rec of this.records.values()) {
                if (rec.name.toLowerCase().includes(text)) {
                    let cur = rec;
                    while (cur && !visible.has(cur.id)) {
                        visible.add(cur.id);
                        cur = cur.parentId ? this.records.get(cur.parentId) : null;
                    }
                }
            }
        }
        const children = new Map();
        const roots = [];
        for (const rec of this.records.values()) {
            if (!visible.has(rec.id)) {
                continue;
            }
            if (rec.parentId && visible.has(rec.parentId)) {
                if (!children.has(rec.parentId)) {
                    children.set(rec.parentId, []);
                }
                children.get(rec.parentId).push(rec);
            } else {
                roots.push(rec);
            }
        }
        this.childrenOf = children;
        const rows = [];
        const pushTree = (recs, level, groupPath) => {
            for (const rec of this._sortRecords(recs)) {
                const kids = children.get(rec.id) || [];
                const key = `r:${rec.id}`;
                rows.push({ kind: "task", key, id: rec.id, rec, level, hasChildren: kids.length > 0, groupPath });
                if (kids.length && (!this.collapsed.has(key) || text)) {
                    pushTree(kids, level + 1, groupPath);
                }
            }
        };
        const groupFields = this.p.group_by || [];
        const pushGroups = (recs, depth, path) => {
            if (depth >= groupFields.length) {
                pushTree(recs, depth, path);
                return;
            }
            const fname = groupFields[depth];
            const buckets = new Map();
            for (const rec of recs) {
                const value = rec.groupValues[depth];
                const key = this._groupKey(value);
                if (!buckets.has(key)) {
                    buckets.set(key, { value, recs: [] });
                }
                buckets.get(key).recs.push(rec);
            }
            const entries = [...buckets.entries()].sort((a, b) => {
                if (a[0] === "false") {
                    return 1;
                }
                if (b[0] === "false") {
                    return -1;
                }
                return this._groupLabel(a[1].value, fname).localeCompare(this._groupLabel(b[1].value, fname));
            });
            for (const [key, bucket] of entries) {
                const gkey = `g:${path}/${fname}=${key}`;
                const all = this._descendantsOf(bucket.recs);
                rows.push({
                    kind: "group", key: gkey, level: depth, label: this._groupLabel(bucket.value, fname),
                    value: bucket.value, field: fname, records: all, count: all.length,
                    groupPath: `${path}/${fname}=${key}`,
                    defaults: this._groupDefaults(path, fname, bucket.value),
                });
                if (!this.collapsed.has(gkey) || text) {
                    pushGroups(bucket.recs, depth + 1, `${path}/${fname}=${key}`);
                }
            }
        };
        if (groupFields.length) {
            // group by the root records; children follow their parent
            pushGroups(roots, 0, "");
        } else {
            pushTree(roots, 0, "");
        }
        for (const row of rows) {
            if (row.kind === "group") {
                const scheduled = row.records.filter((r) => r.start !== null);
                row.start = scheduled.length ? Math.min(...scheduled.map((r) => r.start)) : null;
                row.stop = scheduled.length ? Math.max(...scheduled.map((r) => r.stop)) : null;
                row.progress = this.p.progress && scheduled.length ? actualProgress(scheduled) : null;
            }
        }
        rows.forEach((row, index) => (row.index = index));
        this.rows = rows;
        this.rowIndex = new Map(rows.filter((r) => r.kind === "task").map((r) => [r.id, r.index]));
    }

    _groupDefaults(path, fname, value) {
        const defaults = {};
        const meta = this.fields[fname] || {};
        if (value !== false && value !== null && value !== undefined) {
            if (meta.type === "many2one" && Array.isArray(value)) {
                defaults[`default_${fname}`] = value[0];
            } else if (meta.type === "many2many" && Array.isArray(value) && value.length) {
                defaults[`default_${fname}`] = [Array.isArray(value[0]) ? value[0][0] : value[0]];
            } else if (["selection", "char", "boolean", "integer"].includes(meta.type)) {
                defaults[`default_${fname}`] = value;
            }
        }
        return defaults;
    }

    _descendantsOf(recs) {
        const out = [];
        const stack = [...recs];
        while (stack.length) {
            const rec = stack.pop();
            out.push(rec);
            for (const kid of this.childrenOf.get(rec.id) || []) {
                stack.push(kid);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // axis
    // ------------------------------------------------------------------
    _planRange() {
        const scheduled = [...this.records.values()].filter((r) => r.start !== null);
        if (!scheduled.length) {
            return null;
        }
        return {
            start: Math.min(...scheduled.map((r) => r.start)),
            stop: Math.max(...scheduled.map((r) => r.stop)),
        };
    }

    _buildAxis(focusMs) {
        const scale = this.prefs.scale;
        const conf = SCALES[scale];
        const now = Date.now();
        const plan = this._planRange();
        let start = plan ? Math.min(plan.start, now) : now;
        let stop = plan ? Math.max(plan.stop, now) : now;
        for (const m of this.markers || []) {
            start = Math.min(start, m.ms);
            stop = Math.max(stop, m.ms);
        }
        const unit = { hour: "day", day: "month", week: "month", month: "year", quarter: "year", year: "year" }[scale];
        start = DateTime.fromMillis(start).minus(conf.pad).startOf(unit).toMillis();
        stop = DateTime.fromMillis(stop).plus(conf.pad).endOf(unit).toMillis();
        if (conf.unit === "hour" && stop - start > 360 * DAY) {
            // hours scale: keep a one year window around the focused date
            const center = focusMs || this._visibleCenter() || now;
            start = DateTime.fromMillis(center).minus({ days: 180 }).startOf("day").toMillis();
            stop = DateTime.fromMillis(center).plus({ days: 180 }).endOf("day").toMillis();
        }
        const hideDays = this.settings.hide_days_off && ["hour", "day", "week"].includes(scale);
        this.axis = buildAxis({ start, stop, scale, zoom: this.prefs.zoom, hiddenWeekdays: this.hiddenWeekdays, hideDays, hiddenDates: this.leaveDays });
    }

    _visibleCenter() {
        if (!this.axis || !this.chart.clientWidth) {
            return null;
        }
        return xToDate(this.axis, this.chart.scrollLeft + this.chart.clientWidth / 2);
    }

    x(ms) {
        return dateToX(this.axis, ms);
    }

    // ------------------------------------------------------------------
    // toolbar
    // ------------------------------------------------------------------
    _button(iconName, label, onClick, { title, active, disabled, className, text } = {}) {
        const btn = el("button", `btn btn-sm ${active ? "btn-primary" : "btn-light"} ${className || ""}`, {
            type: "button",
            title: title || label,
            "aria-label": title || label,
            disabled: disabled || undefined,
        });
        if (iconName) {
            btn.insertAdjacentHTML("beforeend", icon(iconName));
        }
        if (text) {
            btn.appendChild(el("span", "ms-1 d-none d-xl-inline", { text }));
        }
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onClick(ev);
        });
        return btn;
    }

    _menu(iconName, label, items, { className, text } = {}) {
        const wrap = el("div", "o_axs_gantt_menu_wrap position-relative");
        const toggle = this._button(iconName, label, () => {
            const open = !menu.classList.contains("show");
            this._closeMenus();
            menu.classList.toggle("show", open);
        }, { className: `o_axs_gantt_menu_toggle ${className || ""}`, text });
        const menu = el("div", "o_axs_gantt_menu dropdown-menu");
        for (const item of items) {
            if (item.separator) {
                menu.appendChild(el("div", "dropdown-divider"));
                continue;
            }
            if (item.header) {
                menu.appendChild(el("h6", "dropdown-header", { text: item.header }));
                continue;
            }
            const a = el("button", `dropdown-item ${item.active ? "active" : ""}`, { type: "button", "data-value": item.value });
            if (item.icon) {
                a.insertAdjacentHTML("beforeend", icon(item.icon, "o_axs_gantt_menu_icon me-2"));
            }
            a.appendChild(document.createTextNode(item.label));
            a.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this._closeMenus();
                item.action();
            });
            menu.appendChild(a);
        }
        wrap.append(toggle, menu);
        return wrap;
    }

    _closeMenus() {
        for (const menu of this.root.querySelectorAll(".o_axs_gantt_menu.show")) {
            menu.classList.remove("show");
        }
    }

    _renderToolbar() {
        const tb = this.toolbar;
        tb.innerHTML = "";
        const left = el("div", "o_axs_gantt_toolbar_group");
        if (this.access.create && this.arch.create) {
            left.appendChild(this._button("add", _t("Add"), () => this.createRecord({}), { className: "btn-primary o_axs_gantt_add", text: _t("Add") }));
            left.lastChild.classList.remove("btn-light");
        }
        left.appendChild(this._button("today", _t("Today"), () => this.scrollToDate(Date.now()), { text: _t("Today"), className: "o_axs_gantt_today_btn", title: _t("Scroll to today (T)") }));
        const labels = SCALE_LABELS();
        left.appendChild(this._menu("scale", _t("Scale"), SCALE_ORDER.map((s) => ({
            label: labels[s], value: s, active: s === this.prefs.scale, action: () => this.setScale(s),
        })), { text: labels[this.prefs.scale], className: "o_axs_gantt_scale_btn" }));
        const zoom = el("div", "btn-group");
        zoom.append(
            this._button("zoom_out", _t("Zoom out (-)"), () => this.setZoom(this.prefs.zoom / 1.4), { className: "o_axs_gantt_zoom_out" }),
            this._button("zoom_in", _t("Zoom in (+)"), () => this.setZoom(this.prefs.zoom * 1.4), { className: "o_axs_gantt_zoom_in" }),
            this._button("fit", _t("Zoom to fit (F)"), () => this.zoomToFit(), { className: "o_axs_gantt_fit" })
        );
        left.appendChild(zoom);

        const sortItems = [
            ["default", _t("Default order")],
            ["name_asc", _t("Name A to Z")],
            ["name_desc", _t("Name Z to A")],
            ["start_asc", _t("Start: old to new")],
            ["start_desc", _t("Start: new to old")],
            ["stop_asc", _t("End date")],
        ];
        if (this.p.progress) {
            sortItems.push(["progress_desc", _t("Progress")]);
        }
        left.appendChild(this._menu("sort", _t("Sort"), sortItems.map(([value, label]) => ({
            label, value, active: this.prefs.sort === value,
            action: () => {
                this.prefs.sort = value;
                this._savePrefs();
                this.refresh();
            },
        })), { className: "o_axs_gantt_sort_btn" }));

        const groupOptions = this.data.group_options || [];
        if (groupOptions.length) {
            const items = [{ label: _t("No grouping"), value: "", active: !(this.p.group_by || []).length, action: () => this.setGroupBy("") }];
            for (const g of groupOptions) {
                items.push({ label: g.string, value: g.name, active: (this.p.group_by || [])[0] === g.name, action: () => this.setGroupBy(g.name) });
            }
            items.push({ separator: true }, { label: _t("Expand all"), icon: "expand_all", action: () => this.expandAll() }, { label: _t("Collapse all"), icon: "collapse_all", action: () => this.collapseAll() });
            left.appendChild(this._menu("group", _t("Group"), items, { className: "o_axs_gantt_group_btn" }));
        } else if (this.p.parent_field) {
            left.appendChild(this._menu("tree", _t("Expand / collapse"), [
                { label: _t("Expand all"), icon: "expand_all", action: () => this.expandAll() },
                { label: _t("Collapse all"), icon: "collapse_all", action: () => this.collapseAll() },
            ]));
        }

        const right = el("div", "o_axs_gantt_toolbar_group ms-auto");
        const search = el("input", "form-control form-control-sm o_axs_gantt_search", { type: "search", placeholder: _t("Find a task..."), "aria-label": _t("Find a task") });
        search.value = this.searchText;
        search.addEventListener("input", () => {
            this.searchText = search.value;
            this._buildRows();
            this._updateLayout();
            this._scheduleRender(true);
        });
        right.appendChild(search);
        right.appendChild(this._button("undo", _t("Undo last change (Ctrl+Z)"), () => this.undo(), { disabled: !this.undoStack.length, className: "o_axs_gantt_undo" }));
        const toggles = el("div", "btn-group");
        toggles.append(
            this._button("grid", _t("Show/hide task list (G)"), () => this.toggle("gridVisible"), { active: this.prefs.gridVisible, className: "o_axs_gantt_toggle_grid" }),
            this._button("resources", _t("Resource panel (R)"), () => this.toggle("resourceVisible"), { active: this.prefs.resourceVisible, className: "o_axs_gantt_toggle_resources" }),
            this._button("critical", _t("Critical path (C)"), () => this.toggle("critical"), { active: this.prefs.critical, className: "o_axs_gantt_toggle_critical" }),
            this._button("overlay", _t("Progress overlay: planned (blue) vs actual (red)"), () => this.toggle("overlay"), { active: this.prefs.overlay, className: "o_axs_gantt_toggle_overlay", disabled: !this.p.progress }),
            this._button("markers", _t("Start/end markers"), () => this.toggle("markers"), { active: this.prefs.markers, className: "o_axs_gantt_toggle_markers" })
        );
        right.appendChild(toggles);
        const exportItems = [
            { label: _t("Excel (.xlsx)"), icon: "xlsx", value: "xlsx", action: () => this.exportAs("xlsx") },
            { label: _t("PDF"), icon: "pdf", value: "pdf", action: () => this.exportAs("pdf") },
            { label: _t("Image (.png)"), icon: "png", value: "png", action: () => this.exportAs("png") },
            { label: _t("JSON"), icon: "code", value: "json", action: () => this.exportAs("json") },
            { label: _t("XML (MS Project)"), icon: "code", value: "xml", action: () => this.exportAs("xml") },
            { label: _t("Primavera P6 (.xer)"), icon: "text", value: "xer", action: () => this.exportAs("xer") },
            { label: _t("iCal (.ics)"), icon: "ics", value: "ics", action: () => this.exportAs("ics") },
        ];
        if (this.arch.import && this.access.create) {
            exportItems.push({ separator: true }, { label: _t("Import Excel / JSON"), icon: "import", value: "import", action: () => this.openImport() });
        }
        right.appendChild(this._menu("export", _t("Export / Import"), exportItems, { className: "o_axs_gantt_export_btn" }));
        right.appendChild(this._button(document.fullscreenElement === this.root ? "fullscreen_exit" : "fullscreen", _t("Full screen"), () => this.toggleFullscreen(), { className: "o_axs_gantt_fullscreen_btn" }));
        if (this.settings.is_admin) {
            right.appendChild(this._button("settings", _t("Gantt settings"), () => this.openSettings(), { className: "o_axs_gantt_settings_btn" }));
        }
        tb.append(left, right);
    }

    // ------------------------------------------------------------------
    // public actions
    // ------------------------------------------------------------------
    refresh() {
        this._computeCritical();
        this._buildRows();
        this._renderToolbar();
        this._renderGridHeader();
        this._updateLayout();
        this._scheduleRender(true);
        this._renderStatus();
    }

    setScale(scale) {
        const center = this._visibleCenter();
        this.prefs.scale = scale;
        this.prefs.zoom = 1;
        this._savePrefs();
        this._buildAxis(center);
        this._renderToolbar();
        this._updateLayout();
        this.scrollToDate(center || Date.now(), true);
        this._scheduleRender(true);
    }

    setZoom(zoom) {
        const center = this._visibleCenter();
        this.prefs.zoom = Math.max(0.2, Math.min(6, zoom));
        this._savePrefs();
        this._buildAxis(center);
        this._updateLayout();
        this.scrollToDate(center || Date.now(), true);
        this._scheduleRender(true);
    }

    zoomToFit() {
        const plan = this._planRange();
        if (!plan) {
            this.scrollToDate(Date.now());
            return;
        }
        const span = Math.max(plan.stop - plan.start, DAY);
        // keep room on the right for the labels drawn after the last bars
        const available = Math.max(this.chart.clientWidth - 180, 200);
        // pick the finest scale where the plan fits while labels stay readable (zoom >= 0.8)
        let chosen = "year";
        let zoom = 1;
        for (const scale of SCALE_ORDER) {
            const conf = SCALES[scale];
            const unitMs = conf.unit === "hour" ? HOUR : DAY;
            const width = (span / unitMs) * conf.width;
            const z = available / width;
            if (z >= 0.8 && (scale !== "hour" || span <= 20 * DAY)) {
                chosen = scale;
                zoom = Math.min(z, 6);
                break;
            }
        }
        if (chosen === "year") {
            const width = (span / DAY) * SCALES.year.width;
            zoom = Math.max(0.2, Math.min(6, available / width));
        }
        this.prefs.scale = chosen;
        this.prefs.zoom = zoom;
        this._savePrefs();
        this._buildAxis((plan.start + plan.stop) / 2);
        this._renderToolbar();
        this._updateLayout();
        this.chart.scrollLeft = Math.max(0, this.x(plan.start) - 30);
        this._scheduleRender(true);
    }

    scrollToDate(ms, center = true) {
        if (!this.axis) {
            return;
        }
        if (ms < this.axis.start || ms > this.axis.stop) {
            this._buildAxis(ms);
            this._updateLayout();
        }
        const x = this.x(ms);
        this.chart.scrollLeft = Math.max(0, center ? x - this.chart.clientWidth / 3 : x);
        this._scheduleRender(true);
    }

    toggle(pref) {
        this.prefs[pref] = !this.prefs[pref];
        this._savePrefs();
        if (pref === "critical") {
            this._computeCritical();
        }
        this._renderToolbar();
        this._updateLayout();
        this._scheduleRender(true);
        this._renderStatus();
    }

    setGroupBy(fname) {
        this.groupOverride = fname;
        this.prefs.groupBy = fname;
        this._savePrefs();
        this.load();
    }

    expandAll() {
        this.collapsed.clear();
        this._savePrefs();
        this.refresh();
    }

    collapseAll() {
        for (const row of this.rows) {
            if (row.kind === "group" || row.hasChildren) {
                this.collapsed.add(row.key);
            }
        }
        // collapsed parents may hide other parents: add every parent key
        for (const [parentId] of this.childrenOf || []) {
            this.collapsed.add(`r:${parentId}`);
        }
        this._savePrefs();
        this.refresh();
    }

    toggleFullscreen() {
        if (document.fullscreenElement === this.root) {
            document.exitFullscreen?.();
        } else if (this.root.requestFullscreen) {
            this.root.requestFullscreen().catch(() => {
                this.root.classList.toggle("o_axs_gantt_fullscreen");
                this._scheduleRender(true);
            });
        } else {
            this.root.classList.toggle("o_axs_gantt_fullscreen");
        }
        setTimeout(() => this._renderToolbar(), 300);
    }

    _formContext(extra) {
        const ctx = Object.assign({}, this.context, extra || {});
        for (const key of Object.keys(ctx)) {
            if (key.startsWith("search_default_") || key === "group_by") {
                delete ctx[key];
            }
        }
        return ctx;
    }

    _doAction(action) {
        return this.services.action.doAction(action, { onClose: () => this.load() });
    }

    createRecord(defaults, startMs) {
        const ctx = {};
        if (startMs !== undefined && startMs !== null) {
            const stop = this.allDay ? startMs + DAY : shiftMs(startMs, { days: 1 });
            ctx[`default_${this.p.date_start}`] = serializeStart(startMs, this.startType);
            if (this.p.date_stop) {
                ctx[`default_${this.p.date_stop}`] = serializeStop(stop, this.stopType);
            }
        }
        return this._doAction({
            type: "ir.actions.act_window",
            res_model: this.resModel,
            views: [[this.arch.formViewId || false, "form"]],
            target: "new",
            context: this._formContext(Object.assign(ctx, defaults)),
        });
    }

    openRecord(id) {
        this._closePopover();
        this._hideTooltip();
        return this._doAction({
            type: "ir.actions.act_window",
            res_model: this.resModel,
            res_id: id,
            views: [[this.arch.formViewId || false, "form"]],
            target: "new",
            context: this._formContext(),
        });
    }

    async deleteRecord(id) {
        const rec = this.records.get(id);
        const ok = await this.confirm(fmt(_t("Delete \"%s\"? This cannot be undone."), rec ? rec.name : id), _t("Delete"));
        if (!ok) {
            return;
        }
        await this.services.orm.unlink(this.resModel, [id]);
        this._notify(_t("Record deleted."), "success");
        await this.load();
    }

    openSettings() {
        return this.services.action.doAction("axs_gantt_view.action_axs_gantt_settings");
    }

    openImport() {
        return this._doAction({
            type: "ir.actions.act_window",
            res_model: "axs.gantt.import",
            name: _t("Import Tasks"),
            views: [[false, "form"]],
            target: "new",
            context: {
                default_res_model: this.resModel,
                default_params_json: JSON.stringify(this.params),
                default_context_json: JSON.stringify(this._formContext()),
            },
        });
    }

    async toggleUnscheduled(id, unschedule) {
        const rec = this.records.get(id);
        if (!rec) {
            return;
        }
        if (unschedule) {
            await this.services.orm.write(this.resModel, [id], { axs_unscheduled: true });
        } else {
            const start = rec.origStart ?? DateTime.now().startOf("day").toMillis();
            const stop = rec.origStop ?? shiftMs(start, { days: 1 });
            await this._commitMove(rec, start, stop);
            return;
        }
        await this.load();
    }

    confirm(message, confirmLabel) {
        return new Promise((resolve) => {
            const backdrop = el("div", "o_axs_gantt_modal_backdrop");
            const modal = el("div", "o_axs_gantt_modal", { role: "dialog" });
            modal.appendChild(el("p", "mb-3", { text: message }));
            const buttons = el("div", "d-flex gap-2 justify-content-end");
            const cancel = el("button", "btn btn-secondary", { type: "button", text: _t("Cancel") });
            const ok = el("button", "btn btn-danger o_axs_gantt_confirm", { type: "button", text: confirmLabel || _t("Ok") });
            buttons.append(cancel, ok);
            modal.appendChild(buttons);
            backdrop.appendChild(modal);
            this.root.appendChild(backdrop);
            const close = (value) => {
                backdrop.remove();
                resolve(value);
            };
            cancel.addEventListener("click", () => close(false));
            ok.addEventListener("click", () => close(true));
            backdrop.addEventListener("click", (ev) => ev.target === backdrop && close(false));
            ok.focus();
        });
    }

    _notify(message, type = "info") {
        this.services.notification.add(message, { type });
    }

    _error(error) {
        const message = error?.data?.message || error?.message || String(error);
        this._notify(message, "danger");
    }

    // ------------------------------------------------------------------
    // layout & rendering
    // ------------------------------------------------------------------
    _updateLayout() {
        if (!this.axis) {
            return;
        }
        const gridVisible = this.prefs.gridVisible;
        this.grid.classList.toggle("d-none", !gridVisible);
        this.splitter.classList.toggle("d-none", !gridVisible);
        this.grid.style.width = `${this.prefs.gridWidth}px`;
        const height = Math.max(this.rows.length * ROW_HEIGHT, 1);
        this.canvas.style.width = `${this.axis.width}px`;
        this.canvas.style.height = `${height}px`;
        this.header.style.width = `${this.axis.width}px`;
        this.gridInner.style.height = `${height}px`;
        this.linkLayer.setAttribute("width", this.axis.width);
        this.linkLayer.setAttribute("height", height);
        this.resourcePanel.classList.toggle("d-none", !this.prefs.resourceVisible || !this.p.resource);
        const isEmpty = !this.records.size;
        this.empty.classList.toggle("d-none", !isEmpty);
        if (isEmpty) {
            this.empty.innerHTML = "";
            this.empty.append(
                el("div", "mb-3 text-muted o_axs_gantt_empty_icon", { html: icon("gantt", "fs-1") }),
                el("h4", "", { text: _t("Nothing to plan yet") }),
                el("p", "text-muted", { text: _t("No record matches the current filters. Create one or change the search.") })
            );
            if (this.access.create && this.arch.create) {
                this.empty.appendChild(this._button("add", _t("Add"), () => this.createRecord({}), { text: _t("Add"), className: "btn-primary" }));
            }
        }
    }

    _scheduleRender(full = false) {
        if (full) {
            this._fullRender = true;
        }
        if (this._raf) {
            return;
        }
        this._raf = requestAnimationFrame(() => {
            this._raf = null;
            if (this._destroyed || !this.axis) {
                return;
            }
            this._render(this._fullRender);
            this._fullRender = false;
        });
    }

    _onScroll() {
        this.gridRows.scrollTop = this.chart.scrollTop;
        if (this.resourceTimeline) {
            this.resourceTimeline.style.transform = `translateX(${-this.chart.scrollLeft}px)`;
        }
        this._hideTooltip();
        this._scheduleRender();
    }

    _viewport() {
        const top = this.chart.scrollTop;
        const height = this.chart.clientHeight - HEADER_H;
        const left = this.chart.scrollLeft;
        const width = this.chart.clientWidth;
        const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 8);
        const last = Math.min(this.rows.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + 8);
        return { top, height, left, width, first, last, x0: left - 300, x1: left + width + 300 };
    }

    _render(full) {
        const vp = this._viewport();
        const key = `${vp.first}:${vp.last}:${Math.floor(vp.x0 / 400)}`;
        if (!full && key === this._lastRenderKey) {
            return;
        }
        this._lastRenderKey = key;
        this._renderHeader(vp);
        this._renderBackground(vp);
        this._renderGridRows(vp);
        this._renderBars(vp);
        this._renderLinks(vp);
        this._renderOverlay(vp);
        if (this.prefs.resourceVisible && this.p.resource) {
            this._renderResources(vp, full);
        }
    }

    _renderHeader(vp) {
        this.headerTop.innerHTML = "";
        this.headerBottom.innerHTML = "";
        for (const g of visibleSlice(this.axis.top, vp.x0, vp.x1)) {
            const cell = el("div", "o_axs_gantt_hcell", { style: `left:${g.x}px;width:${g.w}px` });
            const label = el("span", "o_axs_gantt_hlabel", { text: g.label });
            // keep the label of long periods visible while scrolling
            const offset = Math.max(0, Math.min(vp.left - g.x, g.w - 120));
            label.style.marginLeft = `${offset}px`;
            cell.appendChild(label);
            this.headerTop.appendChild(cell);
        }
        const todayKey = dayKey(Date.now());
        for (const g of visibleSlice(this.axis.bottom, vp.x0, vp.x1)) {
            const text = g.w >= 90 ? g.label : g.w >= 26 ? g.short : "";
            const cell = el("div", "o_axs_gantt_hcell", { style: `left:${g.x}px;width:${g.w}px`, text, title: g.label });
            if (["day", "hour"].includes(this.prefs.scale)) {
                const weekday = DateTime.fromMillis(g.start).weekday - 1;
                if (this.prefs.scale === "day" && (!this.workdays.has(weekday) || this.leaveDays.has(dayKey(g.start)))) {
                    cell.classList.add("o_axs_gantt_off");
                }
                if (this.prefs.scale === "day" && dayKey(g.start) === todayKey) {
                    cell.classList.add("o_axs_gantt_hcell_today");
                }
            }
            this.headerBottom.appendChild(cell);
        }
    }

    _isOffCell(cell) {
        return !this.workdays.has(cell.weekday) || this.leaveDays.has(dayKey(cell.start));
    }

    _renderBackground(vp) {
        const bg = this.bg;
        bg.innerHTML = "";
        const height = Math.max(this.rows.length * ROW_HEIGHT, this.chart.clientHeight);
        bg.style.height = `${height}px`;
        // vertical lines on bottom header cells
        for (const g of visibleSlice(this.axis.bottom, vp.x0, vp.x1)) {
            bg.appendChild(el("div", "o_axs_gantt_vline", { style: `left:${g.x + g.w - 1}px` }));
        }
        // days off
        if (this.settings.days_off) {
            const dayCells = this.prefs.scale === "hour" ? this._dayCellsFromHours(vp) : visibleSlice(this.axis.cells, vp.x0, vp.x1);
            let current = null;
            for (const cell of dayCells) {
                if (!cell.w) {
                    continue;
                }
                const off = this._isOffCell(cell);
                if (off) {
                    if (current && Math.abs(current.x + current.w - cell.x) < 0.5) {
                        current.w += cell.w;
                        if (this.leaveDays.has(dayKey(cell.start))) {
                            current.title = this.leaveDays.get(dayKey(cell.start));
                        }
                    } else {
                        current = { x: cell.x, w: cell.w, title: this.leaveDays.get(dayKey(cell.start)) || "" };
                        bg.appendChild(current.node = el("div", "o_axs_gantt_dayoff", { title: current.title }));
                    }
                    current.node.style.left = `${current.x}px`;
                    current.node.style.width = `${Math.max(current.w, 1)}px`;
                } else {
                    current = null;
                }
            }
        }
        // group row backgrounds + selection
        for (let i = vp.first; i <= vp.last; i++) {
            const row = this.rows[i];
            if (!row) {
                continue;
            }
            if (row.kind === "group") {
                bg.appendChild(el("div", "o_axs_gantt_bg_group", { style: `top:${i * ROW_HEIGHT}px` }));
            } else if (row.id === this.selectedId) {
                bg.appendChild(el("div", "o_axs_gantt_bg_selected", { style: `top:${i * ROW_HEIGHT}px` }));
            }
        }
        // today line
        const todayX = this.x(Date.now());
        bg.appendChild(el("div", "o_axs_gantt_today", { style: `left:${todayX}px`, title: _t("Today") }));
        // markers
        if (this.prefs.markers) {
            let markers = this.markers;
            if (!markers.length) {
                const plan = this._planRange();
                markers = plan ? [
                    { ms: plan.start, label: _t("Plan start"), kind: "start" },
                    { ms: plan.stop, label: _t("Plan end"), kind: "end" },
                ] : [];
            }
            for (const m of markers) {
                const x = this.x(m.ms);
                const title = `${m.label} - ${formatDate(m.ms, false)}`;
                bg.appendChild(el("div", `o_axs_gantt_marker o_axs_gantt_marker_${m.kind || "start"}`, { style: `left:${x}px`, title }));
                if (x > vp.x0 && x < vp.x1) {
                    this.headerBottom.appendChild(el("span", `o_axs_gantt_marker_label o_axs_gantt_marker_label_${m.kind || "start"}`, { style: `left:${x}px`, text: m.label, title }));
                }
            }
        }
    }

    _dayCellsFromHours(vp) {
        const cells = [];
        for (const g of visibleSlice(this.axis.top, vp.x0, vp.x1)) {
            const dt = DateTime.fromMillis(g.start);
            cells.push({ start: g.start, end: g.end, x: g.x, w: g.w, weekday: dt.weekday - 1 });
        }
        return cells;
    }

    _renderGridHeader() {
        const h = this.gridHeader;
        h.innerHTML = "";
        const cols = this._gridColumns();
        const row = el("div", "o_axs_gantt_grid_hrow");
        for (const col of cols) {
            row.appendChild(el("div", `o_axs_gantt_gcell o_axs_gantt_gcol_${col.key}`, { text: col.label, style: col.width ? `flex:0 0 ${col.width}px` : "", title: col.label }));
        }
        h.appendChild(row);
    }

    _gridColumns() {
        const cols = [{ key: "name", label: this.arch.string || _t("Name") }];
        cols.push({ key: "start", label: _t("Start"), width: 88 });
        cols.push({ key: "stop", label: _t("End"), width: 88 });
        cols.push({ key: "duration", label: _t("Duration"), width: 62 });
        if (this.p.progress) {
            cols.push({ key: "progress", label: "%", width: 50 });
        }
        for (const f of this.arch.fields.filter((f) => f.column)) {
            if (this.fields[f.name]) {
                cols.push({ key: `f_${f.name}`, field: f.name, label: f.string || this.fields[f.name].string, width: f.width || 100 });
            }
        }
        return cols;
    }

    _formatField(value, fname) {
        const meta = this.fields[fname] || {};
        if (value === false || value === null || value === undefined) {
            return "";
        }
        switch (meta.type) {
            case "many2one":
                return Array.isArray(value) ? value[1] : String(value);
            case "many2many":
            case "one2many":
                return Array.isArray(value) ? value.map((v) => (Array.isArray(v) ? v[1] : v)).join(", ") : "";
            case "selection": {
                const found = (meta.selection || []).find((s) => s[0] === value);
                return found ? found[1] : String(value);
            }
            case "boolean":
                return value ? "✓" : "";
            case "date":
                return formatDate(parseServerValue(value, "date"), false);
            case "datetime":
                return formatDate(parseServerValue(value, "datetime"), true);
            case "float":
            case "monetary":
                return (Math.round(value * 100) / 100).toLocaleString();
            default:
                return String(value);
        }
    }

    _progressClass(progress) {
        if (progress === null || progress === undefined) {
            return "";
        }
        if (progress >= 100) {
            return "o_axs_gantt_status_done";
        }
        if (progress <= 0) {
            return "o_axs_gantt_status_todo";
        }
        return "o_axs_gantt_status_doing";
    }

    _renderGridRows(vp) {
        const inner = this.gridInner;
        inner.innerHTML = "";
        const cols = this._gridColumns();
        for (let i = vp.first; i <= vp.last; i++) {
            const row = this.rows[i];
            if (!row) {
                continue;
            }
            const node = el("div", `o_axs_gantt_row o_axs_gantt_row_${row.kind}`, { style: `top:${i * ROW_HEIGHT}px`, "data-key": row.key });
            if (row.kind === "task") {
                node.dataset.recordId = row.id;
                if (row.id === this.selectedId) {
                    node.classList.add("o_axs_gantt_row_selected");
                }
            }
            for (const col of cols) {
                const cell = el("div", `o_axs_gantt_gcell o_axs_gantt_gcol_${col.key}`, { style: col.width ? `flex:0 0 ${col.width}px` : "" });
                if (col.key === "name") {
                    cell.style.paddingLeft = `${6 + row.level * 16}px`;
                    const expandable = row.kind === "group" || row.hasChildren;
                    const caret = el("span", `o_axs_gantt_caret ${expandable ? "" : "invisible"}`);
                    caret.insertAdjacentHTML("beforeend", icon(this.collapsed.has(row.key) ? "caret_right" : "caret_down"));
                    cell.appendChild(caret);
                    if (row.kind === "task") {
                        const progressCls = this._progressClass(row.rec.progress);
                        if (progressCls) {
                            cell.appendChild(el("span", `o_axs_gantt_dot ${progressCls}`, { title: fmt(_t("Progress: %s%"), Math.round(row.rec.progress)) }));
                        }
                        if (row.rec.milestone) {
                            cell.appendChild(el("span", "text-muted me-1", { title: _t("Milestone"), html: icon("milestone") }));
                        }
                        cell.appendChild(el("span", "o_axs_gantt_name", { text: row.rec.name, title: row.rec.name }));
                        if (row.rec.unscheduled || row.rec.start === null) {
                            cell.appendChild(el("span", "text-muted ms-1 o_axs_gantt_unscheduled_badge", { title: _t("Unscheduled: click on the timeline row to schedule it"), html: icon("unschedule") }));
                        }
                    } else {
                        cell.appendChild(el("span", "o_axs_gantt_name fw-bold", { text: row.label }));
                        cell.appendChild(el("span", "badge rounded-pill text-bg-light bg-light text-dark ms-1", { text: String(row.count) }));
                    }
                    const actions = el("span", "o_axs_gantt_row_actions");
                    if (row.kind === "task") {
                        if (this.p.parent_field && this.access.create && this.arch.create) {
                            actions.appendChild(el("button", "btn btn-link btn-sm o_axs_gantt_add_child", { type: "button", title: _t("Add a sub-task"), "data-action": "child", html: icon("add") }));
                        }
                        actions.appendChild(el("button", "btn btn-link btn-sm o_axs_gantt_edit", { type: "button", title: _t("Edit"), "data-action": "edit", html: icon("edit") }));
                        if (this.access.unlink && this.arch.delete) {
                            actions.appendChild(el("button", "btn btn-link btn-sm o_axs_gantt_delete", { type: "button", title: _t("Delete"), "data-action": "delete", html: icon("delete") }));
                        }
                    } else if (this.access.create && this.arch.create) {
                        actions.appendChild(el("button", "btn btn-link btn-sm o_axs_gantt_add_in_group", { type: "button", title: _t("Add in this group"), "data-action": "group_add", html: icon("add") }));
                    }
                    cell.appendChild(actions);
                } else if (row.kind === "task") {
                    const rec = row.rec;
                    let text = "";
                    switch (col.key) {
                        case "start":
                            text = rec.start === null ? "" : formatDate(rec.start, !this.allDay && this.prefs.scale === "hour");
                            break;
                        case "stop":
                            text = rec.stop === null ? "" : formatDate(this.allDay ? rec.stop - 1 : rec.stop, !this.allDay && this.prefs.scale === "hour");
                            break;
                        case "duration":
                            text = rec.start === null ? "" : rec.milestone ? "-" : formatDuration(rec.stop - rec.start, this.hoursPerDay, this.allDay);
                            break;
                        case "progress":
                            text = rec.progress === null ? "" : `${Math.round(rec.progress)}%`;
                            break;
                        default:
                            text = this._formatField(rec.raw[col.field], col.field);
                    }
                    cell.textContent = text;
                    cell.title = text;
                } else if (row.kind === "group") {
                    if (col.key === "start" && row.start !== null) {
                        cell.textContent = formatDate(row.start, false);
                    } else if (col.key === "stop" && row.stop !== null) {
                        cell.textContent = formatDate(this.allDay ? row.stop - 1 : row.stop, false);
                    } else if (col.key === "progress" && row.progress !== null) {
                        cell.textContent = `${Math.round(row.progress)}%`;
                    } else if (col.key === "duration" && row.start !== null) {
                        cell.textContent = formatDuration(row.stop - row.start, this.hoursPerDay, true);
                    }
                }
                node.appendChild(cell);
            }
            inner.appendChild(node);
        }
    }

    _onGridClick(ev) {
        const rowNode = ev.target.closest(".o_axs_gantt_row");
        if (!rowNode) {
            return;
        }
        const row = this.rows.find((r) => r.key === rowNode.dataset.key);
        if (!row) {
            return;
        }
        const button = ev.target.closest("button[data-action]");
        if (button) {
            const action = button.dataset.action;
            if (action === "edit") {
                this.openRecord(row.id);
            } else if (action === "delete") {
                this.deleteRecord(row.id).catch((e) => this._error(e));
            } else if (action === "child") {
                const defaults = { [`default_${this.p.parent_field}`]: row.id };
                Object.assign(defaults, this._defaultsForRecordGroup(row));
                const start = row.rec.start ?? undefined;
                this.createRecord(defaults, start);
            } else if (action === "group_add") {
                this.createRecord(this._collectGroupDefaults(row));
            }
            return;
        }
        if (ev.target.closest(".o_axs_gantt_caret") || row.kind === "group") {
            if (row.kind === "group" || row.hasChildren) {
                if (this.collapsed.has(row.key)) {
                    this.collapsed.delete(row.key);
                } else {
                    this.collapsed.add(row.key);
                }
                this._savePrefs();
                this._buildRows();
                this._updateLayout();
                this._scheduleRender(true);
            }
            return;
        }
        this.selectedId = row.id;
        if (row.rec.start !== null) {
            const x = this.x(row.rec.start);
            if (x < this.chart.scrollLeft || x > this.chart.scrollLeft + this.chart.clientWidth - 60) {
                this.chart.scrollLeft = Math.max(0, x - 80);
            }
        }
        this._scheduleRender(true);
    }

    _collectGroupDefaults(row) {
        // defaults of the group and all its parent groups
        const defaults = {};
        for (const r of this.rows) {
            if (r.kind === "group" && row.groupPath.startsWith(r.groupPath)) {
                Object.assign(defaults, r.defaults);
            }
        }
        return defaults;
    }

    _defaultsForRecordGroup(row) {
        const group = this.rows.find((r) => r.kind === "group" && r.groupPath === row.groupPath);
        return group ? this._collectGroupDefaults(group) : {};
    }

    _barColor(rec) {
        if (this.settings.stage_color && this.p.color) {
            const color = colorFor(rec.color);
            if (color) {
                return color;
            }
        }
        return PALETTE[0];
    }

    _barGeometry(rec, index) {
        const x1 = this.x(rec.start);
        const x2 = this.x(rec.stop);
        return { x: x1, w: Math.max(x2 - x1, 4), y: index * ROW_HEIGHT + BAR_PAD, h: ROW_HEIGHT - 2 * BAR_PAD };
    }

    _renderBars(vp) {
        const layer = this.bars;
        layer.innerHTML = "";
        const canWrite = this.access.write && this.arch.edit;
        const progressWritable = canWrite && this.p.progress && !this.fields[this.p.progress]?.readonly;
        const startWritable = canWrite && !this.fields[this.p.date_start]?.readonly;
        const stopWritable = startWritable && (!this.p.date_stop || !this.fields[this.p.date_stop]?.readonly);
        for (let i = vp.first; i <= vp.last; i++) {
            const row = this.rows[i];
            if (!row) {
                continue;
            }
            if (row.kind === "group") {
                if (row.start === null) {
                    continue;
                }
                const g = this._barGeometry({ start: row.start, stop: row.stop }, i);
                if (g.x > vp.x1 || g.x + g.w < vp.x0) {
                    continue;
                }
                const bar = el("div", "o_axs_gantt_summary", { style: `left:${g.x}px;width:${g.w}px;top:${i * ROW_HEIGHT + 12}px`, title: row.label });
                if (row.progress !== null) {
                    bar.appendChild(el("div", "o_axs_gantt_summary_progress", { style: `width:${Math.min(100, row.progress)}%` }));
                }
                layer.appendChild(bar);
                continue;
            }
            const rec = row.rec;
            if (rec.start === null) {
                if (canWrite) {
                    layer.appendChild(el("div", "o_axs_gantt_unscheduled_hint", { style: `top:${i * ROW_HEIGHT}px;left:${vp.left}px;width:${vp.width}px`, "data-id": rec.id, title: _t("Click on the timeline to schedule this record") }));
                }
                continue;
            }
            const g = this._barGeometry(rec, i);
            if (rec.deadline) {
                const dx = this.x(rec.deadline);
                if (dx > vp.x0 && dx < vp.x1) {
                    layer.appendChild(el("div", `o_axs_gantt_deadline ${rec.stop > rec.deadline ? "o_axs_gantt_deadline_missed" : ""}`, { style: `left:${dx}px;top:${i * ROW_HEIGHT + 3}px`, title: fmt(_t("Deadline: %s"), formatDate(rec.deadline - (this.fields[this.p.deadline]?.type === "date" ? 1 : 0), this.fields[this.p.deadline]?.type !== "date")) }));
                }
            }
            if (rec.constraintType && rec.constraintType !== "asap" && rec.constraintDate) {
                const cx = this.x(rec.constraintDate);
                if (cx > vp.x0 && cx < vp.x1) {
                    const violated = this._constraintViolated(rec);
                    layer.appendChild(el("div", `o_axs_gantt_constraint ${violated ? "o_axs_gantt_constraint_violated" : ""}`, { style: `left:${cx}px;top:${i * ROW_HEIGHT + 2}px`, title: `${CONSTRAINT_LABELS()[rec.constraintType]}: ${formatDate(rec.constraintDate)}`, html: icon("pin") }));
                }
            }
            const textWidth = rec.name.length * 6.5 + 16;
            if (g.x > vp.x1 || g.x + g.w + textWidth < vp.x0) {
                continue;
            }
            const critical = this.prefs.critical && this.critical.tasks.has(rec.id);
            const color = this._barColor(rec);
            if (rec.milestone) {
                const ms = el("div", `o_axs_gantt_bar o_axs_gantt_milestone ${critical ? "o_axs_gantt_critical" : ""} ${rec.id === this.selectedId ? "o_axs_gantt_selected" : ""}`, { style: `left:${g.x - 9}px;top:${i * ROW_HEIGHT + 8}px;--axs-bar-color:${color}`, "data-id": rec.id });
                ms.appendChild(el("div", "o_axs_gantt_milestone_shape"));
                if (startWritable) {
                    ms.classList.add("o_axs_gantt_draggable");
                }
                ms.appendChild(el("span", "o_axs_gantt_label o_axs_gantt_label_out", { text: rec.name }));
                this._appendLinkHandles(ms, canWrite);
                layer.appendChild(ms);
                continue;
            }
            const bar = el("div", `o_axs_gantt_bar ${critical ? "o_axs_gantt_critical" : ""} ${rec.id === this.selectedId ? "o_axs_gantt_selected" : ""} ${row.hasChildren ? "o_axs_gantt_parent" : ""}`, {
                style: `left:${g.x}px;width:${g.w}px;top:${g.y}px;height:${g.h}px;--axs-bar-color:${color}`,
                "data-id": rec.id,
            });
            if (rec.deadline && rec.stop > rec.deadline) {
                bar.classList.add("o_axs_gantt_late");
            }
            if (startWritable) {
                bar.classList.add("o_axs_gantt_draggable");
            }
            if (rec.progress !== null) {
                bar.appendChild(el("div", "o_axs_gantt_bar_progress", { style: `width:${Math.max(0, Math.min(100, rec.progress))}%` }));
            }
            let label = rec.name;
            if (this.settings.dynamic_progress && rec.progress !== null) {
                label = `${rec.name} · ${Math.round(rec.progress)}%`;
            }
            const labelWidth = label.length * 6.5 + 12;
            const outside = this.settings.dynamic_text && labelWidth > g.w;
            bar.appendChild(el("span", `o_axs_gantt_label ${outside ? "o_axs_gantt_label_out" : ""}`, { text: outside || labelWidth <= g.w ? label : "" }));
            if (startWritable && g.w >= 14) {
                bar.appendChild(el("div", "o_axs_gantt_handle o_axs_gantt_handle_start", { "data-drag": "resize-start", title: _t("Drag to change the start") }));
            }
            if (stopWritable && g.w >= 14 && this.p.date_stop) {
                bar.appendChild(el("div", "o_axs_gantt_handle o_axs_gantt_handle_end", { "data-drag": "resize-end", title: _t("Drag to change the end") }));
            }
            if (progressWritable && g.w >= 30) {
                bar.appendChild(el("div", "o_axs_gantt_progress_handle", { "data-drag": "progress", style: `left:${Math.max(0, Math.min(100, rec.progress || 0))}%`, title: _t("Drag to change the progress") }));
            }
            this._appendLinkHandles(bar, canWrite);
            layer.appendChild(bar);
        }
    }

    _appendLinkHandles(bar, canWrite) {
        if (!canWrite) {
            return;
        }
        bar.appendChild(el("div", "o_axs_gantt_link_handle o_axs_gantt_link_handle_start", { "data-drag": "link-start", title: _t("Drag to another task to create a dependency") }));
        bar.appendChild(el("div", "o_axs_gantt_link_handle o_axs_gantt_link_handle_end", { "data-drag": "link-end", title: _t("Drag to another task to create a dependency") }));
    }

    _constraintViolated(rec) {
        if (!rec.constraintDate || rec.start === null) {
            return false;
        }
        const d = rec.constraintDate;
        const tol = 60000;
        switch (rec.constraintType) {
            case "snet":
                return rec.start < d - tol;
            case "snlt":
                return rec.start > d + tol;
            case "fnet":
                return rec.stop < d - tol;
            case "fnlt":
                return rec.stop > d + tol;
            case "mso":
                return Math.abs(rec.start - d) > tol;
            case "mfo":
                return Math.abs(rec.stop - d) > tol;
            default:
                return false;
        }
    }

    _anchor(rec, side) {
        const index = this.rowIndex.get(rec.id);
        if (index === undefined || rec.start === null) {
            return null;
        }
        const y = index * ROW_HEIGHT + ROW_HEIGHT / 2;
        if (rec.milestone) {
            return { x: this.x(rec.start) + (side === "start" ? -9 : 9), y };
        }
        return { x: this.x(side === "start" ? rec.start : rec.stop), y };
    }

    _linkPath(a, b, fromSide, toSide) {
        const out = fromSide === "end" ? 1 : -1;
        const into = toSide === "start" ? 1 : -1;
        const gap = 10;
        const p1x = a.x + out * gap;
        const p2x = b.x - into * gap;
        if ((into === 1 && p1x <= p2x) || (into === -1 && p1x >= p2x)) {
            const mx = into === 1 ? Math.max(p1x, Math.min(p2x, p1x)) : Math.min(p1x, p2x);
            return `M ${a.x} ${a.y} H ${mx} V ${b.y} H ${b.x}`;
        }
        const midY = b.y > a.y ? a.y + ROW_HEIGHT / 2 : a.y - ROW_HEIGHT / 2;
        return `M ${a.x} ${a.y} H ${p1x} V ${midY} H ${p2x} V ${b.y} H ${b.x}`;
    }

    _renderLinks(vp) {
        const group = this.linkGroup;
        group.innerHTML = "";
        const sides = { fs: ["end", "start"], ss: ["start", "start"], ff: ["end", "end"], sf: ["start", "end"] };
        for (const link of this.links) {
            const s = this.records.get(link.source);
            const t = this.records.get(link.target);
            const si = this.rowIndex.get(link.source);
            const ti = this.rowIndex.get(link.target);
            if (si === undefined || ti === undefined) {
                continue;
            }
            if ((si < vp.first && ti < vp.first) || (si > vp.last && ti > vp.last)) {
                continue;
            }
            const [from, to] = sides[link.type] || sides.fs;
            const a = this._anchor(s, from);
            const b = this._anchor(t, to);
            if (!a || !b) {
                continue;
            }
            if (Math.max(a.x, b.x) < vp.x0 || Math.min(a.x, b.x) > vp.x1) {
                continue;
            }
            const d = this._linkPath(a, b, from, to);
            const critical = this.prefs.critical && this.critical.links.has(link.id);
            const selected = this._selectedLink === link.id;
            const markerId = selected ? this._axs_arrow_sel : critical ? this._axs_arrow_crit : this._axs_arrow;
            group.appendChild(svg("path", { d, class: `o_axs_gantt_link ${critical ? "o_axs_gantt_link_critical" : ""} ${selected ? "o_axs_gantt_link_selected" : ""}`, "marker-end": `url(#${markerId})` }));
            group.appendChild(svg("path", { d, class: "o_axs_gantt_link_hit", "data-link": link.id }));
        }
    }

    _renderOverlay(vp) {
        const overlay = this.overlay;
        overlay.innerHTML = "";
        if (!this.prefs.overlay || !this.p.progress) {
            overlay.classList.add("d-none");
            return;
        }
        const tasks = [...this.records.values()].filter((r) => r.start !== null && !r.milestone);
        if (!tasks.length) {
            overlay.classList.add("d-none");
            return;
        }
        overlay.classList.remove("d-none");
        const height = Math.max(120, Math.min(vp.height - 10, 360));
        const top = vp.top + 4;
        overlay.setAttribute("width", this.axis.width);
        overlay.setAttribute("height", height);
        overlay.style.top = `${top}px`;
        overlay.style.height = `${height}px`;
        const y = (pct) => height - 14 - (pct / 100) * (height - 28);
        const x0 = Math.max(0, vp.x0);
        const x1 = Math.min(this.axis.width, vp.x1);
        const pts = [];
        const steps = 120;
        for (let i = 0; i <= steps; i++) {
            const x = x0 + ((x1 - x0) * i) / steps;
            pts.push(`${x.toFixed(1)},${y(plannedProgressAt(tasks, xToDate(this.axis, x))).toFixed(1)}`);
        }
        for (let p = 0; p <= 100; p += 25) {
            overlay.appendChild(svg("line", { x1: x0, x2: x1, y1: y(p), y2: y(p), class: "o_axs_gantt_overlay_grid" }));
            const t = svg("text", { x: vp.left + 6, y: y(p) - 2, class: "o_axs_gantt_overlay_axis" });
            t.textContent = `${p}%`;
            overlay.appendChild(t);
        }
        overlay.appendChild(svg("polyline", { points: pts.join(" "), class: "o_axs_gantt_overlay_planned" }));
        const planStart = Math.min(...tasks.map((t) => t.start));
        const now = Date.now();
        const actual = actualProgress(tasks);
        const ax0 = this.x(planStart);
        const ax1 = this.x(Math.max(planStart, now));
        overlay.appendChild(svg("polyline", { points: `${ax0},${y(0)} ${ax1},${y(actual)}`, class: "o_axs_gantt_overlay_actual" }));
        overlay.appendChild(svg("circle", { cx: ax1, cy: y(actual), r: 4, class: "o_axs_gantt_overlay_dot" }));
        const planned = plannedProgressAt(tasks, now);
        const label = svg("text", { x: ax1 + 8, y: y(actual) - 6, class: "o_axs_gantt_overlay_label" });
        label.textContent = fmt(_t("Today: actual %s% / planned %s%"), Math.round(actual), Math.round(planned));
        overlay.appendChild(label);
    }

    _renderStatus() {
        const status = this.status;
        status.innerHTML = "";
        const scheduled = [...this.records.values()].filter((r) => r.start !== null).length;
        const parts = [fmt(_t("%s records"), this.records.size)];
        if (scheduled !== this.records.size) {
            parts.push(fmt(_t("%s unscheduled"), this.records.size - scheduled));
        }
        if (this.prefs.critical) {
            parts.push(fmt(_t("%s on the critical path"), this.critical.tasks.size));
        }
        status.appendChild(el("span", "", { text: parts.join(" · ") }));
        if (this.data.truncated) {
            status.appendChild(el("span", "text-warning ms-2", { text: fmt(_t("Only the first %s records are displayed, refine your search to see the others."), this.data.limit) }));
        }
        if (this.prefs.overlay && this.p.progress) {
            const legend = el("span", "ms-auto o_axs_gantt_legend");
            legend.innerHTML = `<span class="o_axs_gantt_legend_planned"></span>${escapeHtml(_t("Planned progress"))}<span class="o_axs_gantt_legend_actual ms-2"></span>${escapeHtml(_t("Actual progress"))}`;
            status.appendChild(legend);
        }
        status.appendChild(el("span", `${this.prefs.overlay && this.p.progress ? "ms-3" : "ms-auto"} text-muted d-none d-md-inline`, { text: _t("Tip: drag bars to reschedule, drag the round handles to link tasks, double-click to open.") }));
    }

    // ------------------------------------------------------------------
    // critical path
    // ------------------------------------------------------------------
    _computeCritical() {
        if (!this.prefs.critical || !this.records.size) {
            this.critical = { tasks: new Set(), links: new Set() };
            return;
        }
        const tasks = [...this.records.values()].map((r) => ({ id: r.id, start: r.start, stop: r.stop }));
        this.critical = computeCriticalPath(tasks, this.links);
    }

    // ------------------------------------------------------------------
    // resources
    // ------------------------------------------------------------------
    _resourceData() {
        const resources = new Map();
        const none = _t("Unassigned");
        for (const rec of this.records.values()) {
            // summary records (with loaded children) would count the same work twice
            if (rec.start === null || (this.childrenOf && this.childrenOf.has(rec.id))) {
                continue;
            }
            const list = rec.resources.length ? rec.resources : [[0, none]];
            const days = workingDaysBetween(rec.start, rec.stop, this.workdays, this.leaveDays);
            const perDayTotal = rec.allocated && days.length ? rec.allocated / days.length : this.hoursPerDay;
            const share = rec.allocated ? perDayTotal / list.length : perDayTotal;
            for (const [rid, rname] of list) {
                if (!resources.has(rid)) {
                    resources.set(rid, { id: rid, name: rname, tasks: 0, hours: 0, days: new Map() });
                }
                const res = resources.get(rid);
                res.tasks += 1;
                if (rec.milestone) {
                    continue;
                }
                for (const key of days) {
                    res.days.set(key, (res.days.get(key) || 0) + share);
                    res.hours += share;
                }
            }
        }
        return [...resources.values()].sort((a, b) => (a.id === 0) - (b.id === 0) || a.name.localeCompare(b.name));
    }

    _renderResources(vp, full) {
        const panel = this.resourcePanel;
        if (full || !this._resources) {
            this._resources = this._resourceData();
            panel.innerHTML = "";
            const head = el("div", "o_axs_gantt_res_head");
            head.appendChild(el("span", "fw-bold", { text: fmt(_t("Resources: %s"), this.fields[this.p.resource]?.string || "") }));
            head.appendChild(el("span", "text-muted ms-2 small", { text: fmt(_t("Hours per working day, capacity %sh/day. Red cells are over capacity."), this.hoursPerDay) }));
            panel.appendChild(head);
            const wrap = el("div", "o_axs_gantt_res_body");
            this.resourceGrid = el("div", "o_axs_gantt_res_grid", { style: `width:${this.prefs.gridVisible ? this.prefs.gridWidth + 5 : 0}px` });
            const viewport = el("div", "o_axs_gantt_res_viewport");
            this.resourceTimeline = el("div", "o_axs_gantt_res_timeline", { style: `width:${this.axis.width}px` });
            viewport.appendChild(this.resourceTimeline);
            wrap.append(this.resourceGrid, viewport);
            panel.appendChild(wrap);
            for (const res of this._resources) {
                const row = el("div", "o_axs_gantt_res_row");
                row.append(
                    el("span", "o_axs_gantt_res_name", { text: res.name, title: res.name }),
                    el("span", "o_axs_gantt_res_count badge text-bg-light bg-light text-dark", { text: fmt(_t("%s tasks"), res.tasks), title: _t("Number of records") }),
                    el("span", "o_axs_gantt_res_hours", { text: `${Math.round(res.hours)}h`, title: _t("Planned working hours") })
                );
                this.resourceGrid.appendChild(row);
            }
            if (!this._resources.length) {
                this.resourceGrid.appendChild(el("div", "text-muted p-2", { text: _t("No scheduled record.") }));
            }
        }
        const timeline = this.resourceTimeline;
        timeline.innerHTML = "";
        timeline.style.width = `${this.axis.width}px`;
        timeline.style.transform = `translateX(${-this.chart.scrollLeft}px)`;
        const buckets = visibleSlice(this.prefs.scale === "hour" ? this.axis.top : this.axis.bottom, vp.x0, vp.x1);
        this._resources.forEach((res, i) => {
            for (const b of buckets) {
                let hours = 0;
                let capacityDays = 0;
                let cursor = DateTime.fromMillis(b.start).startOf("day");
                const end = DateTime.fromMillis(b.end);
                let guard = 0;
                while (cursor < end && guard < 400) {
                    const key = cursor.toFormat("yyyy-MM-dd");
                    hours += res.days.get(key) || 0;
                    if (this.workdays.has(cursor.weekday - 1) && !this.leaveDays.has(key)) {
                        capacityDays += 1;
                    }
                    cursor = cursor.plus({ days: 1 });
                    guard++;
                }
                if (!hours) {
                    continue;
                }
                const capacity = capacityDays * this.hoursPerDay;
                const ratio = capacity ? hours / capacity : 2;
                const cell = el("div", `o_axs_gantt_res_cell ${ratio > 1.001 && res.id !== 0 ? "o_axs_gantt_res_over" : ""}`, {
                    style: `left:${b.x}px;width:${b.w}px;top:${i * 28}px;--axs-load:${Math.min(1, ratio)}`,
                    title: `${res.name}: ${Math.round(hours * 10) / 10}h / ${capacity}h`,
                    text: b.w > 34 ? `${Math.round(hours)}h` : "",
                });
                timeline.appendChild(cell);
            }
        });
        timeline.style.height = `${this._resources.length * 28}px`;
    }

    // ------------------------------------------------------------------
    // tooltip & popovers
    // ------------------------------------------------------------------
    _tooltipHtml(rec) {
        const s = this.settings;
        const lines = [`<div class="o_axs_gantt_tt_title">${escapeHtml(rec.name)}</div>`];
        const add = (label, value) => {
            if (value !== "" && value !== null && value !== undefined) {
                lines.push(`<div><span class="text-muted">${escapeHtml(label)}:</span> ${escapeHtml(value)}</div>`);
            }
        };
        if (rec.start === null) {
            add(_t("Status"), _t("Unscheduled"));
        } else {
            if (s.tooltip_start) {
                add(_t("Start"), formatDate(rec.start, !this.allDay));
            }
            if (s.tooltip_stop && !rec.milestone) {
                add(_t("End"), formatDate(this.allDay ? rec.stop - 1 : rec.stop, !this.allDay));
            }
            if (s.tooltip_duration && !rec.milestone) {
                add(_t("Duration"), formatDuration(rec.stop - rec.start, this.hoursPerDay, this.allDay));
            }
        }
        if (s.tooltip_progress && rec.progress !== null) {
            add(_t("Progress"), `${Math.round(rec.progress)}%`);
        }
        if (s.tooltip_deadline && rec.deadline) {
            const isDate = this.fields[this.p.deadline]?.type === "date";
            add(_t("Deadline"), formatDate(isDate ? rec.deadline - 1 : rec.deadline, !isDate) + (rec.stop > rec.deadline ? ` (${_t("late")})` : ""));
        }
        if (s.tooltip_constraint && rec.constraintType && rec.constraintType !== "asap") {
            add(_t("Constraint"), `${CONSTRAINT_LABELS()[rec.constraintType]} ${rec.constraintDate ? formatDate(rec.constraintDate) : ""}${this._constraintViolated(rec) ? ` (${_t("not met")})` : ""}`);
        }
        if (s.tooltip_resource && this.p.resource && rec.resources.length) {
            add(this.fields[this.p.resource]?.string || _t("Resource"), rec.resources.map((r) => r[1]).join(", "));
        }
        if (s.tooltip_fields) {
            for (const f of this.arch.fields) {
                if (this.fields[f.name] && !f.column) {
                    add(f.string || this.fields[f.name].string, this._formatField(rec.raw[f.name], f.name));
                }
            }
        }
        if (this.prefs.critical && this.critical.tasks.has(rec.id)) {
            lines.push(`<div class="text-danger mt-1">${icon("critical")} ${escapeHtml(_t("On the critical path"))}</div>`);
        }
        return lines.join("");
    }

    _onBarHover(ev) {
        if (this._drag) {
            return;
        }
        const bar = ev.target.closest(".o_axs_gantt_bar");
        if (!bar) {
            this._hideTooltip();
            return;
        }
        const id = Number(bar.dataset.id);
        if (this._tooltipId !== id) {
            this._tooltipId = id;
            const rec = this.records.get(id);
            if (!rec) {
                return;
            }
            this.tooltip.innerHTML = this._tooltipHtml(rec);
        }
        this.tooltip.classList.remove("d-none");
        this._positionFloating(this.tooltip, ev.clientX + 14, ev.clientY + 16);
    }

    _hideTooltip() {
        this._tooltipId = null;
        this.tooltip.classList.add("d-none");
    }

    _positionFloating(node, clientX, clientY) {
        const rootRect = this.root.getBoundingClientRect();
        const w = node.offsetWidth;
        const h = node.offsetHeight;
        let left = clientX - rootRect.left;
        let top = clientY - rootRect.top;
        if (left + w > rootRect.width - 8) {
            left = Math.max(8, left - w - 28);
        }
        if (top + h > rootRect.height - 8) {
            top = Math.max(8, top - h - 30);
        }
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
    }

    _closePopover() {
        this.popover.classList.add("d-none");
        this.popover.innerHTML = "";
        if (this._selectedLink) {
            this._selectedLink = null;
            this._scheduleRender(true);
        }
    }

    _showQuickInfo(rec, clientX, clientY) {
        const pop = this.popover;
        pop.innerHTML = "";
        pop.appendChild(el("button", "btn-close float-end o_axs_gantt_pop_close", { type: "button", "aria-label": _t("Close") }));
        pop.appendChild(el("div", "o_axs_gantt_pop_body", { html: this._tooltipHtml(rec) }));
        const actions = el("div", "d-flex flex-wrap gap-1 mt-2 o_axs_gantt_pop_actions");
        actions.appendChild(this._button("open", _t("Open"), () => this.openRecord(rec.id), { text: _t("Open"), className: "btn-primary o_axs_gantt_pop_open" }));
        actions.lastChild.classList.remove("btn-light");
        if (this.access.write && this.arch.edit && this.p.has_planning) {
            if (rec.start !== null) {
                actions.appendChild(this._button("unschedule", _t("Unschedule"), () => this.toggleUnscheduled(rec.id, true).catch((e) => this._error(e)), { text: _t("Unschedule"), className: "o_axs_gantt_pop_unschedule" }));
            }
        }
        if (this.p.parent_field && this.access.create && this.arch.create) {
            actions.appendChild(this._button("add", _t("Sub-task"), () => {
                this._closePopover();
                this.createRecord({ [`default_${this.p.parent_field}`]: rec.id }, rec.start ?? undefined);
            }, { text: _t("Sub-task"), className: "o_axs_gantt_pop_child" }));
        }
        if (this.access.unlink && this.arch.delete) {
            actions.appendChild(this._button("delete", _t("Delete"), () => {
                this._closePopover();
                this.deleteRecord(rec.id).catch((e) => this._error(e));
            }, { className: "o_axs_gantt_pop_delete" }));
        }
        pop.appendChild(actions);
        pop.querySelector(".o_axs_gantt_pop_close").addEventListener("click", () => this._closePopover());
        pop.classList.remove("d-none");
        this._positionFloating(pop, clientX, clientY);
    }

    _onLinkClick(ev) {
        const hit = ev.target.closest(".o_axs_gantt_link_hit");
        if (!hit) {
            return;
        }
        ev.stopPropagation();
        const link = this.links.find((l) => l.id === hit.dataset.link);
        if (!link) {
            return;
        }
        this._selectedLink = link.id;
        this._scheduleRender(true);
        const pop = this.popover;
        pop.innerHTML = "";
        const s = this.records.get(link.source);
        const t = this.records.get(link.target);
        pop.appendChild(el("div", "o_axs_gantt_tt_title", { text: _t("Dependency") }));
        pop.appendChild(el("div", "small mb-2", { text: `${s.name} → ${t.name}` }));
        const canEdit = this.access.write && this.arch.edit;
        const select = el("select", "form-select form-select-sm mb-2 o_axs_gantt_link_type", { disabled: !canEdit || undefined });
        for (const [value, label] of Object.entries(LINK_LABELS())) {
            const opt = el("option", "", { value, text: label });
            if (value === link.type) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }
        const lagWrap = el("div", "input-group input-group-sm mb-2");
        const lag = el("input", "form-control o_axs_gantt_link_lag", { type: "number", step: "0.5", value: String(link.lag || 0), disabled: !canEdit || undefined });
        lagWrap.append(el("span", "input-group-text", { text: _t("Lag") }), lag, el("span", "input-group-text", { text: _t("days") }));
        pop.append(select, lagWrap);
        if (canEdit) {
            const actions = el("div", "d-flex gap-1");
            actions.appendChild(this._button("check", _t("Save"), async () => {
                try {
                    await this.services.orm.call("axs.gantt", "update_link", [this.resModel, this.params, link.id, select.value, Number(lag.value) || 0], { context: this.context });
                    this._closePopover();
                    await this.load();
                } catch (e) {
                    this._error(e);
                }
            }, { text: _t("Save"), className: "btn-primary o_axs_gantt_link_save" }));
            actions.lastChild.classList.remove("btn-light");
            actions.appendChild(this._button("delete", _t("Remove dependency"), async () => {
                try {
                    await this.services.orm.call("axs.gantt", "remove_link", [this.resModel, this.params, link.id], { context: this.context });
                    this._closePopover();
                    await this.load();
                } catch (e) {
                    this._error(e);
                }
            }, { text: _t("Remove"), className: "o_axs_gantt_link_remove" }));
            pop.appendChild(actions);
        }
        pop.classList.remove("d-none");
        this._positionFloating(pop, ev.clientX + 8, ev.clientY + 8);
    }

    _onCanvasClick(ev) {
        if (this._justDragged) {
            return;
        }
        const hint = ev.target.closest(".o_axs_gantt_unscheduled_hint");
        if (hint) {
            const rec = this.records.get(Number(hint.dataset.id));
            const rect = this.canvas.getBoundingClientRect();
            const ms = xToDate(this.axis, ev.clientX - rect.left);
            const start = this.allDay || this.prefs.scale !== "hour" ? DateTime.fromMillis(ms).startOf("day").toMillis() : DateTime.fromMillis(ms).startOf("hour").toMillis();
            const duration = rec.origStart !== null && rec.origStop !== null ? rec.origStop - rec.origStart : this.allDay ? DAY : this.prefs.scale === "hour" ? 2 * HOUR : DAY;
            this._commitMove(rec, start, start + duration).catch((e) => this._error(e));
        }
    }

    // ------------------------------------------------------------------
    // drag & drop
    // ------------------------------------------------------------------
    _onBarPointerDown(ev) {
        if (ev.button !== 0) {
            return;
        }
        const bar = ev.target.closest(".o_axs_gantt_bar");
        if (!bar) {
            return;
        }
        const rec = this.records.get(Number(bar.dataset.id));
        if (!rec) {
            return;
        }
        const handle = ev.target.closest("[data-drag]");
        let mode = handle ? handle.dataset.drag : "move";
        const canWrite = this.access.write && this.arch.edit;
        if (!canWrite || (mode === "move" && !bar.classList.contains("o_axs_gantt_draggable"))) {
            mode = "click";
        }
        ev.preventDefault();
        this._hideTooltip();
        const drag = {
            mode, rec, bar, startX: ev.clientX, startY: ev.clientY, moved: false,
            origLeft: parseFloat(bar.style.left), origWidth: parseFloat(bar.style.width) || 0,
        };
        this._drag = drag;
        const onMove = (e) => this._onDragMove(e);
        const onUp = (e) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            this._onDragEnd(e).catch((err) => this._error(err));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    _onDragMove(ev) {
        const drag = this._drag;
        if (!drag) {
            return;
        }
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) {
            return;
        }
        if (drag.mode === "click") {
            return;
        }
        drag.moved = true;
        this.root.classList.add("o_axs_gantt_dragging");
        const rec = drag.rec;
        if (drag.mode === "move" || drag.mode === "resize-start" || drag.mode === "resize-end") {
            const { start, stop } = this._dragDates(drag, dx);
            drag.newStart = start;
            drag.newStop = stop;
            const x1 = this.x(start);
            const x2 = this.x(stop);
            if (rec.milestone) {
                drag.bar.style.left = `${x1 - 9}px`;
            } else {
                drag.bar.style.left = `${x1}px`;
                drag.bar.style.width = `${Math.max(4, x2 - x1)}px`;
            }
            this._showDragLabel(ev, rec.milestone ? formatDate(start, !this.allDay) : `${formatDate(start, !this.allDay)} → ${formatDate(this.allDay ? stop - 1 : stop, !this.allDay)}`);
        } else if (drag.mode === "progress") {
            const rect = drag.bar.getBoundingClientRect();
            const pct = Math.max(0, Math.min(100, Math.round(((ev.clientX - rect.left) / rect.width) * 100)));
            drag.newProgress = pct;
            const fill = drag.bar.querySelector(".o_axs_gantt_bar_progress");
            if (fill) {
                fill.style.width = `${pct}%`;
            }
            const handle = drag.bar.querySelector(".o_axs_gantt_progress_handle");
            if (handle) {
                handle.style.left = `${pct}%`;
            }
            this._showDragLabel(ev, `${pct}%`);
        } else if (drag.mode === "link-start" || drag.mode === "link-end") {
            const rect = this.canvas.getBoundingClientRect();
            const from = this._anchor(rec, drag.mode === "link-start" ? "start" : "end");
            if (!from) {
                return;
            }
            if (!drag.line) {
                drag.line = svg("line", { class: "o_axs_gantt_link_draft" });
                this.linkGroup.appendChild(drag.line);
            }
            drag.line.setAttribute("x1", from.x);
            drag.line.setAttribute("y1", from.y);
            drag.line.setAttribute("x2", ev.clientX - rect.left);
            drag.line.setAttribute("y2", ev.clientY - rect.top);
            for (const b of this.bars.querySelectorAll(".o_axs_gantt_link_target")) {
                b.classList.remove("o_axs_gantt_link_target");
            }
            const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".o_axs_gantt_bar");
            if (target && target !== drag.bar) {
                target.classList.add("o_axs_gantt_link_target");
            }
        }
    }

    _dragDates(drag, dx) {
        const rec = drag.rec;
        const scale = this.prefs.scale;
        if (drag.mode === "move") {
            const raw = xToDate(this.axis, this.x(rec.start) + dx) - rec.start;
            const delta = snapDelta(raw, scale, this.allDay);
            const start = shiftMs(rec.start, delta);
            return { start, stop: shiftMs(rec.stop, delta) };
        }
        if (drag.mode === "resize-start") {
            const raw = xToDate(this.axis, this.x(rec.start) + dx) - rec.start;
            let start = shiftMs(rec.start, snapDelta(raw, scale, this.allDay));
            const minimum = this.allDay || SCALES[scale].snap.days ? DAY : 15 * 60000;
            if (start > rec.stop - minimum) {
                start = rec.stop - minimum;
            }
            return { start, stop: rec.stop };
        }
        const raw = xToDate(this.axis, this.x(rec.stop) + dx) - rec.stop;
        let stop = shiftMs(rec.stop, snapDelta(raw, scale, this.allDay));
        const minimum = this.allDay || SCALES[scale].snap.days ? DAY : 15 * 60000;
        if (stop < rec.start + minimum) {
            stop = rec.start + minimum;
        }
        return { start: rec.start, stop };
    }

    _showDragLabel(ev, text) {
        this.tooltip.innerHTML = `<div class="o_axs_gantt_tt_title">${escapeHtml(text)}</div>`;
        this.tooltip.classList.remove("d-none");
        this._positionFloating(this.tooltip, ev.clientX + 14, ev.clientY + 16);
    }

    async _onDragEnd(ev) {
        const drag = this._drag;
        this._drag = null;
        this.root.classList.remove("o_axs_gantt_dragging");
        this._hideTooltip();
        if (!drag) {
            return;
        }
        if (!drag.moved) {
            this.selectedId = drag.rec.id;
            this._scheduleRender(true);
            if (this.settings.quick_info) {
                this._showQuickInfo(drag.rec, ev.clientX + 6, ev.clientY + 10);
            }
            return;
        }
        this._justDragged = true;
        setTimeout(() => (this._justDragged = false), 50);
        const rec = drag.rec;
        if (drag.mode === "progress") {
            if (drag.newProgress !== undefined && drag.newProgress !== Math.round(rec.progress || 0)) {
                await this.services.orm.write(this.resModel, [rec.id], { [this.p.progress]: drag.newProgress });
                await this.load();
            } else {
                this._scheduleRender(true);
            }
            return;
        }
        if (drag.mode === "link-start" || drag.mode === "link-end") {
            drag.line?.remove();
            const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".o_axs_gantt_bar");
            for (const b of this.bars.querySelectorAll(".o_axs_gantt_link_target")) {
                b.classList.remove("o_axs_gantt_link_target");
            }
            if (!target || target === drag.bar || !target.dataset.id) {
                return;
            }
            const handle = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("[data-drag]");
            const toSide = handle && handle.dataset.drag === "link-end" ? "end" : "start";
            const fromSide = drag.mode === "link-start" ? "start" : "end";
            const type = { "end:start": "fs", "start:start": "ss", "end:end": "ff", "start:end": "sf" }[`${fromSide}:${toSide}`];
            await this.services.orm.call("axs.gantt", "add_link", [this.resModel, this.params, rec.id, Number(target.dataset.id), type, 0], { context: this.context });
            this._notify(fmt(_t("Dependency created: %s"), LINK_LABELS()[type]), "success");
            await this.load();
            return;
        }
        if (drag.newStart === undefined || (drag.newStart === rec.start && drag.newStop === rec.stop)) {
            this._scheduleRender(true);
            return;
        }
        await this._commitMove(rec, drag.newStart, drag.newStop);
    }

    async _commitMove(rec, start, stop) {
        const startValue = serializeStart(start, this.startType);
        const stopValue = this.p.date_stop ? serializeStop(stop, this.stopType) : false;
        let result;
        try {
            result = await this.services.orm.call("axs.gantt", "move", [this.resModel, this.params, rec.id, startValue, stopValue], { context: this.context });
        } catch (error) {
            await this.load();
            throw error;
        }
        if (result && result.previous && Object.keys(result.previous).length) {
            this.undoStack.push(result.previous);
            if (this.undoStack.length > 30) {
                this.undoStack.shift();
            }
        }
        const others = (result?.changed || []).length - 1;
        if (others > 0) {
            this._notify(fmt(_t("%s dependent records were rescheduled automatically."), others), "info");
        }
        await this.load();
    }

    async undo() {
        const previous = this.undoStack.pop();
        if (!previous) {
            return;
        }
        await this.services.orm.call("axs.gantt", "restore", [this.resModel, this.params, previous], { context: this.context });
        this._notify(_t("Change undone."), "success");
        await this.load();
    }

    _startSplitter(ev) {
        ev.preventDefault();
        const startX = ev.clientX;
        const startWidth = this.prefs.gridWidth;
        const max = Math.max(220, this.root.clientWidth * 0.75);
        const onMove = (e) => {
            this.prefs.gridWidth = Math.max(160, Math.min(max, startWidth + e.clientX - startX));
            this.grid.style.width = `${this.prefs.gridWidth}px`;
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            this._savePrefs();
            this._scheduleRender(true);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }

    _onWheel(ev) {
        if (ev.ctrlKey || ev.metaKey) {
            ev.preventDefault();
            this.setZoom(this.prefs.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15));
        }
    }

    _onKeydown(ev) {
        if (ev.target.closest("input, textarea, select, [contenteditable]")) {
            return;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
            ev.preventDefault();
            this.undo().catch((e) => this._error(e));
            return;
        }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) {
            return;
        }
        const actions = {
            t: () => this.scrollToDate(Date.now()),
            f: () => this.zoomToFit(),
            "+": () => this.setZoom(this.prefs.zoom * 1.4),
            "=": () => this.setZoom(this.prefs.zoom * 1.4),
            "-": () => this.setZoom(this.prefs.zoom / 1.4),
            g: () => this.toggle("gridVisible"),
            r: () => this.toggle("resourceVisible"),
            c: () => this.toggle("critical"),
            Escape: () => this._closePopover(),
        };
        const action = actions[ev.key] || actions[ev.key.toLowerCase()];
        if (action) {
            ev.preventDefault();
            action();
        }
    }

    // ------------------------------------------------------------------
    // export
    // ------------------------------------------------------------------
    _exportTasks() {
        // full tree (ignores collapsed state), in outline order
        const out = [];
        const refs = new Map();
        const visit = (rec, level) => {
            refs.set(rec.id, rec.id);
            out.push({
                ref: rec.id, id: rec.id, name: rec.name, level, parentRef: rec.parentId,
                start: rec.start, stop: rec.stop, progress: rec.progress, milestone: rec.milestone,
                allDay: this.allDay, deadline: rec.deadline,
                resource: rec.resources.map((r) => r[1]).join(", "),
                color: this._barColor(rec),
                raw: rec.raw,
            });
            const kids = this._sortRecords(this.childrenOf.get(rec.id) || []);
            for (const kid of kids) {
                visit(kid, level + 1);
            }
        };
        const roots = this._sortRecords([...this.records.values()].filter((r) => !r.parentId));
        for (const rec of roots) {
            visit(rec, 0);
        }
        return out;
    }

    _exportFileName(ext) {
        const base = (this.title || this.data.model_description || "gantt").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "gantt";
        return `${base}_${DateTime.now().toFormat("yyyyMMdd_HHmm")}.${ext}`;
    }

    async exportAs(format) {
        const tasks = this._exportTasks();
        const links = this.links.map((l) => ({ ...l, critical: this.critical.links.has(l.id) }));
        const title = this.title || this.data.model_description;
        try {
            switch (format) {
                case "json":
                    download(buildJson({ title, model: this.resModel, tasks, links }), this._exportFileName("json"), "application/json");
                    break;
                case "xml":
                    download(buildMsProjectXml({ title, tasks, links }), this._exportFileName("xml"), "application/xml");
                    break;
                case "xer":
                    download(buildXer({ title, tasks, links, user: this.context.uid ? `user${this.context.uid}` : "odoo" }), this._exportFileName("xer"), "text/plain");
                    break;
                case "ics":
                    download(buildIcs({ title, model: this.resModel, tasks, host: window.location.hostname }), this._exportFileName("ics"), "text/calendar");
                    break;
                case "xlsx":
                    await this._exportXlsx(tasks, title);
                    break;
                case "png": {
                    const canvas = this._renderExportCanvas(tasks, links, 0, Math.min(tasks.length, 1500), title);
                    canvas.toBlob((blob) => download(blob, this._exportFileName("png"), "image/png"), "image/png");
                    break;
                }
                case "pdf": {
                    const perPage = 24;
                    const pages = [];
                    for (let i = 0; i < Math.max(tasks.length, 1) && pages.length < 200; i += perPage) {
                        pages.push(this._renderExportCanvas(tasks, links, i, Math.min(tasks.length, i + perPage), title, { pdf: true, page: pages.length + 1, pages: Math.ceil(tasks.length / perPage) || 1 }));
                    }
                    download(buildPdf(pages), this._exportFileName("pdf"), "application/pdf");
                    break;
                }
            }
        } catch (error) {
            this._error(error);
            return;
        }
        this._notify(fmt(_t("Export ready: %s"), format.toUpperCase()), "success");
    }

    _renderExportCanvas(tasks, links, from, to, title, { pdf, page, pages } = {}) {
        const scheduled = tasks.filter((t) => t.start !== null);
        const start = scheduled.length ? Math.min(...scheduled.map((t) => t.start)) : Date.now();
        const stop = scheduled.length ? Math.max(...scheduled.map((t) => t.stop)) : Date.now() + DAY;
        const scale = this.prefs.scale;
        const unit = { hour: "day", day: "week", week: "month", month: "month", quarter: "year", year: "year" }[scale];
        const axis = exportAxis({
            start: DateTime.fromMillis(start).startOf(unit).toMillis(),
            stop: DateTime.fromMillis(stop).endOf(unit).toMillis(),
            scale, zoom: this.prefs.zoom, hiddenWeekdays: this.hiddenWeekdays,
            hideDays: this.settings.hide_days_off && ["hour", "day", "week"].includes(scale),
            hiddenDates: this.leaveDays,
            maxWidth: pdf ? 1500 : 6000,
        });
        const rows = tasks.slice(from, to).map((t) => ({
            kind: "task", id: t.id, name: t.name, level: t.level, start: t.start, stop: t.stop,
            progress: t.progress, color: t.color, milestone: t.milestone,
            critical: this.prefs.critical && this.critical.tasks.has(t.id),
        }));
        const canvas = document.createElement("canvas");
        const subtitle = `${formatDate(start, false)} - ${formatDate(stop, false)} · ${fmt(_t("%s records"), tasks.length)}${pages ? ` · ${fmt(_t("Page %s / %s"), page, pages)}` : ""}`;
        return drawGantt(canvas, {
            title, subtitle, rows, links, axis, gridWidth: 260, nameLabel: _t("Name"),
            ratio: pdf ? 1.4 : 1,
            offCells: this.settings.days_off && ["hour", "day", "week"].includes(axis.scale) ? offCellsFor(axis, (c) => this._isOffCell(c)) : null,
        });
    }

    async _exportXlsx(tasks, title) {
        const columns = [
            { label: "ID", type: "char" },
            { label: _t("Name"), type: "char" },
            { label: _t("Parent ID"), type: "char" },
            { label: _t("Start"), type: "datetime" },
            { label: _t("End"), type: "datetime" },
            { label: _t("Duration (days)"), type: "number" },
        ];
        if (this.p.progress) {
            columns.push({ label: _t("Progress"), type: "percent" });
        }
        columns.push({ label: _t("Milestone"), type: "char" }, { label: _t("Predecessors"), type: "char" });
        if (this.p.resource) {
            columns.push({ label: this.fields[this.p.resource]?.string || _t("Resource"), type: "char" });
        }
        const extra = this.arch.fields.filter((f) => this.fields[f.name]);
        for (const f of extra) {
            columns.push({ label: f.string || this.fields[f.name].string, type: "char" });
        }
        const preds = new Map();
        for (const l of this.links) {
            if (!preds.has(l.target)) {
                preds.set(l.target, []);
            }
            preds.get(l.target).push(`${l.source}${l.type === "fs" ? "" : l.type.toUpperCase()}`);
        }
        const local = (ms) => (ms === null ? false : DateTime.fromMillis(ms).toFormat("yyyy-MM-dd HH:mm:ss"));
        const rows = tasks.map((t) => {
            const values = [
                String(t.id), t.name, t.parentRef ? String(t.parentRef) : "",
                local(t.start), local(t.stop === null ? null : this.allDay ? t.stop - 1000 : t.stop),
                t.start === null ? false : Math.round(((t.stop - t.start) / DAY) * 100) / 100,
            ];
            if (this.p.progress) {
                values.push(t.progress === null ? false : Math.round(t.progress));
            }
            values.push(t.milestone ? _t("Yes") : "", (preds.get(t.id) || []).join(", "));
            if (this.p.resource) {
                values.push(t.resource);
            }
            for (const f of extra) {
                values.push(this._formatField(t.raw[f.name], f.name));
            }
            return { values, level: t.level, start: local(t.start), stop: local(t.stop), color: t.color };
        });
        const scheduled = tasks.filter((t) => t.start !== null);
        let timeline = null;
        if (scheduled.length) {
            const start = DateTime.fromMillis(Math.min(...scheduled.map((t) => t.start))).startOf("week");
            const stop = Math.max(...scheduled.map((t) => t.stop));
            timeline = { start: start.toFormat("yyyy-MM-dd"), weeks: Math.ceil((stop - start.toMillis()) / (7 * DAY)) };
        }
        const b64 = await this.services.orm.call("axs.gantt", "export_xlsx", [title, columns, rows, timeline], { context: this.context });
        download(base64ToBlob(b64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), this._exportFileName("xlsx"));
    }
}
