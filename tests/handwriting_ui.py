"""Browser exercise of the real app UI on an isolated local fixture server."""
import json, time, urllib.request
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
info=json.loads((ROOT/'verification/handwriting-ui-session.json').read_text())
base=f"http://127.0.0.1:{info['port']}"
def api(path,body=None,method=None):
    req=urllib.request.Request(base+'/api'+path,data=None if body is None else json.dumps(body).encode(),method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r:return json.load(r)
def fail_model(fail):
    req=urllib.request.Request(f"http://127.0.0.1:{info['model_port']}/fixture",data=json.dumps({'fail':fail}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r:assert r.status==200
def shot(page,name):
    path=ROOT/'verification'/f'{name}-full.png';page.screenshot(path=str(path))
    im=Image.open(path);im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
def enter(page):
    page.goto(base);page.locator('.course-card').filter(has_text='手写练习演示').click()
    page.get_by_role('button',name='本节练习',exact=False).click()
    expect(page.get_by_role('button',name='手写答题',exact=True)).to_be_enabled()
def draw(page,label,offset=0):
    canvas=page.get_by_label(label,exact=True);canvas.scroll_into_view_if_needed();b=canvas.bounding_box()
    x,y=b['x']+b['width']*.18,b['y']+b['height']*.23+offset
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+85,y+70,steps=10);page.mouse.move(x+180,y,steps=10);page.mouse.up()
def ink():return api('/exercises/'+info['exercise_id']+'/ink')
def saved(predicate):
    for _ in range(80):
        v=ink()
        if predicate(v):return v
        time.sleep(.1)
    raise AssertionError('saved state did not match')

checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        enter(page);page.get_by_label('练习答案',exact=True).fill('键盘输入的独立草稿')
        page.get_by_role('button',name='手写答题',exact=True).click()
        page.get_by_role('button',name='键盘输入',exact=True).click()
        expect(page.get_by_label('练习答案',exact=True)).to_have_value('键盘输入的独立草稿')
        page.get_by_role('button',name='手写答题',exact=True).click()
        expect(page.get_by_role('button',name='确认并提交批改')).to_be_disabled()
        page.get_by_role('button',name='展开书写',exact=True).click();expect(page.locator('dialog')).to_be_visible()
        draw(page,'正式答案');saved(lambda v:len(v['document']['answer']['strokes'])==1)
        page.get_by_role('button',name='撤销',exact=True).click();saved(lambda v:not v['document']['answer']['strokes'])
        page.get_by_role('button',name='重做',exact=True).click();saved(lambda v:len(v['document']['answer']['strokes'])==1)
        page.get_by_role('button',name='橡皮',exact=True).click();draw(page,'正式答案',20)
        saved(lambda v:v['document']['answer']['strokes'][-1]['tool']=='eraser')
        page.get_by_role('button',name='撤销',exact=True).click();saved(lambda v:len(v['document']['answer']['strokes'])==1)
        page.get_by_role('button',name='打开草稿纸',exact=True).click();draw(page,'草稿纸')
        saved(lambda v:len(v['document']['scratch']['strokes'])==1)
        checks.append('mouse drawing, undo/redo, eraser, independent scratch and automatic server saving')
        page.get_by_role('button',name='收起书写',exact=True).click();page.reload();enter(page)
        expect(page.get_by_role('button',name='手写答题',exact=True)).to_have_attribute('aria-pressed','true')
        page.get_by_role('button',name='展开书写',exact=True).click()
        assert len(ink()['document']['answer']['strokes'])==1
        fail_model(True);page.get_by_role('button',name='识别手写答案',exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('手写识别失败',timeout=20000)
        assert len(ink()['document']['answer']['strokes'])==1
        fail_model(False);page.get_by_role('button',name='识别手写答案',exact=True).click()
        expect(page.get_by_label('核对识别文字与公式（也可手动填写）')).to_have_value('x + 2 = 5\nx = 3（本地测试转录）',timeout=20000)
        expect(page.get_by_role('button',name='确认并提交批改')).to_be_disabled()
        checks.append('reload restores ink; unsupported-model failure retains original; explicit retry and confirmation gate')
        page.locator('dialog main').evaluate('(e)=>e.scrollTop=0');shot(page,'handwriting-expanded')
        page.set_viewport_size({'width':900,'height':800});page.locator('dialog main').evaluate('(e)=>e.scrollTop=0');shot(page,'handwriting-narrow')
        assert page.locator('dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+2')
        page.set_viewport_size({'width':1440,'height':1000})
        # Test actual pen pointer path and rejection of touch; synthetic pressure supplements mouse tests.
        canvas=page.get_by_label('正式答案',exact=True)
        count=len(ink()['document']['answer']['strokes'])
        canvas.dispatch_event('pointerdown',{'pointerId':9,'pointerType':'touch','clientX':30,'clientY':30,'button':0,'pressure':.5})
        canvas.dispatch_event('pointerup',{'pointerId':9,'pointerType':'touch','clientX':40,'clientY':40,'button':0})
        assert len(ink()['document']['answer']['strokes'])==count
        # Save network outage: local backup survives navigation and manual retry.
        page.route('**/api/exercises/*/ink',lambda route:route.abort() if route.request.method=='PUT' else route.continue_())
        page.get_by_role('button',name='笔',exact=True).click();draw(page,'正式答案',60)
        expect(page.get_by_role('alert')).to_be_visible(timeout=10000)
        assert json.loads(page.evaluate("key => localStorage.getItem(key)",'study-ink-v1-'+info['exercise_id']))['dirty']
        page.unroute('**/api/exercises/*/ink');page.get_by_role('button',name='重试保存',exact=True).click()
        saved(lambda v:len(v['document']['answer']['strokes'])==count+1)
        checks.append('narrow layout fits; touch does not write; failed save keeps local draft and retries')
        canvas.scroll_into_view_if_needed();b=canvas.bounding_box();cdp=context.new_cdp_session(page)
        x,y=b['x']+b['width']*.5,b['y']+b['height']*.3
        cdp.send('Input.dispatchMouseEvent',{'type':'mousePressed','x':x,'y':y,'button':'left','buttons':1,'clickCount':1,'pointerType':'pen','force':.3})
        cdp.send('Input.dispatchMouseEvent',{'type':'mouseMoved','x':x+50,'y':y+50,'button':'left','buttons':1,'pointerType':'pen','force':.8})
        cdp.send('Input.dispatchMouseEvent',{'type':'mouseReleased','x':x+50,'y':y+50,'button':'left','buttons':0,'clickCount':1,'pointerType':'pen'})
        pen=saved(lambda v:len(v['document']['answer']['strokes'])==count+2)['document']['answer']['strokes'][-1]
        assert any(abs(p[2]-.8)<.02 for p in pen['points']),pen
        checks.append('emulated pen pointer input retains pressure; keyboard draft remains separate')
        page.get_by_role('button',name='识别手写答案',exact=True).click()
        text=page.get_by_label('核对识别文字与公式（也可手动填写）')
        expect(text).to_have_value('x + 2 = 5\nx = 3（本地测试转录）',timeout=20000)
        text.fill('x + 2 = 5\nx = 5 - 2 = 3（核对后的测试答案）')
        page.get_by_label('我已对照原稿核对文字和公式',exact=True).check()
        page.get_by_label('批改时同时发送正式答案图片',exact=False).check()
        page.get_by_role('button',name='确认并提交批改').click()
        expect(page.get_by_text('90 / 100',exact=True)).to_be_visible(timeout=25000)
        page.get_by_text('查看手写原稿',exact=True).click();expect(page.get_by_alt_text('本题保存的手写答案原稿')).to_be_visible()
        assert '核对后的测试答案' in page.locator('.answer-display').inner_text()
        checks.append('corrected transcription, confirmed image grading, retained original and feedback history')
        shot(page,'handwriting-graded')
        page.get_by_role('button',name='放大原稿',exact=True).click();expect(page.get_by_alt_text('放大的手写原稿')).to_be_visible()
        shot(page,'handwriting-review');page.get_by_role('button',name='收起书写',exact=True).click()
        assert not errors,errors
        report={'ok':True,'checks':checks,'browser':'headless Edge; real local app + isolated deterministic model; physical stylus not tested'}
        (ROOT/'verification/handwriting-ui.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
    except Exception:
        shot(page,'handwriting-ui-failure');raise
    finally:browser.close()
