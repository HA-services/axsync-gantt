import base64
import io

from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tests.common import TransactionCase


@tagged('post_install', '-at_install', 'axs_gantt')
class TestGanttBase(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.Gantt = cls.env['axs.gantt']
        cal_a, cal_b = cls.env['resource.calendar'].create([{'name': 'Gantt A'}, {'name': 'Gantt B'}])
        cls.leaves = cls.env['resource.calendar.leaves'].create([
            {'name': 'Leave A', 'calendar_id': cal_a.id, 'date_from': '2026-03-02 08:00:00', 'date_to': '2026-03-03 17:00:00'},
            {'name': 'Leave B', 'calendar_id': cal_b.id, 'date_from': '2026-03-05 08:00:00', 'date_to': '2026-03-06 17:00:00'},
        ])
        cls.params = {'date_start': 'date_from', 'date_stop': 'date_to', 'fields': ['name']}

    def test_view_type_registered(self):
        types = dict(self.env['ir.ui.view']._fields['type'].selection)
        self.assertIn('axs_gantt', types)
        modes = dict(self.env['ir.actions.act_window.view']._fields['view_mode'].selection)
        self.assertIn('axs_gantt', modes)

    def test_default_view(self):
        arch = self.env['resource.calendar.leaves'].get_view(view_type='axs_gantt')['arch']
        self.assertIn('date_start="date_from"', arch)
        self.assertIn('date_stop="date_to"', arch)

    def test_arch_validation(self):
        with self.assertRaises(ValidationError):
            self.env['ir.ui.view'].create({
                'name': 'bad', 'type': 'axs_gantt', 'model': 'resource.calendar.leaves',
                'arch': '<axs_gantt date_start="name"/>',
            })

    def test_get_data(self):
        data = self.Gantt.get_data('resource.calendar.leaves', self.params, [('id', 'in', self.leaves.ids)])
        self.assertEqual(len(data['records']), 2)
        self.assertEqual(data['params']['date_start'], 'date_from')
        self.assertTrue(data['access']['write'])
        self.assertIn('workdays', data['calendar'])
        self.assertEqual(data['records'][0]['date_from'][:10], '2026-03-02')

    def test_get_data_ignores_unknown_fields(self):
        params = dict(self.params, progress='does_not_exist', fields=['nope', 'name'])
        data = self.Gantt.get_data('resource.calendar.leaves', params, [('id', 'in', self.leaves.ids)])
        self.assertNotIn('progress', data['params'])
        self.assertEqual(data['params']['fields'], ['name'])

    def test_links_and_cycles(self):
        a, b = self.leaves
        link_id = self.Gantt.add_link('resource.calendar.leaves', self.params, a.id, b.id, 'fs', 0)
        self.assertTrue(link_id.startswith('lnk-'))
        with self.assertRaises(ValidationError):
            self.Gantt.add_link('resource.calendar.leaves', self.params, b.id, a.id, 'fs', 0)
        with self.assertRaises(ValidationError):
            self.Gantt.add_link('resource.calendar.leaves', self.params, a.id, a.id, 'fs', 0)
        new_id = self.Gantt.update_link('resource.calendar.leaves', self.params, link_id, 'ss', 1.0)
        link = self.env['axs.gantt.link'].browse(int(new_id[4:]))
        self.assertEqual((link.link_type, link.lag_days), ('ss', 1.0))
        data = self.Gantt.get_data('resource.calendar.leaves', self.params, [('id', 'in', self.leaves.ids)])
        self.assertEqual(len(data['links']), 1)
        self.Gantt.remove_link('resource.calendar.leaves', self.params, new_id)
        self.assertFalse(link.exists())

    def test_move_and_restore(self):
        a, b = self.leaves
        self.Gantt.add_link('resource.calendar.leaves', self.params, a.id, b.id, 'fs', 0)
        params = dict(self.params, auto_schedule=True)
        res = self.Gantt.move('resource.calendar.leaves', params, a.id, '2026-03-04 08:00:00', '2026-03-05 17:00:00')
        self.assertEqual(sorted(res['changed']), sorted(self.leaves.ids))
        # b was pushed after a, keeping its duration
        self.assertEqual(str(b.date_from), '2026-03-05 17:00:00')
        self.assertEqual(str(b.date_to), '2026-03-07 02:00:00')
        self.Gantt.restore('resource.calendar.leaves', params, res['previous'])
        self.assertEqual(str(a.date_from), '2026-03-02 08:00:00')
        self.assertEqual(str(b.date_from), '2026-03-05 08:00:00')

    def test_move_manual_does_not_cascade(self):
        a, b = self.leaves
        self.Gantt.add_link('resource.calendar.leaves', self.params, a.id, b.id, 'fs', 0)
        res = self.Gantt.move('resource.calendar.leaves', self.params, a.id, '2026-03-04 08:00:00', '2026-03-05 17:00:00')
        self.assertEqual(res['changed'], [a.id])
        self.assertEqual(str(b.date_from), '2026-03-05 08:00:00')

    def test_export_xlsx(self):
        b64 = self.Gantt.export_xlsx('Plan', [{'label': 'ID'}, {'label': 'Name'}, {'label': 'Start', 'type': 'datetime'},
                                             {'label': 'Progress', 'type': 'percent'}],
                                     [{'values': ['1', 'Task', '2026-03-02 08:00:00', 40], 'level': 0,
                                       'start': '2026-03-02 08:00:00', 'stop': '2026-03-04 08:00:00'}],
                                     {'start': '2026-03-02', 'weeks': 2})
        content = base64.b64decode(b64)
        self.assertEqual(content[:2], b'PK')

    def test_settings_roundtrip(self):
        settings = self.env['res.config.settings'].create({
            'axs_gantt_hide_days_off': True, 'axs_gantt_sun': True, 'axs_gantt_sat': False,
            'axs_gantt_mon': False, 'axs_gantt_tue': False, 'axs_gantt_wed': False, 'axs_gantt_thu': False,
            'axs_gantt_fri': False, 'axs_gantt_quick_info': False, 'axs_gantt_default_scale': 'month',
        })
        settings.execute()
        values = self.Gantt.get_settings()
        self.assertTrue(values['hide_days_off'])
        self.assertEqual(values['hidden_weekdays'], [6])
        self.assertFalse(values['quick_info'])
        self.assertEqual(values['default_scale'], 'month')
        settings = self.env['res.config.settings'].create({
            'axs_gantt_sun': False, 'axs_gantt_sat': False, 'axs_gantt_mon': False, 'axs_gantt_tue': False,
            'axs_gantt_wed': False, 'axs_gantt_thu': False, 'axs_gantt_fri': False,
        })
        settings.execute()
        self.assertEqual(self.Gantt.get_settings()['hidden_weekdays'], [])

    def test_no_code_setup(self):
        action = self.env['ir.actions.act_window'].create({
            'name': 'Leaves', 'res_model': 'resource.calendar.leaves', 'view_mode': 'tree,form',
        })
        Fields = self.env['ir.model.fields']
        field = lambda name: Fields._get('resource.calendar.leaves', name)
        config = self.env['axs.gantt.config'].create({
            'name': 'Leaves plan', 'action_id': action.id,
            'date_start_field_id': field('date_from').id, 'date_stop_field_id': field('date_to').id,
            'column_field_ids': [(6, 0, [field('name').id])],
        })
        self.assertEqual(config.view_id.type, 'axs_gantt')
        self.assertIn('date_start="date_from"', config.view_id.arch)
        modes = [mode for _vid, mode in action.views]
        self.assertIn('axs_gantt', modes)
        self.assertLess(modes.index('axs_gantt'), modes.index('form'))
        config.active = False
        action.invalidate_recordset(['views']) if hasattr(action, 'invalidate_recordset') else action.invalidate_cache()
        self.assertNotIn('axs_gantt', [mode for _vid, mode in action.views])
        config.unlink()
        self.assertFalse(self.env['ir.ui.view'].search([('name', '=', 'axs.gantt.config.%s' % config.id)]))

    def test_no_code_setup_wrong_model(self):
        action = self.env['ir.actions.act_window'].create({
            'name': 'Partners', 'res_model': 'res.partner', 'view_mode': 'tree,form',
        })
        field = self.env['ir.model.fields']._get('resource.calendar.leaves', 'date_from')
        with self.assertRaises(ValidationError):
            self.env['axs.gantt.config'].create({'name': 'x', 'action_id': action.id, 'date_start_field_id': field.id})
