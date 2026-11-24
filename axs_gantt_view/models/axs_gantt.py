import base64
import io
import logging
from collections import defaultdict, deque
from datetime import date, datetime, timedelta

from odoo import api, fields, models
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools.translate import _

from .compat import can_access, check_access, get_param
from .ir_ui_view import FIELD_ATTRS

_logger = logging.getLogger(__name__)

PARAM_PREFIX = 'axs_gantt.'
BOOL_SETTINGS = {
    'tooltip_start': True, 'tooltip_stop': True, 'tooltip_duration': True, 'tooltip_progress': True,
    'tooltip_deadline': True, 'tooltip_constraint': True, 'tooltip_resource': True, 'tooltip_fields': True,
    'dynamic_text': True, 'dynamic_progress': True, 'days_off': True, 'hide_days_off': False,
    'quick_info': True, 'stage_color': True,
}
MAX_CASCADE = 1000


def _to_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    return fields.Datetime.to_datetime(value)


class AxsGantt(models.AbstractModel):
    _name = 'axs.gantt'
    _description = 'AXSync Gantt View Service'

    # ------------------------------------------------------------------
    # settings
    # ------------------------------------------------------------------
    @api.model
    def get_settings(self):
        res = {}
        for key, default in BOOL_SETTINGS.items():
            raw = get_param(self.env, PARAM_PREFIX + key)
            res[key] = default if raw in (None, False, '') else raw in ('True', 'true', '1')
        hidden = get_param(self.env, PARAM_PREFIX + 'hidden_weekdays', '5,6')
        res['hidden_weekdays'] = [int(d) for d in (hidden or '').split(',') if d.strip().isdigit()]
        res['default_scale'] = get_param(self.env, PARAM_PREFIX + 'default_scale', 'week') or 'week'
        try:
            res['max_records'] = max(50, min(20000, int(get_param(self.env, PARAM_PREFIX + 'max_records', '2000'))))
        except ValueError:
            res['max_records'] = 2000
        res['is_admin'] = self.env.user.has_group('base.group_system')
        return res

    # ------------------------------------------------------------------
    # validation helpers
    # ------------------------------------------------------------------
    @api.model
    def _get_model(self, model):
        if not model or model not in self.env:
            raise UserError(_("Unknown model %s.", model))
        Model = self.env[model]
        if not can_access(Model, 'read'):
            raise AccessError(_("You are not allowed to read %s.", Model._description))
        return Model

    @api.model
    def _clean_params(self, Model, params):
        """Keep only attributes pointing to readable fields of the right type."""
        params = dict(params or {})
        readable = Model.fields_get(attributes=['type', 'string', 'selection', 'relation', 'readonly', 'store'])
        clean = {}
        for attr, types in FIELD_ATTRS.items():
            fname = params.get(attr)
            if fname and fname in readable and readable[fname]['type'] in types:
                clean[attr] = fname
        if not clean.get('date_start'):
            raise UserError(_("The Gantt view needs a readable start date field."))
        if clean.get('parent_field') and readable[clean['parent_field']].get('relation') != Model._name:
            clean.pop('parent_field')
        if clean.get('dependency_field') and readable[clean['dependency_field']].get('relation') != Model._name:
            clean.pop('dependency_field')
        clean['group_by'] = [g for g in (params.get('group_by') or []) if g.split(':')[0] in readable][:3]
        clean['fields'] = [f for f in (params.get('fields') or []) if f in readable][:30]
        clean['group_options'] = [g for g in (params.get('group_options') or []) if g in readable
                                  and readable[g]['type'] in ('many2one', 'many2many', 'selection', 'char', 'boolean')][:10]
        clean['auto_schedule'] = bool(params.get('auto_schedule'))
        clean['has_planning'] = 'axs_schedule_mode' in Model._fields and 'axs_schedule_mode' in readable
        return clean, readable

    @staticmethod
    def _dt_str(value):
        if not value:
            return False
        if isinstance(value, datetime):
            return fields.Datetime.to_string(value)
        if isinstance(value, date):
            return fields.Date.to_string(value)
        return value

    # ------------------------------------------------------------------
    # data loading
    # ------------------------------------------------------------------
    @api.model
    def get_data(self, model, params, domain=None, limit=None):
        Model = self._get_model(model)
        params, readable = self._clean_params(Model, params)
        settings = self.get_settings()
        limit = min(int(limit or settings['max_records']), 20000)

        read_fields = {'display_name'}
        for key in ('date_start', 'date_stop', 'progress', 'parent_field', 'color', 'deadline', 'milestone',
                    'resource', 'dependency_field', 'allocated_hours', 'sequence'):
            if params.get(key):
                read_fields.add(params[key])
        read_fields.update(g.split(':')[0] for g in params['group_by'])
        read_fields.update(params['fields'])
        planning_fields = []
        if params['has_planning']:
            planning_fields = ['axs_unscheduled', 'axs_task_type', 'axs_schedule_mode', 'axs_constraint_type',
                               'axs_constraint_date', 'axs_use_duration', 'axs_duration', 'axs_notify_90']
            read_fields.update(planning_fields)

        order = Model._order
        if params.get('sequence'):
            order = '%s, id' % params['sequence']
        records = Model.search(domain or [], limit=limit + 1, order=order)
        truncated = len(records) > limit
        records = records[:limit]
        rows = records.read(sorted(read_fields))

        # names of many2many resources / extra many2many fields
        m2m_names = {}
        for fname in read_fields:
            meta = readable.get(fname)
            if meta and meta['type'] in ('many2many', 'one2many') and fname != params.get('dependency_field'):
                ids = {i for row in rows for i in (row.get(fname) or [])}
                m2m_names[fname] = self._names(meta['relation'], ids)

        ids_set = set(records.ids)
        result_rows = []
        for row in rows:
            item = {key: row.get(key) for key in read_fields}
            item['id'] = row['id']
            for fname in read_fields:
                meta = readable.get(fname, {})
                if meta.get('type') in ('date', 'datetime'):
                    item[fname] = self._dt_str(row.get(fname))
                elif fname in m2m_names:
                    item[fname] = [[i, m2m_names[fname].get(i, '#%s' % i)] for i in row.get(fname) or []]
            if params.get('dependency_field'):
                item[params['dependency_field']] = [i for i in row.get(params['dependency_field']) or []
                                                    if i in ids_set]
            result_rows.append(item)

        links = self._get_links(Model, params, records)

        markers = []
        if hasattr(Model, '_axs_gantt_markers'):
            try:
                markers = Model._axs_gantt_markers(records)
            except AccessError:
                markers = []

        dates = [_to_dt(r.get(params['date_start'])) for r in rows if r.get(params['date_start'])]
        if params.get('date_stop'):
            dates += [_to_dt(r.get(params['date_stop'])) for r in rows if r.get(params['date_stop'])]
        calendar = self._get_calendar_info(min(dates) if dates else None, max(dates) if dates else None)

        meta_fields = {}
        for fname in read_fields:
            if fname in readable:
                meta = readable[fname]
                meta_fields[fname] = {
                    'string': meta.get('string'),
                    'type': meta.get('type'),
                    'selection': meta.get('selection') if meta.get('type') == 'selection' else False,
                    'relation': meta.get('relation') or False,
                    'readonly': bool(meta.get('readonly')),
                }
        return {
            'records': result_rows,
            'links': links,
            'truncated': truncated,
            'limit': limit,
            'params': params,
            'fields': meta_fields,
            'settings': settings,
            'calendar': calendar,
            'markers': markers,
            'access': {
                'create': can_access(Model, 'create'),
                'write': can_access(Model, 'write'),
                'unlink': can_access(Model, 'unlink'),
            },
            'model_description': Model._description,
            'group_options': [{'name': g, 'string': readable[g]['string']} for g in params['group_options']],
        }

    @api.model
    def _names(self, model, ids):
        if not ids or model not in self.env:
            return {}
        records = self.env[model].browse(list(ids)).exists()
        try:
            return {r.id: r.display_name for r in records}
        except AccessError:
            return {r.id: r.sudo().display_name for r in records}

    @api.model
    def _get_links(self, Model, params, records):
        links = []
        ids = set(records.ids)
        dep = params.get('dependency_field')
        if dep:
            for rec in records:
                for pred in rec[dep]:
                    if pred.id in ids:
                        links.append({'id': 'dep-%s-%s' % (pred.id, rec.id), 'source': pred.id, 'target': rec.id,
                                      'type': 'fs', 'lag': 0.0, 'native': True})
        if ids:
            for link in self.env['axs.gantt.link'].sudo().search([
                    ('res_model', '=', Model._name), ('source_id', 'in', list(ids)), ('target_id', 'in', list(ids))]):
                links.append({'id': 'lnk-%s' % link.id, 'source': link.source_id, 'target': link.target_id,
                              'type': link.link_type, 'lag': link.lag_days, 'native': False})
        return links

    @api.model
    def _get_calendar_info(self, start, stop):
        company = self.env.company
        calendar = company.resource_calendar_id
        workdays = list(range(5))
        hours_per_day = 8.0
        if calendar:
            days = sorted({int(a.dayofweek) for a in calendar.sudo().attendance_ids
                           if not getattr(a, 'display_type', False)})
            workdays = days or workdays
            hours_per_day = calendar.hours_per_day or hours_per_day
        today = fields.Datetime.now()
        start = (start or today) - timedelta(days=400)
        stop = (stop or today) + timedelta(days=400)
        leaves = []
        domain = [('resource_id', '=', False), ('date_to', '>=', start), ('date_from', '<=', stop)]
        if calendar:
            domain.append(('calendar_id', 'in', [calendar.id, False]))
        for leave in self.env['resource.calendar.leaves'].sudo().search(domain, limit=2000):
            leaves.append({'name': leave.name or _("Public holiday"),
                           'start': fields.Datetime.to_string(leave.date_from),
                           'stop': fields.Datetime.to_string(leave.date_to)})
        return {'workdays': workdays, 'hours_per_day': hours_per_day, 'leaves': leaves,
                'calendar_name': calendar.name if calendar else False}

    # ------------------------------------------------------------------
    # scheduling
    # ------------------------------------------------------------------
    @api.model
    def _parse_value(self, Model, fname, value):
        field = Model._fields[fname]
        if not value:
            return False
        dt = fields.Datetime.to_datetime(value)
        return dt.date() if field.type == 'date' else dt

    @api.model
    def _is_auto(self, rec, params):
        if params['has_planning']:
            return rec.axs_schedule_mode == 'auto' and rec.axs_constraint_type not in ('mso', 'mfo')
        return params['auto_schedule']

    @api.model
    def _successors(self, Model, params, rec):
        """Return list of (successor_record, link_type, lag_days)."""
        result = []
        dep = params.get('dependency_field')
        if dep:
            for succ in Model.search([(dep, 'in', rec.ids)]):
                result.append((succ, 'fs', 0.0))
        for link in self.env['axs.gantt.link'].sudo().search([('res_model', '=', Model._name), ('source_id', '=', rec.id)]):
            succ = Model.browse(link.target_id).exists()
            if succ:
                result.append((succ, link.link_type, link.lag_days))
        return result

    @api.model
    def move(self, model, params, record_id, start, stop=None):
        """Write new dates on a record then reschedule automatic successors/children.

        Returns the previous values of every changed record so the client can undo.
        """
        Model = self._get_model(model)
        params, _readable = self._clean_params(Model, params)
        start_f, stop_f = params['date_start'], params.get('date_stop')
        rec = Model.browse(int(record_id)).exists()
        if not rec:
            raise UserError(_("This record does not exist anymore."))
        check_access(rec, 'write')
        previous = {}

        def snapshot(r):
            if r.id not in previous:
                previous[r.id] = {start_f: self._dt_str(r[start_f])}
                if stop_f:
                    previous[r.id][stop_f] = self._dt_str(r[stop_f])

        def write_dates(r, new_start, new_stop):
            snapshot(r)
            vals = {start_f: self._parse_value(Model, start_f, new_start)}
            if stop_f:
                vals[stop_f] = self._parse_value(Model, stop_f, new_stop)
            if 'axs_unscheduled' in Model._fields and r.axs_unscheduled:
                vals['axs_unscheduled'] = False
            r.write(vals)

        old_start = _to_dt(rec[start_f])
        write_dates(rec, start, stop)
        new_start = _to_dt(rec[start_f])

        queue = deque()
        queue.append((rec, (new_start - old_start) if (old_start and new_start) else None))
        seen = {rec.id}
        count = 0
        while queue and count < MAX_CASCADE:
            current, delta = queue.popleft()
            count += 1
            cur_start, cur_stop = _to_dt(current[start_f]), _to_dt(current[stop_f]) if stop_f else None
            # children follow their parent when in automatic mode
            if params.get('parent_field') and delta:
                for child in Model.search([(params['parent_field'], '=', current.id)]):
                    if child.id in seen or not self._is_auto(child, params) or not child[start_f]:
                        continue
                    c_start = _to_dt(child[start_f]) + delta
                    c_stop = _to_dt(child[stop_f]) + delta if stop_f and child[stop_f] else None
                    write_dates(child, c_start, c_stop)
                    seen.add(child.id)
                    queue.append((child, delta))
            # successors are pushed forward when they would start too early
            if not cur_start:
                continue
            for succ, link_type, lag in self._successors(Model, params, current):
                if succ.id in seen or not self._is_auto(succ, params) or not succ[start_f]:
                    continue
                s_start = _to_dt(succ[start_f])
                s_stop = _to_dt(succ[stop_f]) if stop_f and succ[stop_f] else None
                duration = (s_stop - s_start) if s_stop else timedelta(0)
                lag_td = timedelta(days=lag or 0.0)
                pred_end = cur_stop or cur_start
                if link_type == 'fs':
                    required_start = pred_end + lag_td
                elif link_type == 'ss':
                    required_start = cur_start + lag_td
                elif link_type == 'ff':
                    required_start = pred_end + lag_td - duration
                else:  # sf
                    required_start = cur_start + lag_td - duration
                if params['has_planning'] and succ.axs_constraint_type == 'snet' and succ.axs_constraint_date:
                    required_start = max(required_start, succ.axs_constraint_date)
                if s_start < required_start:
                    shift = required_start - s_start
                    write_dates(succ, s_start + shift, (s_stop + shift) if s_stop else None)
                    seen.add(succ.id)
                    queue.append((succ, shift))
        return {'changed': list(previous.keys()), 'previous': previous}

    @api.model
    def restore(self, model, params, previous):
        """Undo: write back previous date values returned by move()."""
        Model = self._get_model(model)
        params, _readable = self._clean_params(Model, params)
        allowed = {params['date_start'], params.get('date_stop')}
        for rid, vals in (previous or {}).items():
            rec = Model.browse(int(rid)).exists()
            if not rec:
                continue
            check_access(rec, 'write')
            clean = {k: self._parse_value(Model, k, v) for k, v in vals.items() if k in allowed}
            rec.with_context(axs_gantt_no_sync=False).write(clean)
        return True

    # ------------------------------------------------------------------
    # dependencies
    # ------------------------------------------------------------------
    @api.model
    def _graph(self, Model, params):
        graph = defaultdict(set)
        dep = params.get('dependency_field')
        if dep:
            for rec in Model.search([(dep, '!=', False)]):
                for pred in rec[dep]:
                    graph[pred.id].add(rec.id)
        for link in self.env['axs.gantt.link'].sudo().search([('res_model', '=', Model._name)]):
            graph[link.source_id].add(link.target_id)
        return graph

    @api.model
    def add_link(self, model, params, source_id, target_id, link_type='fs', lag=0.0):
        Model = self._get_model(model)
        params, _readable = self._clean_params(Model, params)
        source_id, target_id = int(source_id), int(target_id)
        if source_id == target_id:
            raise ValidationError(_("A task cannot depend on itself."))
        if link_type not in ('fs', 'ss', 'ff', 'sf'):
            raise ValidationError(_("Unknown dependency type."))
        target = Model.browse(target_id).exists()
        source = Model.browse(source_id).exists()
        if not target or not source:
            raise UserError(_("This record does not exist anymore."))
        check_access(target, 'write')
        graph = self._graph(Model, params)
        if source_id in graph.get(target_id, set()) or target_id in graph.get(source_id, set()):
            raise ValidationError(_("These two tasks are already linked."))
        # cycle detection: is source reachable from target?
        stack, seen = [target_id], set()
        while stack:
            node = stack.pop()
            if node == source_id:
                raise ValidationError(_("This dependency would create a loop."))
            if node in seen:
                continue
            seen.add(node)
            stack.extend(graph.get(node, ()))
        dep = params.get('dependency_field')
        if dep and link_type == 'fs' and not lag:
            target.write({dep: [(4, source_id)]})
            return 'dep-%s-%s' % (source_id, target_id)
        link = self.env['axs.gantt.link'].create({
            'res_model': Model._name, 'source_id': source_id, 'target_id': target_id,
            'link_type': link_type, 'lag_days': lag or 0.0,
        })
        return 'lnk-%s' % link.id

    @api.model
    def remove_link(self, model, params, link_id):
        Model = self._get_model(model)
        params, _readable = self._clean_params(Model, params)
        if link_id.startswith('dep-') and params.get('dependency_field'):
            _prefix, source_id, target_id = link_id.split('-')
            target = Model.browse(int(target_id)).exists()
            if target:
                check_access(target, 'write')
                target.write({params['dependency_field']: [(3, int(source_id))]})
            return True
        if link_id.startswith('lnk-'):
            link = self.env['axs.gantt.link'].browse(int(link_id[4:])).exists()
            if link and link.res_model == Model._name:
                link.unlink()
            return True
        return False

    @api.model
    def update_link(self, model, params, link_id, link_type, lag=0.0):
        Model = self._get_model(model)
        params, _readable = self._clean_params(Model, params)
        if link_id.startswith('lnk-'):
            link = self.env['axs.gantt.link'].browse(int(link_id[4:])).exists()
            if link and link.res_model == Model._name:
                link.write({'link_type': link_type, 'lag_days': lag or 0.0})
                return link_id
            return False
        _prefix, source_id, target_id = link_id.split('-')
        if link_type == 'fs' and not lag:
            return link_id
        self.remove_link(model, params, link_id)
        link = self.env['axs.gantt.link'].create({
            'res_model': Model._name, 'source_id': int(source_id), 'target_id': int(target_id),
            'link_type': link_type, 'lag_days': lag or 0.0,
        })
        return 'lnk-%s' % link.id

    # ------------------------------------------------------------------
    # export
    # ------------------------------------------------------------------
    @api.model
    def export_xlsx(self, title, columns, rows, timeline=None):
        """Build an Excel workbook from rows prepared by the client.

        columns: list of {'label', 'type'} ; rows: list of {'values': [...], 'level', 'start', 'stop', 'color'}
        timeline: {'start': 'YYYY-MM-DD', 'weeks': n}
        """
        import xlsxwriter
        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output, {'in_memory': True})
        sheet = workbook.add_worksheet((title or 'Gantt')[:31].replace('/', '-'))
        bold = workbook.add_format({'bold': True, 'bg_color': '#E9ECEF', 'border': 1})
        date_fmt = workbook.add_format({'num_format': 'yyyy-mm-dd hh:mm'})
        pct_fmt = workbook.add_format({'num_format': '0"%"'})
        title_fmt = workbook.add_format({'bold': True, 'font_size': 14})
        sheet.write(0, 0, title or 'Gantt', title_fmt)
        header_row = 2
        for col, column in enumerate(columns):
            sheet.write(header_row, col, column.get('label') or '', bold)
            sheet.set_column(col, col, 40 if col == 1 else 16)
        indent_formats = {}
        for r, row in enumerate(rows, start=header_row + 1):
            for c, value in enumerate(row.get('values') or []):
                ctype = columns[c].get('type') if c < len(columns) else 'char'
                if value in (None, False, ''):
                    continue
                if ctype == 'datetime':
                    try:
                        sheet.write_datetime(r, c, fields.Datetime.to_datetime(value), date_fmt)
                    except (ValueError, TypeError):
                        sheet.write(r, c, str(value))
                elif ctype == 'percent':
                    sheet.write_number(r, c, float(value), pct_fmt)
                elif ctype == 'number':
                    sheet.write_number(r, c, float(value))
                elif c == 1 and row.get('level'):
                    level = min(int(row['level']), 10)
                    if level not in indent_formats:
                        indent_formats[level] = workbook.add_format({'indent': level})
                    sheet.write(r, c, str(value), indent_formats[level])
                else:
                    sheet.write(r, c, str(value))
        # simple weekly timeline drawn with cell colours
        if timeline and timeline.get('start') and rows:
            start = fields.Date.to_date(timeline['start'])
            weeks = max(1, min(int(timeline.get('weeks') or 1), 156))
            first_col = len(columns) + 1
            week_fmt = workbook.add_format({'bold': True, 'bg_color': '#E9ECEF', 'border': 1, 'font_size': 8,
                                            'rotation': 90})
            fills = {}
            for w in range(weeks):
                day = start + timedelta(weeks=w)
                sheet.write(header_row, first_col + w, day.strftime('%d %b %y'), week_fmt)
                sheet.set_column(first_col + w, first_col + w, 2.6)
            sheet.set_row(header_row, 60)
            for r, row in enumerate(rows, start=header_row + 1):
                if not row.get('start'):
                    continue
                r_start = fields.Datetime.to_datetime(row['start']).date()
                r_stop = fields.Datetime.to_datetime(row.get('stop') or row['start']).date()
                color = row.get('color') or '#3F7FBF'
                if color not in fills:
                    fills[color] = workbook.add_format({'bg_color': color})
                for w in range(weeks):
                    w_start = start + timedelta(weeks=w)
                    w_stop = w_start + timedelta(days=7)
                    if r_start < w_stop and r_stop >= w_start:
                        sheet.write_blank(r, first_col + w, None, fills[color])
        sheet.freeze_panes(header_row + 1, 2)
        workbook.close()
        return base64.b64encode(output.getvalue()).decode()
