from lxml import etree

from odoo import api, fields, models, release
from odoo.exceptions import UserError, ValidationError
from odoo.tools.translate import _

GANTT_VIEW = 'axs_gantt'
# Odoo 16/17 already declare a 'gantt' type (used by other apps): keep our label distinct there
GANTT_LABEL = 'Gantt' if release.version_info[0] >= 18 else 'Gantt (AXSync)'

# arch attributes that must reference a field of the model, with allowed types
FIELD_ATTRS = {
    'date_start': ('date', 'datetime'),
    'date_stop': ('date', 'datetime'),
    'progress': ('float', 'integer', 'monetary'),
    'parent_field': ('many2one',),
    'color': ('many2one', 'integer', 'selection', 'char'),
    'deadline': ('date', 'datetime'),
    'milestone': ('boolean', 'selection'),
    'resource': ('many2one', 'many2many'),
    'dependency_field': ('many2many',),
    'allocated_hours': ('float', 'integer'),
    'sequence': ('integer',),
}


class IrUiView(models.Model):
    _inherit = 'ir.ui.view'

    type = fields.Selection(
        selection_add=[(GANTT_VIEW, GANTT_LABEL)],
        ondelete={GANTT_VIEW: 'cascade'},
    )

    def _get_view_info(self):
        # Odoo 18+ uses this to know the icon of each view type (no-op before)
        info = super()._get_view_info() if hasattr(super(), '_get_view_info') else {}
        # Odoo 20 replaced Font Awesome with Material Symbols
        info[GANTT_VIEW] = {'icon': 'view_timeline' if release.version_info[0] >= 20 else 'fa fa-tasks'}
        return info

    @api.model
    def _axs_gantt_check_arch(self, model_name, arch):
        """Validate the attributes of an <axs_gantt> root node."""
        Model = self.env[model_name]
        node = etree.fromstring(arch) if isinstance(arch, str) else arch
        if not node.get('date_start'):
            raise ValidationError(_("A Gantt view requires a 'date_start' attribute."))
        for attr, types in FIELD_ATTRS.items():
            fname = node.get(attr)
            if not fname:
                continue
            field = Model._fields.get(fname)
            if not field:
                raise ValidationError(_("Gantt view: field '%(field)s' (attribute %(attr)s) does not exist on %(model)s.",
                                        field=fname, attr=attr, model=model_name))
            if field.type not in types:
                raise ValidationError(_("Gantt view: field '%(field)s' used as %(attr)s must be of type %(types)s.",
                                        field=fname, attr=attr, types=', '.join(types)))

    @api.constrains('arch_db', 'type')
    def _axs_gantt_constrains_arch(self):
        for view in self:
            if view.type == GANTT_VIEW and view.model and view.model in self.env and not view.inherit_id:
                view._axs_gantt_check_arch(view.model, view.arch)


class Base(models.AbstractModel):
    _inherit = 'base'

    @api.model
    def _get_default_axs_gantt_view(self):
        """Build a Gantt view automatically when a model has no explicit one."""
        candidates_start = ['date_start', 'planned_date_begin', 'date_from', 'start', 'start_date',
                            'date_begin', 'date_planned_start', 'date']
        candidates_stop = ['date_stop', 'date_end', 'planned_date_end', 'date_to', 'stop', 'end_date',
                           'date_finished', 'date_planned_finished', 'date_deadline']
        dated = [n for n, f in self._fields.items() if f.type in ('date', 'datetime') and f.store]
        start = next((n for n in candidates_start if n in dated), None)
        if not start:
            raise UserError(_("No date field found to build a Gantt view for %s.", self._description))
        stop = next((n for n in candidates_stop if n in dated and n != start), None)
        node = etree.Element(GANTT_VIEW, date_start=start, string=self._description or self._name)
        if stop:
            node.set('date_stop', stop)
        if 'parent_id' in self._fields and self._fields['parent_id'].type == 'many2one' \
                and self._fields['parent_id'].comodel_name == self._name:
            node.set('parent_field', 'parent_id')
        if 'user_id' in self._fields and self._fields['user_id'].type == 'many2one':
            node.set('resource', 'user_id')
        return node
