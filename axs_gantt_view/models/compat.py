"""Small helpers that hide ORM API differences between Odoo versions."""


def can_access(model, operation):
    """Model level access check, returns a boolean."""
    if hasattr(model, 'has_access'):  # Odoo 18+
        return model.browse().has_access(operation)
    return model.check_access_rights(operation, raise_exception=False)


def check_access(records, operation):
    """Raise AccessError when the user cannot perform operation on records."""
    if hasattr(records, 'check_access'):
        records.check_access(operation)
    else:
        records.check_access_rights(operation)
        records.check_access_rule(operation)


def get_param(env, key, default=None):
    """Read a system parameter as a string (Odoo 20 replaced get_param by typed getters)."""
    icp = env['ir.config_parameter'].sudo()
    if hasattr(icp, 'get_str'):
        value = icp.get_str(key, default)
        return default if value in ('', None) and default is not None else value
    return icp.get_param(key, default)


def set_param(env, key, value):
    icp = env['ir.config_parameter'].sudo()
    if hasattr(icp, 'set_str'):
        return icp.set_str(key, value)
    return icp.set_param(key, value)


def binary_content(value):
    """Raw bytes of a Binary field value (Odoo 20 returns a BinaryValue, older versions base64)."""
    if not value:
        return b''
    if hasattr(value, 'content'):
        return value.content
    import base64
    return base64.b64decode(value)
