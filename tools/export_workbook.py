"""Export the provided 19-column workbook to a GitHub Pages-compatible CSV.
This is a DEVELOPMENT utility only; visitors never need Python or openpyxl.
Usage: python tools/export_workbook.py '/path/to/workbook.xlsx'
"""
from __future__ import annotations
import csv
import datetime as dt
import json
import sys
from pathlib import Path

try:
    from openpyxl import load_workbook
except ImportError:
    raise SystemExit('Install openpyxl to export a workbook: python -m pip install openpyxl')

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = [
    'Title', 'First Name', 'Last Name', 'Position', 'Organization', 'Biography',
    'Session - Name', 'Session - Details', 'Session - Date',
    'Session - Start Time', 'Session - End Time', 'Session - Location',
    'Session - Type', 'Session - Track', 'Paper Title', 'Presentation Status',
    'Presentation Type', 'Presentation Start Time', 'Presentation End Time',
]


def serialize(value):
    if value is None:
        return ''
    if isinstance(value, dt.datetime):
        return value.date().isoformat() if value.time() == dt.time() else value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, dt.time):
        return value.strftime('%H:%M:%S')
    return str(value)


def main(path):
    workbook = load_workbook(path, read_only=True, data_only=True)
    sheet = workbook.active
    values = sheet.values
    columns = list(next(values))
    if columns != COLUMNS:
        raise SystemExit(f'Unexpected workbook headers: {columns!r}')
    rows = [[serialize(cell) for cell in row] for row in values if any(value is not None for value in row)]
    target = ROOT / 'data' / 'agenda-snapshot.csv'
    with target.open('w', encoding='utf-8', newline='') as output:
        writer = csv.writer(output, lineterminator='\r\n')
        writer.writerow(columns)
        writer.writerows(rows)
    sessions = {
        (r[8], r[9], r[10], r[11], r[6])
        for r in rows
    }
    metadata = {
        'source': 'supplied-workbook',
        'sourceFile': Path(path).name,
        'createdAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'rowCount': len(rows),
        'sessionCount': len(sessions),
        'note': 'Local fallback snapshot generated from the user-provided workbook; not automatically live.',
    }
    (ROOT / 'data' / 'snapshot-metadata.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    print(f'Exported {len(rows)} rows, {len(sessions)} unique sessions to {target}; {target.stat().st_size} bytes')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python tools/export_workbook.py input.xlsx')
    main(Path(sys.argv[1]))
