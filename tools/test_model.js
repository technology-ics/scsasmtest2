// Developer-only data model tests. Node.js is NOT needed to host/deploy the site.
// Run from the repository root: node tools/test_model.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const browserCode = fs.readFileSync(resolve(root, 'script.js'), 'utf8');
const csv = fs.readFileSync(resolve(root, 'data/agenda-snapshot.csv'), 'utf8');
const fakeWindow = {};
vm.runInNewContext(browserCode, { window: fakeWindow, document: { addEventListener() {} } });
const api = fakeWindow.SCSASMAgenda;
const check = (name, operation) => { operation(); console.log(`PASS: ${name}`); };

check('RFC 4180 CSV parsing: BOM, commas, multiline cells, quotes and blanks', () => {
  const input = '\uFEFFName,Details,Blank\r\n"Alice, Jr.","line 1\r\nline 2",\r\n"Has ""quoted"" word",x,z\r\n';
  const rows = api.parseCSV(input);
  assert.deepEqual(Array.from(rows[0]), ['Name','Details','Blank']);
  assert.deepEqual(Array.from(rows[1]), ['Alice, Jr.','line 1\nline 2','']);
  assert.deepEqual(Array.from(rows[2]), ['Has "quoted" word','x','z']);
  assert.throws(() => api.parseCSV('a,b\n"broken,b'), /Unclosed/);
});

const model = api.normalizeCSV(csv);
check('Workbook snapshot: 198 data rows grouped as 29 sessions', () => {
  assert.equal(model.importedRows,198);
  assert.equal(model.sessions.length,29);
  assert.equal(model.skippedRows,0);
});
check('Date counts: Friday 1, Saturday 20, Sunday 8', () => {
  for (const [date,count] of [['2026-04-17',1],['2026-04-18',20],['2026-04-19',8]])
    assert.equal(model.sessions.filter(s=>s.date===date).length,count);
});
check('Source-derived: seven rooms, five numbered tracks plus unassigned', () => {
  assert.equal(new Set(model.sessions.map(s=>s.room)).size,7);
  const tracks = [...new Set(model.sessions.map(s=>s.track))].sort();
  assert.equal(JSON.stringify(tracks),JSON.stringify(['1','2','3','4','5','__track-unassigned__']));
});
check('All session timing from workbook is valid and nonnegative', () => {
  for (const s of model.sessions) {
    assert.ok(s.start !== null, s.name);
    assert.ok(s.end > s.start, s.name);
  }
});
check('Missing presentation times remain unknown, never inherit parent range', () => {
  const friday = model.sessions.find(s=>s.date==='2026-04-17');
  const judges = friday.roleGroups.find(s=>s.title==='Judge');
  assert.ok(judges);
  assert.equal(judges.start,null);
  assert.equal(judges.end,null);
  assert.equal(judges.people.length,3);
});
check('Presentation people merged correctly; duplicate paper items avoided', () => {
  const saturday = model.sessions.find(s=>s.name.startsWith('S04 -'));
  const presentation = saturday.presentations.find(p=>p.title.includes('Review of Evidence That Supports Ticagrelor'));
  assert.equal(presentation.people.length,3);
  assert.equal(saturday.presentations.filter(p=>p.title===presentation.title).length,1);
  const panel = model.sessions.find(s=>s.name.startsWith('S07 -')).roleGroups.find(x=>x.title==='Panelist');
  assert.equal(panel.people.length,3);
});
check('Saturday 10:30 Grand Ballroom same-room overlap receives two columns', () => {
  const sessions = model.sessions.filter(s=>s.date==='2026-04-18'&&s.room==='Grand Ballroom'&&s.start===630);
  assert.equal(sessions.length,2);
  const positions = api.overlapColumns(sessions);
  assert.equal(positions.get(sessions[0].id).total,2);
  assert.equal(positions.get(sessions[1].id).total,2);
  assert.notEqual(positions.get(sessions[0].id).column,positions.get(sessions[1].id).column);
});
check('Wall-clock date and time parsing remains independent of browser timezone', () => {
  assert.equal(api.parseDate('17/04/2026'),'2026-04-17');
  assert.equal(api.parseDate('4/18/2026'),'2026-04-18');
  assert.equal(api.parseTime('7:30 PM'),1170);
  assert.equal(api.parseTime('12:30 AM'),30);
  assert.equal(api.parseTime('12:30 PM'),750);
  assert.equal(api.parseTime('10:30:30'),630.5);
});
check('GitHub Pages resource paths are relative', () => {
  const html = fs.readFileSync(resolve(root,'index.html'),'utf8');
  assert.ok(html.includes('href="./style.css"'));
  assert.ok(html.includes('src="./script.js" defer'));
});
console.log(`MODEL SUMMARY: ${model.sessions.length} sessions, ${model.presentationCount} presentation/program item groups, ${model.roleGroupCount} role/team groups, ${model.warnings.length} normalization warnings`);
