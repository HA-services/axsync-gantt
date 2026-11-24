from . import models
from . import wizard


def uninstall_hook(env_or_cr, registry=None):
    """Remove the parameters written by the settings screen."""
    if registry is not None:  # Odoo 16 passes (cr, registry)
        from odoo import api, SUPERUSER_ID
        env = api.Environment(env_or_cr, SUPERUSER_ID, {})
    else:
        env = env_or_cr
    env['ir.config_parameter'].sudo().search([('key', '=like', 'axs_gantt.%')]).unlink()
