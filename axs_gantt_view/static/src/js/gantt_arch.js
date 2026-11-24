/** @odoo-module **/
/* AXSync Gantt View - arch parser. */

function bool(value, defaultValue) {
    if (value === null || value === undefined || value === "") {
        return defaultValue;
    }
    return !["0", "false", "False"].includes(String(value).trim());
}

export function parseGanttArch(arch) {
    const node = typeof arch === "string" ? new DOMParser().parseFromString(arch, "text/xml").documentElement : arch;
    const get = (name) => node.getAttribute(name) || null;
    const fields = [];
    for (const child of node.children) {
        if (child.tagName === "field" && child.getAttribute("name")) {
            if (bool(child.getAttribute("invisible"), false) === true && child.getAttribute("invisible") !== "0") {
                continue;
            }
            fields.push({
                name: child.getAttribute("name"),
                string: child.getAttribute("string") || null,
                column: bool(child.getAttribute("column"), false),
                width: Number(child.getAttribute("width")) || null,
            });
        }
    }
    const groupOptions = (get("group_by_options") || "").split(",").map((s) => s.trim()).filter(Boolean);
    return {
        string: get("string"),
        dateStart: get("date_start"),
        dateStop: get("date_stop"),
        progress: get("progress"),
        parentField: get("parent_field"),
        color: get("color"),
        deadline: get("deadline"),
        milestone: get("milestone"),
        resource: get("resource"),
        dependencyField: get("dependency_field"),
        allocatedHours: get("allocated_hours"),
        sequence: get("sequence"),
        defaultGroupBy: get("default_group_by"),
        defaultScale: get("default_scale"),
        groupByOptions: groupOptions,
        create: bool(get("create"), true),
        edit: bool(get("edit"), true),
        delete: bool(get("delete"), true),
        import: bool(get("import"), false),
        autoSchedule: bool(get("auto_schedule"), false),
        formViewId: Number(get("form_view_id")) || false,
        viewId: get("view_key"),
        fields,
    };
}
