"""Optional GitHub Actions utility: sync the published CSV into local fallback.

No credentials, proxies, or third-party packages. Refuses to replace the
snapshot if the download fails or obvious schema/content validation fails.
Usage: python tools/sync_live_csv.py
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = (
    'https://docs.google.com/spreadsheets/d/e/'
    '2PACX-1vR7XZFOcEKOxCsw8Yb1LJpdSj_VUhncQMaGqTIOW19PRN1jr9Df4b_-_hmJ7dOHvUUXe4dCezqVn2Hd/'
    'pub?gid=0&single=true&output=csv'
)
REQUIRED = {
    'Session - Name', 'Session - Date', 'Session - Start Time',
    'Session - End Time', 'Session - Location', 'Paper Title',
    'Presentation Start Time', 'Presentation End Time',
}


def validate(data: bytes):
    if not data or len(data) < 100:
        raise ValueError('Downloaded CSV is empty or implausibly short')
    text = data.decode('utf-8-sig')
    if text.lstrip().lower().startswith(('<!doctype', '<html')):
        raise ValueError('Google Sheets URL returned HTML instead of CSV')
    reader = csv.DictReader(io.StringIO(text, newline=''))
    headers = reader.fieldnames
    if not headers or not REQUIRED.issubset(set(x.strip() for x in headers)):
        missing = sorted(REQUIRED - set((x or '').strip() for x in headers or []))
        raise ValueError(f'Invalid published CSV headers; missing: {missing}')
    rows = list(reader)
    if len(rows) < 10 or any(None in row for row in rows):
        raise ValueError('CSV contained unexpectedly few rows or broken column alignment')
    sessions = {
        (row['Session - Date'], row['Session - Start Time'],
         row['Session - End Time'], row['Session - Location'], row['Session - Name'])
        for row in rows if row['Session - Name'] and row['Session - Date']
    }
    if len(sessions) < 10:
        raise ValueError('CSV contained unexpectedly few distinct sessions')
    return rows, sessions


def main():
    request = Request(URL, headers={'User-Agent': 'SCSASM2026-Snapshot-Sync/1.0'})
    with urlopen(request, timeout=30) as result:
        if result.status != 200:
            raise RuntimeError(f'Published CSV returned HTTP {result.status}')
        data = result.read(5_000_001)
    if len(data) > 5_000_000:
        raise ValueError('CSV exceeds the 5 MB safety limit')
    rows, sessions = validate(data)
    # Re-encode to standard UTF-8 only after full validation. The web parser
    # handles BOM, but normalized output avoids changing files due to BOM alone.
    csv_bytes = data.decode('utf-8-sig').encode('utf-8')
    path = ROOT / 'data' / 'agenda-snapshot.csv'
    if path.exists() and path.read_bytes() == csv_bytes:
        print('No changes: published CSV matches the checked-in snapshot.')
        return
    metadata = {
        'source': 'published-google-sheets',
        'sourceUrl': URL,
        'createdAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'rowCount': len(rows),
        'sessionCount': len(sessions),
        'note': 'Automatically synced from the published CSV; Google publication caching may apply.',
    }
    path.write_bytes(csv_bytes)
    (ROOT / 'data' / 'snapshot-metadata.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    print(f'Updated snapshot with {len(rows)} rows, {len(sessions)} sessions.')


if __name__ == '__main__':
    main()
