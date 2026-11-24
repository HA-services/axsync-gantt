from odoo import fields, models

from .ir_ui_view import GANTT_LABEL


class IrActionsActWindowView(models.Model):
    _inherit = 'ir.actions.act_window.view'

    view_mode = fields.Selection(
        selection_add=[('axs_gantt', GANTT_LABEL)],
        ondelete={'axs_gantt': 'cascade'},
    )


class IrActionsActWindow(models.Model):
    _inherit = 'ir.actions.act_window'

    axs_gantt_binding_ids = fields.One2many('axs.gantt.binding', 'action_id', string="Gantt Bindings")

    def _compute_views(self):
        """Append the AXSync Gantt view to actions bound through axs.gantt.binding.

        Done at compute time so that the binding survives upgrades of the
        module owning the action (its view_mode is never rewritten).
        """
        super()._compute_views()
        real_ids = [rid for rid in self.ids if isinstance(rid, int)]
        if not real_ids:
            return
        bindings = self.env['axs.gantt.binding'].sudo().search([('action_id', 'in', real_ids)])
        by_action = {}
        for binding in bindings:
            by_action.setdefault(binding.action_id.id, binding)
        for action in self:
            binding = by_action.get(action.id)
            if not binding or not action.views:
                continue
            views = list(action.views)
            if any(mode == 'axs_gantt' for _vid, mode in views):
                continue
            entry = [binding.view_id.id or False, 'axs_gantt']
            # keep the form view last, insert the Gantt just before it
            form_pos = next((i for i, (_vid, mode) in enumerate(views) if mode == 'form'), None)
            if binding.position == 'first':
                views.insert(0, entry)
            elif form_pos is not None and binding.position == 'before_form':
                views.insert(form_pos, entry)
            else:
                views.append(entry)
            action.views = views
