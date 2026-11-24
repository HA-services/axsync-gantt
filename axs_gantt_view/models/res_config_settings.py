from odoo import api, fields, models

from .axs_gantt_config import SCALES
from .compat import get_param, set_param

WEEKDAYS = [('0', 'Monday'), ('1', 'Tuesday'), ('2', 'Wednesday'), ('3', 'Thursday'),
            ('4', 'Friday'), ('5', 'Saturday'), ('6', 'Sunday')]
P = 'axs_gantt.'


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    axs_gantt_tooltip_start = fields.Boolean("Start Date", default=True)
    axs_gantt_tooltip_stop = fields.Boolean("End Date", default=True)
    axs_gantt_tooltip_duration = fields.Boolean("Duration", default=True)
    axs_gantt_tooltip_progress = fields.Boolean("Progress", default=True)
    axs_gantt_tooltip_deadline = fields.Boolean("Deadline", default=True)
    axs_gantt_tooltip_constraint = fields.Boolean("Constraint", default=True)
    axs_gantt_tooltip_resource = fields.Boolean("Assigned Resource", default=True)
    axs_gantt_tooltip_fields = fields.Boolean("Additional Fields", default=True)
    axs_gantt_dynamic_text = fields.Boolean("Dynamic Text", default=True)
    axs_gantt_dynamic_progress = fields.Boolean("Dynamic Progress", default=True)
    axs_gantt_days_off = fields.Boolean("Highlight Days Off", default=True)
    axs_gantt_hide_days_off = fields.Boolean("Hide Days Off")
    axs_gantt_quick_info = fields.Boolean("Quick Info", default=True)
    axs_gantt_stage_color = fields.Boolean("Stage Color", default=True)
    axs_gantt_mon = fields.Boolean("Monday")
    axs_gantt_tue = fields.Boolean("Tuesday")
    axs_gantt_wed = fields.Boolean("Wednesday")
    axs_gantt_thu = fields.Boolean("Thursday")
    axs_gantt_fri = fields.Boolean("Friday")
    axs_gantt_sat = fields.Boolean("Saturday")
    axs_gantt_sun = fields.Boolean("Sunday")
    axs_gantt_default_scale = fields.Selection(SCALES, string="Default Scale", default='week')
    axs_gantt_max_records = fields.Integer("Maximum Records", default=2000)
    axs_gantt_notify_user_ids = fields.Many2many(
        'res.users', 'axs_gantt_settings_notify_rel', 'settings_id', 'user_id',
        string="Notify at 90%")

    _AXS_BOOLS = ['tooltip_start', 'tooltip_stop', 'tooltip_duration', 'tooltip_progress', 'tooltip_deadline',
                  'tooltip_constraint', 'tooltip_resource', 'tooltip_fields', 'dynamic_text', 'dynamic_progress',
                  'days_off', 'hide_days_off', 'quick_info', 'stage_color']
    _AXS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

    @api.model
    def get_values(self):
        res = super().get_values()
        settings = self.env['axs.gantt'].get_settings()
        for key in self._AXS_BOOLS:
            res['axs_gantt_' + key] = settings[key]
        for index, day in enumerate(self._AXS_DAYS):
            res['axs_gantt_' + day] = index in settings['hidden_weekdays']
        res['axs_gantt_default_scale'] = settings['default_scale']
        res['axs_gantt_max_records'] = settings['max_records']
        ids = [int(x) for x in (get_param(self.env, P + 'notify_user_ids') or '').split(',') if x.strip().isdigit()]
        res['axs_gantt_notify_user_ids'] = [(6, 0, self.env['res.users'].browse(ids).exists().ids)]
        return res

    def set_values(self):
        super().set_values()
        if not self.env.user.has_group('base.group_system'):
            return
        for key in self._AXS_BOOLS:
            set_param(self.env, P + key, 'True' if self['axs_gantt_' + key] else 'False')
        days = [str(i) for i, day in enumerate(self._AXS_DAYS) if self['axs_gantt_' + day]]
        set_param(self.env, P + 'hidden_weekdays', ','.join(days) or 'none')
        set_param(self.env, P + 'default_scale', self.axs_gantt_default_scale or 'week')
        set_param(self.env, P + 'max_records', str(max(50, min(20000, self.axs_gantt_max_records or 2000))))
        set_param(self.env, P + 'notify_user_ids', ','.join(str(i) for i in self.axs_gantt_notify_user_ids.ids))
