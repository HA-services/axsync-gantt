from lxml import etree

from odoo import api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools.translate import _

SCALES = [('hour', 'Hours'), ('day', 'Days'), ('week', 'Weeks'), ('month', 'Months'),
          ('quarter', 'Quarters'), ('year', 'Years')]


class AxsGanttConfig(models.Model):
    """No-code setup: add a Gantt view to any window action."""
    _name = 'axs.gantt.config'
    _description = 'Gantt View Setup'
    _order = 'name'

    name = fields.Char(required=True)
    active = fields.Boolean(default=True)
    action_id = fields.Many2one(
        'ir.actions.act_window', string="Menu Action", required=True, ondelete='cascade',
        help="The window action (menu) that will get the Gantt view.")
    model_name = fields.Char(related='action_id.res_model', string="Model", store=True)
    model_id = fields.Many2one('ir.model', string="Model Record", compute='_compute_model_id', store=True)
    date_start_field_id = fields.Many2one(
        'ir.model.fields', string="Start Date", required=True, ondelete='cascade',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('date', 'datetime')), ('store', '=', True)]")
    date_stop_field_id = fields.Many2one(
        'ir.model.fields', string="End Date", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('date', 'datetime')), ('store', '=', True)]")
    progress_field_id = fields.Many2one(
        'ir.model.fields', string="Progress (%)", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('float', 'integer'))]")
    parent_field_id = fields.Many2one(
        'ir.model.fields', string="Parent", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', '=', 'many2one'), ('relation', '=', model_name)]")
    dependency_field_id = fields.Many2one(
        'ir.model.fields', string="Depends On", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', '=', 'many2many'), ('relation', '=', model_name)]")
    color_field_id = fields.Many2one(
        'ir.model.fields', string="Color By", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('many2one', 'selection', 'integer'))]")
    resource_field_id = fields.Many2one(
        'ir.model.fields', string="Resource", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('many2one', 'many2many'))]")
    deadline_field_id = fields.Many2one(
        'ir.model.fields', string="Deadline", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('date', 'datetime'))]")
    group_by_field_id = fields.Many2one(
        'ir.model.fields', string="Group By", ondelete='set null',
        domain="[('model_id', '=', model_id), ('ttype', 'in', ('many2one', 'selection', 'char', 'boolean'))]")
    column_field_ids = fields.Many2many(
        'ir.model.fields', string="Extra Columns and Tooltip Fields",
        domain="[('model_id', '=', model_id), ('ttype', 'not in', ('one2many', 'binary', 'html', 'properties'))]")
    default_scale = fields.Selection(SCALES, default='week', required=True)
    auto_schedule = fields.Boolean(
        "Auto Schedule Successors",
        help="Push dependent records forward automatically when a predecessor moves.")
    view_id = fields.Many2one('ir.ui.view', readonly=True, ondelete='set null', copy=False)
    binding_id = fields.Many2one('axs.gantt.binding', readonly=True, ondelete='set null', copy=False)

    @api.depends('action_id.res_model')
    def _compute_model_id(self):
        for config in self:
            config.model_id = self.env['ir.model']._get(config.action_id.res_model) if config.action_id else False

    @api.onchange('action_id')
    def _onchange_action_id(self):
        if self.action_id and not self.name:
            self.name = self.action_id.name

    def _build_arch(self):
        self.ensure_one()
        node = etree.Element('axs_gantt', string=self.name, date_start=self.date_start_field_id.name,
                             default_scale=self.default_scale)
        mapping = {
            'date_stop': self.date_stop_field_id, 'progress': self.progress_field_id,
            'parent_field': self.parent_field_id, 'dependency_field': self.dependency_field_id,
            'color': self.color_field_id, 'resource': self.resource_field_id,
            'deadline': self.deadline_field_id, 'default_group_by': self.group_by_field_id,
        }
        for attr, field in mapping.items():
            if field:
                node.set(attr, field.name)
        if self.auto_schedule:
            node.set('auto_schedule', '1')
        for field in self.column_field_ids:
            etree.SubElement(node, 'field', name=field.name)
        return etree.tostring(node, encoding='unicode', pretty_print=True)

    @api.constrains('action_id', 'date_start_field_id', 'date_stop_field_id', 'progress_field_id',
                    'parent_field_id', 'dependency_field_id', 'color_field_id', 'resource_field_id',
                    'deadline_field_id', 'group_by_field_id', 'column_field_ids')
    def _check_fields(self):
        for config in self:
            fields_ = (config.date_start_field_id | config.date_stop_field_id | config.progress_field_id
                       | config.parent_field_id | config.dependency_field_id | config.color_field_id
                       | config.resource_field_id | config.deadline_field_id | config.group_by_field_id
                       | config.column_field_ids)
            wrong = fields_.filtered(lambda f: f.model != config.model_name)
            if wrong:
                raise ValidationError(_("All fields must belong to the model of the selected action (%s).",
                                        config.model_name))
            existing = self.search([('action_id', '=', config.action_id.id), ('id', '!=', config.id)], limit=1)
            if existing:
                raise ValidationError(_("This action already has a Gantt setup: %s.", existing.name))

    def _sync_view(self):
        View = self.env['ir.ui.view'].sudo()
        Binding = self.env['axs.gantt.binding'].sudo()
        for config in self:
            if not config.active:
                config.binding_id.unlink()
                continue
            arch = config._build_arch()
            if config.view_id:
                config.view_id.write({'arch': arch, 'model': config.model_name,
                                      'name': 'axs.gantt.config.%s' % config.id})
            else:
                config.view_id = View.create({
                    'name': 'axs.gantt.config.%s' % config.id, 'type': 'axs_gantt',
                    'model': config.model_name, 'arch': arch, 'priority': 90,
                })
            if config.binding_id:
                config.binding_id.write({'action_id': config.action_id.id, 'view_id': config.view_id.id})
            else:
                config.binding_id = Binding.create({'action_id': config.action_id.id, 'view_id': config.view_id.id})

    @api.model_create_multi
    def create(self, vals_list):
        configs = super().create(vals_list)
        configs._sync_view()
        return configs

    def write(self, vals):
        res = super().write(vals)
        if not self.env.context.get('axs_gantt_syncing'):
            self.with_context(axs_gantt_syncing=True)._sync_view()
        return res

    def unlink(self):
        bindings = self.mapped('binding_id')
        views = self.mapped('view_id')
        res = super().unlink()
        bindings.sudo().unlink()
        views.sudo().unlink()
        return res

    def action_open(self):
        self.ensure_one()
        action = self.action_id.sudo().read()[0]
        return {key: action[key] for key in ('type', 'name', 'res_model', 'views', 'domain', 'context', 'target')
                if key in action}
