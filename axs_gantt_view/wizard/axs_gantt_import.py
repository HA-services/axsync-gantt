import base64
import io
import json
import logging
from datetime import datetime, timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.tools.translate import _

from ..models.compat import binary_content, can_access

_logger = logging.getLogger(__name__)

# accepted column headers (lower case) -> internal key
HEADERS = {
    'id': 'ref', 'ref': 'ref', 'wbs': 'ref', 'task id': 'ref',
    'name': 'name', 'task': 'name', 'task name': 'name', 'title': 'name',
    'start': 'start', 'start date': 'start', 'begin': 'start',
    'end': 'stop', 'end date': 'stop', 'finish': 'stop', 'stop': 'stop',
    'progress': 'progress', 'progress (%)': 'progress', 'complete': 'progress', '% complete': 'progress',
    'parent': 'parent', 'parent id': 'parent',
    'predecessors': 'predecessors', 'depends on': 'predecessors', 'dependencies': 'predecessors',
    'milestone': 'milestone', 'type': 'milestone',
    'duration (days)': 'duration', 'duration': 'duration',
}


def _parse_date(value):
    if value in (None, '', False):
        return False
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)) and 10000 < value < 100000:
        # Excel serial date (returned by xlrd)
        return datetime(1899, 12, 30) + timedelta(seconds=round(float(value) * 86400))
    text = str(value).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%SZ',
                '%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%d', '%d/%m/%Y', '%m/%d/%Y', '%d.%m.%Y'):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise UserError(_("Unrecognized date: %s (use YYYY-MM-DD or YYYY-MM-DD HH:MM).", text))


class AxsGanttImport(models.TransientModel):
    _name = 'axs.gantt.import'
    _description = 'Import Gantt Tasks'

    res_model = fields.Char(required=True)
    params_json = fields.Text(required=True)
    context_json = fields.Text()
    file = fields.Binary("File", required=True)
    filename = fields.Char()
    update_existing = fields.Boolean(
        "Update Existing Records", default=False,
        help="Use this to re-import a file exported from this database: rows whose ID is the ID of an existing "
             "record update that record (dates, progress...) instead of creating a new one. Leave it unchecked "
             "for files coming from another system.")
    result = fields.Text(readonly=True)

    # ------------------------------------------------------------------
    def _read_rows(self):
        raw = binary_content(self.file)
        name = (self.filename or '').lower()
        if name.endswith('.json') or raw[:1] in (b'{', b'['):
            try:
                data = json.loads(raw.decode('utf-8-sig'))
            except ValueError as e:
                raise UserError(_("Invalid JSON file: %s", e))
            tasks = data.get('tasks', []) if isinstance(data, dict) else data
            links = data.get('links', []) if isinstance(data, dict) else []
            rows = []
            for task in tasks:
                if not isinstance(task, dict):
                    continue
                row = {}
                for key, value in task.items():
                    mapped = HEADERS.get(str(key).lower()) or (key if key in ('ref', 'name', 'start', 'stop', 'progress', 'parent', 'milestone', 'duration') else None)
                    if key == 'end':
                        mapped = 'stop'
                    if mapped:
                        row[mapped] = value
                if 'ref' not in row and 'id' in task:
                    row['ref'] = task['id']
                rows.append(row)
            preds = {}
            for link in links:
                if isinstance(link, dict) and link.get('source') is not None and link.get('target') is not None:
                    preds.setdefault(str(link['target']), []).append(
                        (str(link['source']), link.get('type', 'fs'), float(link.get('lag') or 0.0)))
            for row in rows:
                row['_links'] = preds.get(str(row.get('ref')), [])
            return rows
        if name.endswith('.xlsx') or raw[:2] == b'PK':
            return self._read_xlsx(raw)
        raise UserError(_("Please upload an Excel (.xlsx) or JSON (.json) file."))

    def _read_xlsx(self, raw):
        try:
            import openpyxl
            book = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            sheet = book.worksheets[0]
            values = [list(r) for r in sheet.iter_rows(values_only=True)]
        except ImportError:
            import xlrd
            book = xlrd.open_workbook(file_contents=raw)
            sheet = book.sheet_by_index(0)
            values = [sheet.row_values(i) for i in range(sheet.nrows)]
        header_index, mapping = None, {}
        for index, row in enumerate(values[:20]):
            labels = [HEADERS.get(str(c).strip().lower()) if c is not None else None for c in row]
            if 'name' in labels and 'start' in labels:
                header_index = index
                mapping = {i: key for i, key in enumerate(labels) if key}
                break
        if header_index is None:
            raise UserError(_("The first sheet must contain a header row with at least the columns Name and Start."))
        rows = []
        for row in values[header_index + 1:]:
            item = {key: row[i] for i, key in mapping.items() if i < len(row)}
            if not item.get('name'):
                continue
            if isinstance(item.get('name'), str):
                item['name'] = item['name'].strip()
            preds = []
            for token in str(item.pop('predecessors', '') or '').replace(';', ',').split(','):
                token = token.strip()
                if not token:
                    continue
                link_type = 'fs'
                for suffix in ('FS', 'SS', 'FF', 'SF'):
                    if token.upper().endswith(suffix) and len(token) > 2:
                        link_type, token = suffix.lower(), token[:-2]
                        break
                ref = token.split('.')[0] if token.replace('.', '').isdigit() else token
                preds.append((ref, link_type, 0.0))
            item['_links'] = preds
            if item.get('ref') not in (None, ''):
                item['ref'] = str(item['ref']).split('.')[0] if isinstance(item['ref'], float) else str(item['ref'])
            rows.append(item)
        return rows

    # ------------------------------------------------------------------
    def _prepare_import_vals(self, vals):
        """Hook for bridge modules to add default values to the created records."""
        return vals

    def _import_parent_allowed(self, record, parent):
        """Hook: return False when record cannot be attached to parent."""
        return True

    def _import_row(self, Model, record, vals):
        if record:
            record.write(vals)
            return record
        return Model.create(vals)

    def action_import(self):
        self.ensure_one()
        if self.res_model not in self.env:
            raise UserError(_("Unknown model."))
        Model = self.env[self.res_model]
        ctx = {}
        if self.context_json:
            try:
                ctx = {k: v for k, v in json.loads(self.context_json).items() if k.startswith('default_')}
            except ValueError:
                ctx = {}
        Model = Model.with_context(**ctx)
        if not can_access(Model, 'create'):
            raise UserError(_("You are not allowed to create %s.", Model._description))
        Gantt = self.env['axs.gantt']
        params, _readable = Gantt._clean_params(Model, json.loads(self.params_json))
        rows = self._read_rows()
        if not rows:
            raise UserError(_("No task found in the file."))
        name_field = Model._rec_name if Model._rec_name in Model._fields else 'name'
        start_f, stop_f = params['date_start'], params.get('date_stop')
        progress_f = params.get('progress')
        if progress_f and Model._fields[progress_f].compute and not Model._fields[progress_f].inverse:
            progress_f = False
        ref_to_record = {}
        created = updated = skipped = 0
        parent_f = params.get('parent_field')
        for row in rows:
            vals = {name_field: str(row.get('name'))}
            start, stop = _parse_date(row.get('start')), _parse_date(row.get('stop'))
            if start:
                vals[start_f] = Gantt._parse_value(Model, start_f, start)
            if stop_f and stop:
                vals[stop_f] = Gantt._parse_value(Model, stop_f, stop)
            if progress_f and row.get('progress') not in (None, ''):
                try:
                    vals[progress_f] = float(str(row['progress']).replace('%', ''))
                except ValueError:
                    pass
            if 'axs_task_type' in Model._fields and str(row.get('milestone', '')).lower() in ('1', 'true', 'yes', 'milestone'):
                vals['axs_task_type'] = 'milestone'
            parent_ref = row.get('parent')
            if parent_f and parent_ref not in (None, '', False):
                parent_ref = str(parent_ref).split('.')[0] if isinstance(parent_ref, float) else str(parent_ref)
                parent = ref_to_record.get(parent_ref)
                if parent:
                    vals[parent_f] = parent.id
            vals = self._prepare_import_vals(vals)
            record = Model.browse()
            ref = str(row.get('ref')) if row.get('ref') not in (None, '') else None
            if self.update_existing and ref and ref.isdigit():
                record = Model.browse(int(ref)).exists()
                row['_existing'] = bool(record)
                # only the start is given: keep the duration of the existing record
                if record and start and stop_f and not stop and record[start_f] and record[stop_f]:
                    old_start = fields.Datetime.to_datetime(record[start_f])
                    old_stop = fields.Datetime.to_datetime(record[stop_f])
                    vals[stop_f] = Gantt._parse_value(Model, stop_f, start + (old_stop - old_start))
            try:
                with self.env.cr.savepoint():
                    record = self._import_row(Model, record, vals)
            except Exception:  # noqa: BLE001 - retry without the parent (e.g. private task)
                if parent_f not in vals:
                    raise
                vals.pop(parent_f)
                skipped += 1
                record = self._import_row(Model, record, vals)
            if row.get('_existing'):
                updated += 1
            else:
                created += 1
            if ref:
                ref_to_record[ref] = record
            row['_record'] = record
        # second pass: parents listed after their children, and dependencies
        links = 0
        for row in rows:
            record = row['_record']
            parent_ref = row.get('parent')
            if parent_f and parent_ref not in (None, '', False):
                parent_ref = str(parent_ref).split('.')[0] if isinstance(parent_ref, float) else str(parent_ref)
                parent = ref_to_record.get(parent_ref)
                if parent and parent != record and record[parent_f] != parent \
                        and self._import_parent_allowed(record, parent):
                    try:
                        with self.env.cr.savepoint():
                            record.write({parent_f: parent.id})
                    except Exception as e:  # noqa: BLE001 - validation or database constraint
                        skipped += 1
                        _logger.info("Gantt import: parent skipped: %s", e)
            for pred_ref, link_type, lag in row.get('_links') or []:
                pred = ref_to_record.get(str(pred_ref))
                if pred and pred != record:
                    try:
                        Gantt.add_link(self.res_model, params, pred.id, record.id, link_type, lag)
                        links += 1
                    except (UserError,) as e:
                        _logger.info("Gantt import: link skipped: %s", e)
        message = _("%(created)s created, %(updated)s updated, %(links)s dependencies.",
                    created=created, updated=updated, links=links)
        if skipped:
            message += ' ' + _("%s parent links could not be set.", skipped)
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {'title': _("Import done"), 'message': message, 'type': 'success', 'sticky': False,
                       'next': {'type': 'ir.actions.act_window_close'}},
        }
