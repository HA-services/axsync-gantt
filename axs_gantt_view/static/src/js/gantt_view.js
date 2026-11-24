/** @odoo-module **/
/* AXSync Gantt View - view registration and controller (Odoo 16). */

import { _lt } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Layout } from "@web/search/layout";
import { standardViewProps } from "@web/views/standard_view_props";
import { Component, onMounted, onWillUnmount, onWillUpdateProps, useRef } from "@odoo/owl";
import { GanttEngine, setIconSet } from "./gantt_engine";
import { parseGanttArch } from "./gantt_arch";

setIconSet("fa");

export class AxsGanttController extends Component {
    setup() {
        this.services = {
            orm: useService("orm"),
            action: useService("action"),
            notification: useService("notification"),
        };
        this.engineRef = useRef("engine");
        onMounted(() => {
            const config = this.env.config || {};
            const title = typeof config.getDisplayName === "function" ? config.getDisplayName() : config.displayName;
            this.engine = new GanttEngine(this.engineRef.el, {
                services: this.services,
                resModel: this.props.resModel,
                archInfo: { ...this.props.archInfo, viewId: this.props.archInfo.viewId || config.actionId || "default" },
                context: this.props.context,
                domain: this.props.domain,
                title: title || this.props.archInfo.string,
            });
            this.reload(this.props);
        });
        onWillUpdateProps((nextProps) => {
            if (this.engine) {
                this.reload(nextProps);
            }
        });
        onWillUnmount(() => this.engine && this.engine.destroy());
    }

    reload(props) {
        return this.engine
            .load({ domain: props.domain, context: props.context, groupBy: props.groupBy || [] })
            .catch((error) => this.engine._error(error));
    }
}
AxsGanttController.template = "axs_gantt_view.GanttController";
AxsGanttController.components = { Layout };
AxsGanttController.props = { ...standardViewProps, archInfo: Object };

export const axsGanttView = {
    type: "axs_gantt",
    display_name: _lt("Gantt"),
    icon: "fa fa-tasks",
    multiRecord: true,
    searchMenuTypes: ["filter", "groupBy", "favorite"],
    Controller: AxsGanttController,
    props: (genericProps) => ({
        ...genericProps,
        archInfo: parseGanttArch(genericProps.arch),
    }),
};

registry.category("views").add("axs_gantt", axsGanttView);
