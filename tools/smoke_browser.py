"""Exercise the actual UI in Chromium with controlled responses for fetch.

The container does not permit Chromium networking, so HTML, CSS and JS are
inlined only in this test harness. This verifies rendering, accessibility
interaction logic and fallback behavior, NOT GitHub Pages networking/CORS.
Usage: python tools/smoke_browser.py
Requires `pip install playwright` plus a Chromium executable.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import os
import shutil

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'index.html').read_text('utf-8')
CSS = (ROOT / 'style.css').read_text('utf-8')
JS = (ROOT / 'script.js').read_text('utf-8')
CSV = (ROOT / 'data/agenda-snapshot.csv').read_text('utf-8')
META = (ROOT / 'data/snapshot-metadata.json').read_text('utf-8')
OUTPUT = Path(os.environ.get('SCSASM_SCREENSHOT_DIR', str(ROOT / 'previews')))
OUTPUT.mkdir(parents=True, exist_ok=True)
CHROMIUM_EXECUTABLE = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome')

def build_html(live=False, fail_both=False):
    payload = f'''<script>
      const testCsv = {json.dumps(CSV).replace('</', '<\\/')};
      const testMeta = {json.dumps(META)};
      window.fetch = async function(url) {{
        const key = String(url);
        if (key.startsWith('https://docs.google.com')) {{
          {'return new Response(testCsv, {status:200});' if live else 'throw new TypeError("Simulated CORS/network failure");'}
        }}
        if (key.endsWith('.csv')) {{ {'throw new TypeError("Simulated unavailable local snapshot");' if fail_both else 'return new Response(testCsv, {status:200});'} }}
        if (key.endsWith('.json')) return new Response(testMeta, {{status:200}});
        throw new TypeError('Unexpected URL: ' + key);
      }};
    </script>'''
    return HTML.replace('<link rel="stylesheet" href="./style.css">', '<style>' + CSS + '</style>')\
               .replace('<script src="./script.js" defer></script>', payload + '<script>' + JS + '</script>')

with sync_playwright() as playwright:
    browser=playwright.chromium.launch(headless=True, executable_path=CHROMIUM_EXECUTABLE,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content(build_html(),wait_until='load')
    page.wait_for_function("document.querySelector('#sourceBadge').classList.contains('fallback') || !document.querySelector('#fatalError').hidden",timeout=30000)
    print('FALLBACK_BADGE',page.locator('#sourceBadgeText').inner_text())
    print('FATAL',page.locator('#fatalError').is_visible())
    assert not page.locator('#fatalError').is_visible()
    print('FRIDAY',page.locator('#resultsSummary').inner_text(),'CARDS',page.locator('.session-card').count())
    print('SUNDAY OPTIONS',page.locator('#trackChoices input').count(),'ROOM OPTIONS',page.locator('#roomChoices input').count())
    print('JS ERRORS',errors)
    assert page.locator('.session-card').count() == 1
    assert page.locator('#trackChoices input').count() == 6
    assert page.locator('#roomChoices input').count() == 7
    assert not errors
    print('GRID METRICS',page.evaluate("""() => {let a=document.querySelector('#timelineGrid'),b=document.querySelector('.room-heading');let c=getComputedStyle(a);return {w:a.getBoundingClientRect().width,offset:a.offsetWidth,min:c.minWidth,width:c.width,template:c.gridTemplateColumns, room:b.getBoundingClientRect().width, parent:document.querySelector('#timelineScroll').getBoundingClientRect().width};}"""))
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / 'scsasm_desktop_initial.png') ,full_page=True)
    page.get_by_role('tab',name='Saturday, April 18, 2026').click()
    print('SATURDAY',page.locator('#resultsSummary').inner_text(),'CARDS',page.locator('.session-card').count())
    print('ROOM HEADERS',page.locator('.room-name').all_inner_texts())
    print('OVERLAP GRAND',page.locator('.room-lane').nth(2).locator('.session-card').count())
    assert page.locator('.session-card').count() == 20
    geometry_issues = page.evaluate("""() => {
      let issues=[];
      for (const lane of document.querySelectorAll('.room-lane')) {
        const cards=[...lane.querySelectorAll('.session-card')];
        for(let i=0;i<cards.length;i++) {
          const a=cards[i];
          if (a.offsetTop < 0 || a.offsetTop + a.offsetHeight > lane.clientHeight + 1) issues.push('card outside lane: '+a.title);
          for(let j=i+1;j<cards.length;j++) {
            const b=cards[j];
            const vertical=Math.min(a.offsetTop+a.offsetHeight,b.offsetTop+b.offsetHeight)-Math.max(a.offsetTop,b.offsetTop);
            const horizontal=Math.min(a.offsetLeft+a.offsetWidth,b.offsetLeft+b.offsetWidth)-Math.max(a.offsetLeft,b.offsetLeft);
            if(vertical > 1 && horizontal > 1) issues.push('card collision: '+a.title+' and '+b.title);
          }
        }
      }
      return issues;
    }""")
    print('TIMELINE GEOMETRY ISSUES',geometry_issues)
    assert not geometry_issues
    starts = page.locator('.room-lane').first.locator('.session-card').first.evaluate('el => el.style.top')
    same_start = page.locator('.room-lane').nth(1).locator('.session-card').first.evaluate('el => el.style.top')
    assert starts == same_start, '08:00 same-time cards in different rooms did not line up' 
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / 'scsasm_desktop_saturday.png'),full_page=True)
    page.locator('button.session-card').first.click()
    print('PANEL_TITLE',page.locator('#detailTitle').inner_text())
    print('DETAIL_ITEMS',page.locator('.program-item').count())
    assert page.locator('#detailClose').evaluate('el => document.activeElement === el'), 'Close button must receive dialog focus'
    page.keyboard.press('Shift+Tab')
    assert page.locator('#detailClose').evaluate('el => document.activeElement !== el'), 'Shift+Tab should reach final dialog focusable'
    page.keyboard.press('Tab')
    assert page.locator('#detailClose').evaluate('el => document.activeElement === el'), 'Tab should wrap to first focusable'
    page.keyboard.press('Escape')
    assert page.locator('.session-card').first.evaluate('el => document.activeElement === el'), 'Focus must return to the clicked card'
    print('DETAIL_CLOSED' ,not page.locator('#detailLayer').is_visible())
    page.get_by_role('tab',name='Sunday, April 19, 2026').click()
    print('SUNDAY',page.locator('#resultsSummary').inner_text(),'CARDS',page.locator('.session-card').count())
    assert page.locator('.session-card').count() == 8
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT / 'scsasm_desktop_sunday.png'),full_page=True)
    page.get_by_role('tab',name='Saturday, April 18, 2026').click()
    page.locator('#programSearch').fill('Long QT Syndrome Presenting as Seizure')
    print('SEARCH PRESENTATION',page.locator('#resultsSummary').inner_text())
    assert page.locator('.session-card').count() == 1
    assert 'AP05' in page.locator('.session-card').first.inner_text()
    page.locator('#clearSearch').click()
    page.locator('#trackToggle').click()
    page.locator('#trackChoices input[value="1"]').check()
    print('TRACK1',page.locator('#resultsSummary').inner_text())
    page.locator('#roomToggle').click()
    page.locator('#roomChoices input[value="Canary"]').check()
    print('TRACK1 & CANARY',page.locator('#resultsSummary').inner_text())
    assert page.locator('.session-card').count() == 0
    assert page.locator('.room-name').all_inner_texts() == ['Canary']
    page.locator('#trackToggle').click()
    page.locator('#trackChoices input[value="2"]').check()
    assert page.locator('.session-card').count() == 2, 'OR across selected tracks should include track 2'
    page.locator('#roomToggle').click()
    page.locator('#roomChoices input[value="Grand Ballroom"]').check()
    assert page.locator('.session-card').count() == 4, 'OR across rooms AND across filter categories'
    page.get_by_role('tab',name='Sunday, April 19, 2026').click()
    assert page.locator('#trackChoices input[value="1"]').is_checked()
    assert page.locator('#roomChoices input[value="Canary"]').is_checked()
    page.locator('#clearFilters').click()
    assert page.get_by_role('tab',name='Sunday, April 19, 2026').get_attribute('aria-selected') == 'true'
    assert page.locator('.session-card').count() == 8
    print('JS ERRORS AT END',errors)
    mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
    mobile_errors=[]
    mobile.on('pageerror',lambda e:mobile_errors.append(str(e)))
    mobile.set_content(build_html(),wait_until='load')
    mobile.wait_for_function("document.querySelector('#sourceBadge').classList.contains('fallback')",timeout=30000)
    mobile.get_by_role('tab',name='Saturday, April 18, 2026').click()
    print('MOBILE OVERFLOW',mobile.evaluate('document.documentElement.scrollWidth - window.innerWidth'))
    print('MOBILE ROOM SCROLL', mobile.evaluate('document.querySelector("#timelineScroll").scrollWidth > document.querySelector("#timelineScroll").clientWidth'))
    assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert mobile.evaluate('document.querySelector("#timelineScroll").scrollWidth > document.querySelector("#timelineScroll").clientWidth')
    print('MOBILE ERRORS',mobile_errors)
    mobile.wait_for_timeout(300)
    mobile.screenshot(path=str(OUTPUT / 'scsasm_mobile_saturday.png'),full_page=True)
    assert not errors and not mobile_errors
    live_page=browser.new_page(viewport={'width':1200,'height':800})
    live_page.set_content(build_html(live=True),wait_until='load')
    live_page.wait_for_function("document.querySelector('#sourceBadge').classList.contains('live')",timeout=30000)
    assert live_page.locator('.session-card').count() == 1
    assert 'Published Google Sheets CSV' in live_page.locator('#sourceBadgeText').inner_text()
    print('SIMULATED LIVE FETCH PATH PASS')
    fatal_page=browser.new_page(viewport={'width':1200,'height':800})
    fatal_page.set_content(build_html(fail_both=True),wait_until='load')
    fatal_page.wait_for_function("!document.querySelector('#fatalError').hidden",timeout=30000)
    assert fatal_page.locator('#retryButton').is_visible()
    assert 'snapshot' in fatal_page.locator('#fatalErrorText').inner_text().lower()
    print('BOTH SOURCES UNAVAILABLE ERROR PATH PASS')
    print('CHROMIUM SMOKE TESTS PASSED')
    browser.close()
