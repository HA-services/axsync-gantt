from odoo import fields, models


class AxsGanttBinding(models.Model):
    _name = 'axs.gantt.binding'
    _description = 'Gantt View Binding'
    _order = 'id'

    action_id = fields.Many2one('ir.actions.act_window', required=True, ondelete='cascade', index=True)
    view_id = fields.Many2one('ir.ui.view', string="Gantt View", ondelete='set null',
                              domain=[('type', '=', 'axs_gantt')])
    position = fields.Selection([
        ('before_form', 'Before the form view'),
        ('first', 'First (default view)'),
        ('last', 'Last'),
    ], default='before_form', required=True)
