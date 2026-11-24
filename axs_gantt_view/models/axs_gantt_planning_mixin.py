import logging
from datetime import date, datetime, timedelta

from odoo import api, fields, models
from odoo.tools.translate import _

from .compat import get_param

_logger = logging.getLogger(__name__)

CONSTRAINT_TYPES = [
    ('asap', 'As Soon As Possible'),
    ('snet', 'Start No Earlier Than'),
    ('snlt', 'Start No Later Than'),
    ('fnet', 'Finish No Earlier Than'),
    ('fnlt', 'Finish No Later Than'),
    ('mso', 'Must Start On'),
    ('mfo', 'Must Finish On'),
]


def _to_datetime(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    return fields.Datetime.to_datetime(value)


class AxsGanttPlanningMixin(models.AbstractModel):
    """Planning options shown in the "Gantt Planning" tab of a record.

    Inheriting models set the three class attributes below to the names of
    their own start, end and progress fields.
    """
    _name = 'axs.gantt.planning.mixin'
    _description = 'Gantt Planning Options'

    _axs_gantt_start_field = 'date_start'
    _axs_gantt_stop_field = 'date_stop'
    _axs_gantt_progress_field = False

    axs_unscheduled = fields.Boolean(
        "Unscheduled", copy=False,
        help="Hide the bar from the Gantt timeline while keeping the record in the task list.")
    axs_task_type = fields.Selection(
        [('task', 'Task'), ('milestone', 'Milestone')], string="Gantt Type", default='task',
        help="Milestones are displayed as a diamond on their start date.")
    axs_use_duration = fields.Boolean(
        "Plan by Duration", help="Enter a start date and a duration, the end date is computed for you.")
    axs_duration = fields.Float("Duration (days)", help="Planned duration in calendar days.")
    axs_schedule_mode = fields.Selection(
        [('manual', 'Manual'), ('auto', 'Automatic')], string="Schedule Mode", default='manual',
        help="Automatic: the record follows its parent and its predecessors when they move.\n"
             "Manual: dates only change when you change them.")
    axs_constraint_type = fields.Selection(CONSTRAINT_TYPES, string="Constraint", default='asap')
    axs_constraint_date = fields.Datetime("Constraint Date")
    axs_notify_90 = fields.Boolean(
        "Send Email at 90%",
        help="Notify the users configured in the Gantt settings when this record reaches 90% progress.")
    axs_notified_90 = fields.Boolean(copy=False, readonly=True)

    # ------------------------------------------------------------------
    # duration helpers
    # ------------------------------------------------------------------
    def _axs_compute_stop_from_duration(self, start, duration):
        if not start or not duration:
            return False
        stop = _to_datetime(start) + timedelta(days=duration)
        field = self._fields.get(self._axs_gantt_stop_field)
        if field and field.type == 'date':
            return stop.date()
        return stop

    @api.onchange('axs_use_duration', 'axs_duration')
    def _onchange_axs_duration(self):
        for rec in self:
            if rec.axs_use_duration and rec.axs_duration:
                stop = rec._axs_compute_stop_from_duration(rec[rec._axs_gantt_start_field], rec.axs_duration)
                if stop:
                    rec[rec._axs_gantt_stop_field] = stop

    def _axs_sync_duration(self, vals):
        start_f, stop_f = self._axs_gantt_start_field, self._axs_gantt_stop_field
        if not ({start_f, stop_f, 'axs_duration', 'axs_use_duration'} & set(vals)):
            return
        for rec in self.filtered('axs_use_duration'):
            start = rec[start_f]
            if not start:
                continue
            if stop_f in vals and 'axs_duration' not in vals and rec[stop_f]:
                delta = _to_datetime(rec[stop_f]) - _to_datetime(start)
                rec.with_context(axs_gantt_no_sync=True).write(
                    {'axs_duration': round(delta.total_seconds() / 86400.0, 2)})
            elif rec.axs_duration:
                stop = rec._axs_compute_stop_from_duration(start, rec.axs_duration)
                if stop and stop != rec[stop_f]:
                    rec.with_context(axs_gantt_no_sync=True).write({stop_f: stop})

    # ------------------------------------------------------------------
    # 90% notification
    # ------------------------------------------------------------------
    def _axs_notify_users(self):
        param = get_param(self.env, 'axs_gantt.notify_user_ids', '') or ''
        ids = [int(x) for x in param.split(',') if x.strip().isdigit()]
        return self.env['res.users'].sudo().browse(ids).exists()

    def _axs_check_progress_notification(self):
        progress_f = self._axs_gantt_progress_field
        if not progress_f:
            return
        users = None
        for rec in self:
            progress = rec[progress_f] or 0.0
            if progress < 90 and rec.axs_notified_90:
                rec.with_context(axs_gantt_no_sync=True).sudo().write({'axs_notified_90': False})
            elif progress >= 90 and rec.axs_notify_90 and not rec.axs_notified_90:
                if users is None:
                    users = self._axs_notify_users()
                rec.with_context(axs_gantt_no_sync=True).sudo().write({'axs_notified_90': True})
                if users:
                    rec._axs_send_progress_email(users, progress)

    def _axs_send_progress_email(self, users, progress):
        self.ensure_one()
        subject = _("%(name)s reached %(progress)s%%", name=self.display_name, progress=int(progress))
        body = _("<p><b>%(name)s</b> reached <b>%(progress)s%%</b> progress.</p>",
                 name=self.display_name, progress=int(progress))
        partners = users.mapped('partner_id')
        if hasattr(self, 'message_post'):
            self.sudo().message_post(
                body=self._axs_markup(body), subject=subject, partner_ids=partners.ids,
                subtype_xmlid='mail.mt_comment', message_type='comment')
        else:
            emails = [p.email for p in partners if p.email]
            if emails:
                self.env['mail.mail'].sudo().create({
                    'subject': subject,
                    'body_html': body,
                    'email_to': ','.join(emails),
                }).send()

    @staticmethod
    def _axs_markup(html):
        from markupsafe import Markup
        return Markup(html)

    # ------------------------------------------------------------------
    # ORM
    # ------------------------------------------------------------------
    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        if not self.env.context.get('axs_gantt_no_sync'):
            for rec, vals in zip(records, vals_list):
                rec._axs_sync_duration(vals)
            records._axs_check_progress_notification()
        return records

    def write(self, vals):
        res = super().write(vals)
        if not self.env.context.get('axs_gantt_no_sync'):
            self._axs_sync_duration(vals)
            if self._axs_gantt_progress_field and (
                    self._axs_gantt_progress_field in vals or 'axs_notify_90' in vals):
                self._axs_check_progress_notification()
        return res

    def unlink(self):
        if self.ids:
            self.env['axs.gantt.link'].sudo().search([
                ('res_model', '=', self._name),
                '|', ('source_id', 'in', self.ids), ('target_id', 'in', self.ids),
            ]).unlink()
        return super().unlink()
