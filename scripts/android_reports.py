"""Reassemble bounded Android verification reports without trusting log metadata."""
from collections import OrderedDict
import json


def read_reports(text):
    groups = OrderedDict()
    reports = []
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(record, dict):
            continue
        if record.get('event') != 'arxd-evidence-part':
            reports.append(record)
            continue
        identity, index, parts, data = (record.get(key) for key in ['id', 'index', 'parts', 'data'])
        if not isinstance(identity, str) or len(identity) > 80 or type(index) is not int or type(parts) is not int or not 0 <= index < parts <= 1024 or not isinstance(data, str) or len(data) > 700:
            continue
        expected, chunks = groups.setdefault(identity, (parts, {}))
        if len(groups) > 128:
            groups.popitem(last=False)
        if expected != parts:
            groups.pop(identity, None)
            continue
        chunks[index] = data
        if len(chunks) == parts:
            value = ''.join(chunks[i] for i in range(parts))
            groups.pop(identity, None)
            # JSON text can contain split UTF-16 surrogates from separate native
            # calls. Round-trip pairs before decoding the assembled report.
            try:
                value = value.encode('utf-16', 'surrogatepass').decode('utf-16')
            except UnicodeError:
                continue
            if len(value.encode()) > 196608:
                continue
            try:
                complete = json.loads(value)
            except ValueError:
                continue
            if isinstance(complete, dict):
                reports.append(complete)
    return reports
