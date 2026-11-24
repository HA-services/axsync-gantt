from odoo import api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools.translate import _

from .compat import check_access

LINK_TYPES = [
    ('fs', 'Finish to Start'),
    ('ss', 'Start to Start'),
    ('ff', 'Finish to Finish'),
    ('sf', 'Start to Finish'),
]


class AxsGanttLink(models.Model):
    _name = 'axs.gantt.link'
    _description = 'Gantt Dependency'
    _order = 'id'

    res_model = fields.Char(required=True, index=True)
    source_id = fields.Integer("Predecessor", required=True, index=True)
    target_id = fields.Integer("Successor", required=True, index=True)
    link_type = fields.Selection(LINK_TYPES, default='fs', required=True)
    lag_days = fields.Float("Lag (days)", help="Delay between the two tasks. Negative values create an overlap.")

    def _check_records(self):
        for link in self:
            if link.res_model not in self.env:
                raise ValidationError(_("Unknown model %s.", link.res_model))
            if link.source_id == link.target_id:
                raise ValidationError(_("A task cannot depend on itself."))
            records = self.env[link.res_model].browse([link.source_id, link.target_id]).exists()
            if len(records) != 2:
                raise ValidationError(_("The linked records do not exist anymore."))
            check_access(records.filtered(lambda r: r.id == link.target_id), 'write')

    @api.model_create_multi
    def create(self, vals_list):
        links = super().create(vals_list)
        links._check_records()
        return links

    def write(self, vals):
        res = super().write(vals)
        self._check_records()
        return res

    def unlink(self):
        for link in self:
            if link.res_model in self.env:
                target = self.env[link.res_model].browse(link.target_id).exists()
                if target:
                    check_access(target, 'write')
        return super().unlink()
