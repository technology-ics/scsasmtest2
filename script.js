/* SCSASM 2026 Interactive Agenda — plain browser JavaScript, no dependencies.
   The published Google Sheets CSV is attempted at every page load. When it is
   inaccessible or invalid, we load a dated, checked-in workbook CSV snapshot.
   Data is parsed and normalized once, then filtered in memory. */
(() => {
  'use strict';

  const SOURCE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR7XZFOcEKOxCsw8Yb1LJpdSj_VUhncQMaGqTIOW19PRN1jr9Df4b_-_hmJ7dOHvUUXe4dCezqVn2Hd/pub?gid=0&single=true&output=csv';
  const SNAPSHOT_URL = './data/agenda-snapshot.csv';
  const SNAPSHOT_METADATA_URL = './data/snapshot-metadata.json';
  const FETCH_TIMEOUT_MS = 8500;
  const PIXELS_PER_MINUTE = 2.30; // Identical scale for every room of a given day.
  const UNSPECIFIED_ROOM = '__room-unspecified__';
  const UNASSIGNED_TRACK = '__track-unassigned__';
  const DATES = Object.freeze([
    { key: '2026-04-17', label: 'Friday, April 17, 2026' },
    { key: '2026-04-18', label: 'Saturday, April 18, 2026' },
    { key: '2026-04-19', label: 'Sunday, April 19, 2026' },
  ]);
  const ALL_HEADERS = [
    'Title', 'First Name', 'Last Name', 'Position', 'Organization', 'Biography',
    'Session - Name', 'Session - Details', 'Session - Date', 'Session - Start Time',
    'Session - End Time', 'Session - Location', 'Session - Type', 'Session - Track',
    'Paper Title', 'Presentation Status', 'Presentation Type',
    'Presentation Start Time', 'Presentation End Time',
  ];
  const REQUIRED_HEADERS = [
    'Session - Name', 'Session - Date', 'Session - Start Time',
    'Session - End Time', 'Session - Location', 'Paper Title',
    'Presentation Start Time', 'Presentation End Time',
  ];
  const ROLE_ITEM_PATTERN = /^(?:judge|panelist|moderator|chair|chairperson|session chair|co-chair|co-chairperson|discussant|team\s+.+)$/i;

  const state = {
    date: DATES[0].key,
    tracks: new Set(),
    rooms: new Set(),
    query: '',
    sessions: [],
    warnings: [],
    activeSessionId: null,
    returnFocus: null,
    allDatesCount: 0,
  };
  const dom = {};

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };
  const text = value => value === null || value === undefined ? '' : String(value).trim();
  const identity = value => text(value).replace(/\s+/g, ' ').toLocaleLowerCase();
  const dayName = value => DATES.find(item => item.key === value)?.label || value;
  const niceRoom = value => value === UNSPECIFIED_ROOM ? 'Room not specified' : value;
  const niceTrack = value => value === UNASSIGNED_TRACK ? 'Unassigned' : `Track ${value}`;
  const plural = (count, singular) => `${count} ${singular}${count === 1 ? '' : 's'}`;

  /** RFC 4180-style parser: quoted commas, newlines, doubled quotes, BOM, CRLF. */
  function parseCSV(raw) {
    if (typeof raw !== 'string' || !raw.length) throw new Error('The CSV is empty.');
    const source = raw.replace(/^\uFEFF/, '');
    const records = [];
    let cells = [], field = '', quoted = false, afterQuote = false;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') {
          field += '"'; i++;
        } else if (char === '"') {
          quoted = false; afterQuote = true;
        } else if (char === '\r' && source[i + 1] === '\n') {
          field += '\n'; i++;
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"' && field === '' && !afterQuote) {
        quoted = true; continue;
      }
      if (char === ',') {
        cells.push(field); field = ''; afterQuote = false; continue;
      }
      if (char === '\n' || char === '\r') {
        cells.push(field); records.push(cells); cells = []; field = ''; afterQuote = false;
        if (char === '\r' && source[i + 1] === '\n') i++;
        continue;
      }
      if (afterQuote && (char === ' ' || char === '\t')) continue;
      if (char === '"' || afterQuote) throw new Error(`Malformed CSV quoting near character ${i}.`);
      field += char;
    }
    if (quoted) throw new Error('Unclosed quoted field in CSV.');
    if (cells.length || field.length || afterQuote) {
      cells.push(field); records.push(cells);
    }
    return records;
  }

  function headerKey(value) {
    return text(value).replace(/\s*[-–]\s*/g, ' - ').replace(/\s+/g, ' ').toLocaleLowerCase();
  }
  function parseDate(value) {
    const input = text(value);
    if (!input) return null;
    let year, month, day, match;
    if ((match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s|T|$)/))) {
      [, year, month, day] = match;
    } else if ((match = input.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s|$)/))) {
      const first = Number(match[1]), second = Number(match[2]);
      year = match[3].length === 2 ? Number(match[3]) + 2000 : Number(match[3]);
      if (first > 12 && second <= 12) { day = first; month = second; }
      else if (second > 12 && first <= 12) { month = first; day = second; }
      else return null; // Ambiguous numeric date: don't guess DD/MM vs MM/DD.
    } else if ((match = input.match(/^(?:Apr|April)\s+(\d{1,2}),?\s+(20\d{2})/i))) {
      day = Number(match[1]); year = Number(match[2]); month = 4;
    } else if ((match = input.match(/^(\d{1,2})\s+Apr(?:il)?\s+(20\d{2})/i))) {
      day = Number(match[1]); year = Number(match[2]); month = 4;
    } else return null;
    [year, month, day] = [year, month, day].map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  /** Return conference-local wall-clock minutes; never convert browser timezones. */
  function parseTime(value) {
    const input = text(value);
    if (!input) return null;
    if (/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(input) && input.includes('.')) {
      const number = Number(input);
      return number >= 0 && number < 1 ? number * 1440 : null;
    }
    const match = input.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const seconds = Number(match[3] || 0);
    const meridian = match[4]?.toUpperCase();
    if (minute > 59 || seconds > 59 || hour > 23 || hour < 0) return null;
    if (meridian) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridian === 'PM' ? 12 : 0);
    }
    return hour * 60 + minute + seconds / 60;
  }
  function formatTime(minutes) {
    if (minutes === null || !Number.isFinite(minutes)) return '';
    const total = Math.round(minutes * 60) / 60;
    const clockMinutes = Math.floor(total + 0.0001) % 1440;
    const hours = Math.floor(clockMinutes / 60);
    const mins = clockMinutes % 60;
    const time = `${hours % 12 || 12}:${String(mins).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
    return minutes >= 1440 ? `${time} (next day)` : time;
  }
  function formatRange(start, end) {
    if (start === null || end === null) return 'Time not specified';
    return `${formatTime(start)} – ${formatTime(end)}`;
  }
  function cleanDescription(value) {
    return text(value).replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/?(?:p|div|li|ul|ol)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  function makePerson(get) {
    const title = get('Title'), first = get('First Name'), last = get('Last Name');
    return {
      title, first, last,
      name: [title, first, last].filter(Boolean).join(' '),
      position: get('Position'), organization: get('Organization'),
      biography: get('Biography'),
      sourceType: get('Presentation Type'), status: get('Presentation Status'),
    };
  }
  function normalizeCSV(csvText) {
    const records = parseCSV(csvText);
    if (records.length < 2) throw new Error('The CSV does not contain both headers and schedule rows.');
    const positions = new Map();
    records[0].forEach((value, index) => {
      const key = headerKey(value);
      if (!key || positions.has(key)) throw new Error(`CSV has a missing or duplicate header: "${value}".`);
      positions.set(key, index);
    });
    const missing = REQUIRED_HEADERS.filter(key => !positions.has(headerKey(key)));
    if (missing.length) throw new Error(`Missing critical CSV columns: ${missing.join(', ')}`);
    const absentOptional = ALL_HEADERS.filter(key => !positions.has(headerKey(key)) && !missing.includes(key));
    const warnings = [];
    if (absentOptional.length) warnings.push(`Optional headers missing: ${absentOptional.join(', ')}.`);
    const sessionMap = new Map();
    let importedRows = 0, skippedRows = 0;
    for (let index = 1; index < records.length; index++) {
      let fields = records[index];
      if (fields.every(value => !text(value))) continue;
      if (fields.length > records[0].length) {
        skippedRows++; warnings.push(`CSV row ${index + 1} has extra fields and was skipped.`); continue;
      }
      if (fields.length < records[0].length) fields = [...fields, ...Array(records[0].length - fields.length).fill('')];
      const get = header => text(fields[positions.get(headerKey(header))] || '');
      const date = parseDate(get('Session - Date'));
      const name = get('Session - Name');
      if (!date || !name) {
        skippedRows++; warnings.push(`CSV row ${index + 1} lacks a valid date or session name and could not be grouped.`); continue;
      }
      importedRows++;
      const startText = get('Session - Start Time'), endText = get('Session - End Time');
      const start = parseTime(startText), clockEnd = parseTime(endText);
      const room = get('Session - Location') || UNSPECIFIED_ROOM;
      const sessionKey = JSON.stringify([date, startText, endText, room, identity(name)]);
      let session = sessionMap.get(sessionKey);
      if (!session) {
        let end = clockEnd;
        let timeIssue = '';
        if (start === null || end === null) {
          timeIssue = `Missing or invalid session time: ${startText || '—'} to ${endText || '—'}.`;
        } else if (end <= start) {
          // Only interpret an unmistakable overnight interval as crossing midnight.
          if (start >= 18 * 60 && end <= 6 * 60) end += 1440;
          else timeIssue = `Session has a nonpositive or ambiguous time range: ${startText} to ${endText}.`;
        }
        if (timeIssue) warnings.push(`${name}: ${timeIssue}`);
        session = {
          id: sessionKey, date, name, details: cleanDescription(get('Session - Details')),
          start: timeIssue ? null : start, end: timeIssue ? null : end,
          rawStart: startText, rawEnd: endText, timeIssue,
          room, type: get('Session - Type'), track: get('Session - Track') || UNASSIGNED_TRACK,
          presentations: [], roleGroups: [], presentationMap: new Map(), roleMap: new Map(),
          searchText: '', sourceRows: 0,
        };
        sessionMap.set(sessionKey, session);
      } else {
        // Some row-level session fields are blank. Fill only with source values.
        if (!session.details) session.details = cleanDescription(get('Session - Details'));
        if (!session.type) session.type = get('Session - Type');
        if (session.track === UNASSIGNED_TRACK && get('Session - Track')) session.track = get('Session - Track');
        if (get('Session - Track') && session.track !== get('Session - Track')) {
          warnings.push(`Conflicting tracks in session ${name}; retained the first value.`);
        }
      }
      session.sourceRows++;
      const paperTitle = get('Paper Title');
      const status = get('Presentation Status');
      const itemType = get('Presentation Type');
      const presentationStartText = get('Presentation Start Time');
      const presentationEndText = get('Presentation End Time');
      const itemStart = parseTime(presentationStartText);
      let itemEnd = parseTime(presentationEndText);
      let itemTimeIssue = '';
      if ((presentationStartText && itemStart === null) || (presentationEndText && itemEnd === null)) {
        itemTimeIssue = 'Invalid presentation time.';
      }
      if ((itemStart === null) !== (itemEnd === null)) itemTimeIssue = 'Incomplete presentation time.';
      if (itemStart !== null && itemEnd !== null && itemEnd <= itemStart) {
        if (itemStart >= 18 * 60 && itemEnd <= 6 * 60) itemEnd += 1440;
        else itemTimeIssue = 'Nonpositive presentation time range.';
      }
      if (itemTimeIssue) warnings.push(`${name}: ${paperTitle || '(unnamed)'} — ${itemTimeIssue}`);
      const groupIsRole = !paperTitle || ROLE_ITEM_PATTERN.test(paperTitle);
      const roleLabel = paperTitle || 'Unspecified session role';
      const groupKey = JSON.stringify([identity(paperTitle), presentationStartText, presentationEndText, identity(status)]);
      const targetMap = groupIsRole ? session.roleMap : session.presentationMap;
      let group = targetMap.get(groupKey);
      if (!group) {
        group = {
          id: groupKey, title: groupIsRole ? roleLabel : paperTitle, status,
          types: new Set(), people: [], peopleKeys: new Set(),
          start: itemTimeIssue ? null : itemStart, end: itemTimeIssue ? null : itemEnd,
          timeIssue: itemTimeIssue, firstRow: index,
        };
        targetMap.set(groupKey, group);
        if (groupIsRole) session.roleGroups.push(group);
        else session.presentations.push(group);
      }
      if (itemType) group.types.add(itemType);
      const person = makePerson(get);
      if (person.name) {
        // De-duplicate only within the *same* item. Repeat appearances in other
        // items or sessions are retained, even when names match.
        const personKey = JSON.stringify([identity(person.name), identity(person.organization), identity(person.sourceType)]);
        if (!group.peopleKeys.has(personKey)) {
          group.peopleKeys.add(personKey);
          group.people.push(person);
        }
      }
    }
    if (!sessionMap.size) throw new Error('No valid session records were found in the CSV.');
    const sessions = Array.from(sessionMap.values());
    for (const session of sessions) {
      const itemSorter = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.firstRow - b.firstRow;
      session.presentations.sort(itemSorter);
      session.roleGroups.sort(itemSorter);
      session.searchText = [
        session.name, session.details, session.room, session.type,
        niceTrack(session.track),
        ...session.presentations.flatMap(item => [item.title, item.status, ...item.types, ...item.people.flatMap(person => [person.name, person.position, person.organization, person.biography])]),
        ...session.roleGroups.flatMap(item => [item.title, item.status, ...item.types, ...item.people.flatMap(person => [person.name, person.position, person.organization, person.biography])]),
      ].filter(Boolean).join(' ').normalize('NFKD').toLocaleLowerCase();
      delete session.presentationMap;
      delete session.roleMap;
      for (const item of [...session.presentations, ...session.roleGroups]) delete item.peopleKeys;
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? Infinity) - (b.start ?? Infinity) || a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    if (skippedRows) warnings.unshift(`${skippedRows} malformed source row(s) were skipped.`);
    return {
      sessions, warnings, importedRows, skippedRows,
      presentationCount: sessions.reduce((sum, item) => sum + item.presentations.length, 0),
      roleGroupCount: sessions.reduce((sum, item) => sum + item.roleGroups.length, 0),
    };
  }

  async function getText(url, timeoutMs = 0) {
    const controller = new AbortController();
    const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} when loading ${url.startsWith('http') ? 'the published CSV' : 'the snapshot'}.`);
      const body = await response.text();
      if (/^\s*<!doctype html|^\s*<html/i.test(body)) throw new Error('The data URL returned HTML instead of CSV.');
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The published CSV request timed out.');
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function setSourceStatus(mode, label, notice) {
    dom.sourceBadge.classList.remove('live', 'fallback');
    if (mode) dom.sourceBadge.classList.add(mode);
    dom.sourceBadgeText.textContent = label;
    dom.sourceNotice.hidden = !notice;
    dom.sourceNotice.textContent = notice || '';
  }
  function showLoading(loading) {
    dom.loadingState.hidden = !loading;
    if (loading) {
      dom.timelineWrapper.hidden = true;
      dom.emptyFeedback.hidden = true;
      dom.unscheduledSection.hidden = true;
    }
  }
  async function loadProgram() {
    showLoading(true);
    dom.fatalError.hidden = true;
    let model, reason = '';
    try {
      model = normalizeCSV(await getText(SOURCE_URL, FETCH_TIMEOUT_MS));
      setSourceStatus('live', 'Published Google Sheets CSV',
        `The published Google Sheets CSV was retrieved during this page load (${new Date().toLocaleString()}). Google may cache published data; this does not guarantee immediate spreadsheet updates.`);
    } catch (liveError) {
      reason = liveError?.message || 'Unknown network or CSV validation error';
      try {
        const csv = await getText(SNAPSHOT_URL);
        model = normalizeCSV(csv);
        let metadata = null;
        try {
          const result = await fetch(SNAPSHOT_METADATA_URL, { cache: 'no-store' });
          if (result.ok) metadata = await result.json();
        } catch { /* Metadata only affects the timestamp; the CSV is authoritative. */ }
        const timestamp = metadata?.createdAtUtc ? new Date(metadata.createdAtUtc).toLocaleString() : 'date unavailable';
        const kind = metadata?.source === 'published-google-sheets' ? 'Last synced published CSV' : 'Supplied-workbook snapshot';
        setSourceStatus('fallback', 'Local snapshot · not live',
          `${kind} (snapshot created ${timestamp}). The live Google Sheets CSV could not be loaded (${reason}). These records are a dated fallback, not verified current data.`);
      } catch (snapshotError) {
        state.sessions = [];
        showLoading(false);
        setSourceStatus('', 'Schedule unavailable', 'Neither the published CSV nor the local fallback could be loaded.');
        dom.fatalErrorText.textContent = `Live source: ${reason}. Local snapshot: ${snapshotError?.message || 'unknown error'}. Check the published CSV link and the ./data/agenda-snapshot.csv file.`;
        dom.fatalError.hidden = false;
        dom.resultsSummary.textContent = 'Program unavailable';
        return;
      }
    }
    state.sessions = model.sessions;
    state.warnings = model.warnings;
    state.allDatesCount = model.sessions.length;
    if (state.warnings.length) {
      const diagnostics = `${state.warnings.length} source-data notice(s), including: ${state.warnings.slice(0, 3).join(' | ')}`;
      const existing = dom.sourceNotice.textContent;
      dom.sourceNotice.textContent = `${existing} ${diagnostics}`;
      dom.sourceNotice.hidden = false;
    }
    buildFilters();
    showLoading(false);
    updateView();
  }

  function buildFilters() {
    const tracks = [...new Set(state.sessions.map(session => session.track))];
    tracks.sort((a, b) => a === UNASSIGNED_TRACK ? 1 : b === UNASSIGNED_TRACK ? -1 : a.localeCompare(b, undefined, { numeric: true }));
    const rooms = [...new Set(state.sessions.map(session => session.room))];
    rooms.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    fillChoices(dom.trackChoices, tracks, state.tracks, niceTrack);
    fillChoices(dom.roomChoices, rooms, state.rooms, niceRoom);
    updateFilterCounters();
  }
  function fillChoices(container, values, selections, display) {
    container.replaceChildren();
    const fragment = document.createDocumentFragment();
    values.forEach(value => {
      const label = node('label', 'filter-choice');
      const input = node('input');
      input.type = 'checkbox';
      input.value = value;
      input.checked = selections.has(value);
      input.setAttribute('aria-label', display(value));
      const labelText = node('span', 'filter-choice-name', display(value));
      label.append(input, labelText);
      input.addEventListener('change', () => {
        if (input.checked) selections.add(value);
        else selections.delete(value);
        updateFilterCounters();
        updateView();
      });
      fragment.append(label);
    });
    container.append(fragment);
  }
  function updateFilterCounters() {
    for (const [type, button, counter] of [
      [state.tracks, dom.trackToggle, dom.trackCount],
      [state.rooms, dom.roomToggle, dom.roomCount],
    ]) {
      counter.textContent = String(type.size);
      counter.hidden = type.size === 0;
      button.classList.toggle('has-selections', type.size > 0);
    }
    dom.clearSearch.hidden = !state.query;
  }
  function closeMenus(except = null) {
    for (const [menu, button] of [[dom.trackOptions, dom.trackToggle], [dom.roomOptions, dom.roomToggle]]) {
      if (menu !== except) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); }
    }
  }
  function toggleMenu(menu, button) {
    const shouldOpen = menu.hidden;
    closeMenus(menu);
    menu.hidden = !shouldOpen;
    button.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) menu.querySelector('input')?.focus();
  }
  function clearFilters() {
    state.tracks.clear(); state.rooms.clear(); state.query = '';
    dom.programSearch.value = '';
    for (const option of document.querySelectorAll('.filter-choices input')) option.checked = false;
    closeMenus(); updateFilterCounters(); updateView();
  }
  function selectedSessions() {
    const query = state.query.normalize('NFKD').toLocaleLowerCase();
    return state.sessions.filter(session =>
      session.date === state.date &&
      (!state.tracks.size || state.tracks.has(session.track)) &&
      (!state.rooms.size || state.rooms.has(session.room)) &&
      (!query || session.searchText.includes(query))
    );
  }

  /** Partition each connected overlap group; simultaneous events occupy side-by-side slots. */
  function overlapColumns(sessions) {
    const sorted = [...sessions].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
    const groups = [];
    let current = null;
    for (const session of sorted) {
      if (!current || session.start >= current.maxEnd) {
        current = { items: [], maxEnd: session.end };
        groups.push(current);
      }
      current.items.push(session);
      current.maxEnd = Math.max(current.maxEnd, session.end);
    }
    const placements = new Map();
    for (const group of groups) {
      const columns = [];
      const slots = [];
      for (const session of group.items) {
        let column = columns.findIndex(end => end <= session.start);
        if (column < 0) { column = columns.length; columns.push(session.end); }
        else columns[column] = session.end;
        slots.push([session, column]);
      }
      for (const [session, column] of slots) placements.set(session.id, { column, total: columns.length });
    }
    return placements;
  }
  function timelineBounds(daySessions) {
    const valid = daySessions.filter(session => session.start !== null && session.end !== null);
    if (!valid.length) return { start: 8 * 60, end: 10 * 60 };
    const min = Math.min(...valid.map(session => session.start));
    const max = Math.max(...valid.map(session => session.end));
    return { start: Math.floor(min / 15) * 15, end: Math.ceil(max / 15) * 15 };
  }
  function makeCard(session, placement, bounds) {
    const button = node('button', 'session-card');
    button.type = 'button';
    button.dataset.track = session.track;
    button.dataset.sessionId = session.id;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'detailPanel');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `${session.name}. ${formatRange(session.start, session.end)}. ${niceRoom(session.room)}. ${niceTrack(session.track)}. Open details.`);
    button.title = `${session.name} • ${formatRange(session.start, session.end)}`;
    const height = Math.max(1, (session.end - session.start) * PIXELS_PER_MINUTE - 2);
    button.style.top = `${(session.start - bounds.start) * PIXELS_PER_MINUTE + 1}px`;
    button.style.height = `${height}px`;
    const slotSize = 100 / placement.total;
    button.style.left = `calc(${placement.column * slotSize}% + 3px)`;
    button.style.width = `calc(${slotSize}% - 6px)`;
    if (height < 55) button.classList.add('is-compact');
    else if (height < 105) button.classList.add('is-short');
    button.append(node('span', 'card-time', formatRange(session.start, session.end)), node('span', 'card-title', session.name));
    const footer = node('span', 'card-footer');
    footer.append(node('b', '', niceTrack(session.track)), node('span', 'card-bullet', '•'), node('span', '', niceRoom(session.room)));
    button.append(footer);
    button.addEventListener('click', () => openDetails(session, button));
    return button;
  }
  function renderTimeline(matches) {
    const allDay = state.sessions.filter(session => session.date === state.date);
    const bounds = timelineBounds(allDay);
    const dayRooms = [...new Set(allDay.map(session => session.room))];
    // A selected room stays visible even if it has no sessions on this date.
    const rooms = state.rooms.size ? [...state.rooms] : dayRooms;
    rooms.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!rooms.length) rooms.push(UNSPECIFIED_ROOM);
    const totalHeight = (bounds.end - bounds.start) * PIXELS_PER_MINUTE;
    dom.timelineGrid.replaceChildren();
    dom.timelineGrid.style.setProperty('--columns', String(rooms.length));
    dom.timelineGrid.classList.toggle('expand-rooms', rooms.length <= 3);
    dom.timelineGrid.style.setProperty('--timeline-height', `${totalHeight}px`);
    const corner = node('div', 'timeline-corner', 'Time');
    dom.timelineGrid.append(corner);
    const axis = node('div', 'time-axis');
    axis.setAttribute('aria-hidden', 'true');
    const ticks = [];
    const startTick = Math.ceil(bounds.start / 30) * 30;
    for (let minute = startTick; minute <= bounds.end; minute += 30) ticks.push(minute);
    if (!ticks.includes(bounds.start)) ticks.unshift(bounds.start);
    if (!ticks.includes(bounds.end)) ticks.push(bounds.end);
    ticks.sort((a, b) => a - b);
    for (const minute of ticks) {
      if (minute === bounds.start || minute === bounds.end || minute % 60 === 0 || totalHeight < 380) {
        const tick = node('div', `time-tick ${minute % 60 ? 'minor' : ''} ${minute === bounds.start ? 'first' : ''} ${minute === bounds.end ? 'last' : ''}`, formatTime(minute));
        tick.style.top = `${(minute - bounds.start) * PIXELS_PER_MINUTE}px`;
        axis.append(tick);
      }
    }
    dom.timelineGrid.append(axis);
    for (let roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
      const room = rooms[roomIndex];
      const header = node('div', 'room-heading');
      header.style.gridColumn = String(roomIndex + 2);
      header.style.gridRow = '1';
      header.append(node('span', 'room-index', `ROOM ${String(roomIndex + 1).padStart(2, '0')}`), node('span', 'room-name', niceRoom(room)));
      dom.timelineGrid.append(header);
      const lane = node('div', `room-lane ${roomIndex % 2 ? 'alternate' : ''}`);
      lane.style.gridColumn = String(roomIndex + 2);
      for (let tickMinute = startTick; tickMinute <= bounds.end; tickMinute += 30) {
        const line = node('div', `lane-line ${tickMinute % 60 === 0 ? 'major' : ''}`);
        line.style.top = `${(tickMinute - bounds.start) * PIXELS_PER_MINUTE}px`;
        lane.append(line);
      }
      const laneSessions = matches.filter(session => session.room === room && session.start !== null && session.end !== null);
      const placements = overlapColumns(laneSessions);
      if (!laneSessions.length) lane.append(node('div', 'lane-empty', 'No matching sessions'));
      else for (const session of laneSessions) lane.append(makeCard(session, placements.get(session.id), bounds));
      dom.timelineGrid.append(lane);
    }
    dom.timelineWrapper.hidden = false;
  }
  function updateView() {
    DATES.forEach(day => {
      const tab = document.getElementById(`tab-${day.key}`);
      const active = day.key === state.date;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    const matches = selectedSessions();
    const validCount = matches.filter(s => s.start !== null && s.end !== null).length;
    dom.resultsSummary.textContent = `${plural(matches.length, 'session')} on ${dayName(state.date)}${state.tracks.size || state.rooms.size || state.query ? ' · filtered' : ''}`;
    dom.emptyFeedback.hidden = matches.length > 0;
    if (state.sessions.length) {
      renderTimeline(matches);
      renderUnscheduled(matches);
      if (matches.length && !validCount) dom.emptyFeedback.hidden = true;
    }
  }
  function renderUnscheduled(matches) {
    const unscheduled = matches.filter(item => item.start === null || item.end === null);
    dom.unscheduledSection.hidden = !unscheduled.length;
    dom.unscheduledCards.replaceChildren();
    for (const session of unscheduled) {
      const button = node('button', '', `${session.name} · ${niceRoom(session.room)}`);
      button.type = 'button';
      button.addEventListener('click', () => openDetails(session, button));
      dom.unscheduledCards.append(button);
    }
  }

  function appendChip(target, label, className = '') {
    if (label) target.append(node('span', `detail-chip ${className}`, label));
  }
  function renderPerson(person, role, showSourceType = false) {
    const wrapper = node('div', 'person');
    const heading = node('div', 'person-name', person.name);
    if (role) heading.append(node('span', 'person-role', role));
    if (showSourceType && person.sourceType && person.sourceType !== role) {
      heading.append(node('span', 'person-role', `· ${person.sourceType}`));
    }
    wrapper.append(heading);
    if (person.position) wrapper.append(node('p', 'person-position', person.position));
    if (person.organization) wrapper.append(node('p', 'person-organization', person.organization));
    if (person.biography) {
      const details = node('details', 'person-bio');
      details.append(node('summary', '', 'Biography'), node('p', '', person.biography));
      wrapper.append(details);
    }
    return wrapper;
  }
  function renderPresentations(session, target) {
    const section = node('section', 'detail-section');
    section.append(node('h3', '', `Presentations & program items (${session.presentations.length})`));
    if (!session.presentations.length) section.append(node('p', 'detail-empty', 'No individual presentation titles are listed for this session.'));
    for (const item of session.presentations) {
      const row = node('article', 'program-item');
      row.append(node('div', `program-item-time ${item.start === null || item.end === null ? 'unknown' : ''}`, formatRange(item.start, item.end)));
      const main = node('div');
      main.append(node('h4', 'program-item-title', item.title));
      const badges = node('div', 'program-item-badges');
      if (item.status) badges.append(node('span', 'program-item-badge', item.status));
      for (const type of item.types) badges.append(node('span', 'program-item-badge', type));
      if (badges.childNodes.length) main.append(badges);
      if (item.people.length) {
        const people = node('div', 'people-list');
        for (const person of item.people) people.append(renderPerson(person, person.sourceType));
        main.append(people);
      }
      row.append(main);
      section.append(row);
    }
    target.append(section);
  }
  function renderRoles(session, target) {
    if (!session.roleGroups.length) return;
    const section = node('section', 'detail-section');
    section.append(node('h3', '', `Session roles & teams (${session.roleGroups.length})`));
    for (const item of session.roleGroups) {
      const group = node('article', 'role-group');
      group.append(node('h4', 'role-group-title', item.title));
      if (item.start !== null && item.end !== null) group.append(node('p', 'role-group-time', formatRange(item.start, item.end)));
      const people = node('div', 'people-list');
      for (const person of item.people) people.append(renderPerson(person, item.title, true));
      group.append(people);
      section.append(group);
    }
    target.append(section);
  }
  function renderDetailContents(session) {
    dom.detailContents.replaceChildren();
    dom.detailContents.append(node('p', 'detail-kicker', `${dayName(session.date)} · SCSASM 2026`));
    const title = node('h2', '', session.name);
    title.id = 'detailTitle';
    dom.detailContents.append(title);
    const context = node('div', 'detail-context');
    context.id = 'detailContext';
    appendChip(context, session.start !== null ? formatRange(session.start, session.end) : 'Time not specified', 'highlight');
    appendChip(context, session.room !== UNSPECIFIED_ROOM ? session.room : 'Room not specified');
    if (session.track !== UNASSIGNED_TRACK) appendChip(context, niceTrack(session.track));
    if (session.type) appendChip(context, session.type);
    dom.detailContents.append(context);
    if (session.timeIssue) dom.detailContents.append(node('p', 'detail-type', session.timeIssue));
    if (session.details) {
      const description = node('section', 'detail-section');
      description.append(node('h3', '', 'Session overview'), node('p', 'detail-description', session.details));
      dom.detailContents.append(description);
    }
    renderPresentations(session, dom.detailContents);
    renderRoles(session, dom.detailContents);
  }
  function openDetails(session, triggeringElement) {
    state.returnFocus = triggeringElement;
    state.activeSessionId = session.id;
    renderDetailContents(session);
    dom.detailLayer.hidden = false;
    document.body.classList.add('dialog-open');
    dom.detailContents.scrollTop = 0;
    if (triggeringElement.classList.contains('session-card')) triggeringElement.setAttribute('aria-pressed', 'true');
    dom.detailClose.focus();
  }
  function closeDetails() {
    if (dom.detailLayer.hidden) return;
    dom.detailLayer.hidden = true;
    document.body.classList.remove('dialog-open');
    document.querySelectorAll('.session-card[aria-pressed="true"]').forEach(card => card.setAttribute('aria-pressed', 'false'));
    state.activeSessionId = null;
    if (state.returnFocus?.isConnected) state.returnFocus.focus({ preventScroll: true });
    state.returnFocus = null;
  }
  function trapDialogFocus(event) {
    if (dom.detailLayer.hidden || event.key !== 'Tab') return;
    const focusables = [...dom.detailPanel.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length);
    if (!focusables.length) { event.preventDefault(); dom.detailPanel.focus(); return; }
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dom.detailPanel)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function init() {
    for (const id of [
      'sourceBadge','sourceBadgeText','sourceNotice','fatalError','fatalErrorText','retryButton',
      'programSearch','clearSearch','trackToggle','trackOptions','trackChoices','trackCount',
      'roomToggle','roomOptions','roomChoices','roomCount','clearFilters',
      'resultsSummary','loadingState','timelineWrapper','timelineScroll','timelineGrid',
      'emptyFeedback','emptyClear','unscheduledSection','unscheduledCards',
      'detailLayer','detailBackdrop','detailPanel','detailClose','detailContents',
    ]) dom[id] = document.getElementById(id);
    document.querySelectorAll('.date-tab').forEach((tab, index, tabs) => {
      tab.addEventListener('click', () => {
        if (state.date === tab.dataset.date) return;
        state.date = tab.dataset.date;
        dom.timelineScroll.scrollTop = 0;
        dom.timelineScroll.scrollLeft = 0;
        updateView();
      });
      tab.addEventListener('keydown', event => {
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : direction ? (index + direction + tabs.length) % tabs.length : -1;
        if (next >= 0) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
      });
    });
    dom.programSearch.addEventListener('input', () => {
      state.query = dom.programSearch.value.trim();
      updateFilterCounters();
      updateView();
    });
    dom.clearSearch.addEventListener('click', () => {
      state.query = ''; dom.programSearch.value = '';
      updateFilterCounters(); updateView(); dom.programSearch.focus();
    });
    dom.trackToggle.addEventListener('click', () => toggleMenu(dom.trackOptions, dom.trackToggle));
    dom.roomToggle.addEventListener('click', () => toggleMenu(dom.roomOptions, dom.roomToggle));
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('.filter-dropdown')) closeMenus();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (!dom.detailLayer.hidden) { event.preventDefault(); closeDetails(); }
        else {
          const menuOpen = !dom.trackOptions.hidden || !dom.roomOptions.hidden;
          closeMenus();
          if (menuOpen) {
            event.preventDefault();
            (document.activeElement.closest('#trackDropdown') ? dom.trackToggle : dom.roomToggle).focus();
          }
        }
      }
      trapDialogFocus(event);
    });
    dom.clearFilters.addEventListener('click', clearFilters);
    dom.emptyClear.addEventListener('click', clearFilters);
    dom.detailClose.addEventListener('click', closeDetails);
    dom.detailBackdrop.addEventListener('click', closeDetails);
    dom.retryButton.addEventListener('click', loadProgram);
    loadProgram();
  }

  // Small diagnostics API so the source normalization can be tested in a browser
  // without a build system; no state mutation or network actions are exposed.
  window.SCSASMAgenda = Object.freeze({ parseCSV, normalizeCSV, overlapColumns, parseTime, parseDate });
  document.addEventListener('DOMContentLoaded', init);
})();
