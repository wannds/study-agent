"""Actual UI and pixels for per-stroke style persistence; isolated database only."""
import base64,copy,io,json,time
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,document,ROOT

case=Case(ROOT/'target/release/study-agent.exe');checks=[]
def shot(page,name):
    raw=page.screenshot();im=Image.open(io.BytesIO(raw));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
try:
    case.fixture();case.model_config();eid=case.exercise();path=f'/exercises/{eid}/ink'
    old=document();old['scratch']['strokes']=[]
    case.api(path,'PUT',{'revision':0,'document':old})
    for patch in [{'color':'not-a-color'},{'width':0},{'width':21},{'tool':'eraser','width':101}]:
        invalid=copy.deepcopy(old);invalid['answer']['strokes'][0].update(patch)
        case.api(path,'PUT',{'revision':1,'document':invalid},400)
    checks.append('legacy strokes load; malformed colors and out-of-range pen/eraser widths rejected')
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        def enter():
            page.goto(f'http://127.0.0.1:{case.port}');page.locator('.course-card').filter(has_text='手写练习演示').click()
            page.get_by_role('button',name='本节练习',exact=False).click();expect(page.get_by_role('button',name='手写答题',exact=True)).to_be_enabled()
        def saved(count):
            for _ in range(80):
                v=case.api(path)
                if len(v['document']['answer']['strokes'])==count:return v
                time.sleep(.1)
            raise AssertionError('save timeout')
        def line(y):
            canvas=page.get_by_label('正式答案',exact=True);canvas.scroll_into_view_if_needed();box=canvas.bounding_box()
            # World coordinates let assertions sample the rendered pixels precisely.
            x=box['x']+600/1200*box['width'];sy=box['y']+y/900*box['height']
            page.mouse.move(x,sy);page.mouse.down();page.mouse.move(x+200/1200*box['width'],sy,steps=8);page.mouse.up()
        try:
            enter();page.get_by_role('button',name='展开书写',exact=True).click()
            canvas=page.get_by_label('正式答案',exact=True)
            expect(canvas).to_be_visible()
            assert canvas.evaluate('(e)=>Array.from(e.getContext("2d").getImageData(100,100,1,1).data)')==[36,39,51,255]
            page.get_by_role('button',name='笔颜色：蓝色',exact=True).click()
            page.get_by_label('正式答案笔粗细',exact=True).focus();page.keyboard.press('End');line(300)
            blue=saved(2);assert blue['document']['answer']['strokes'][-1]['color']=='#2563eb';assert blue['document']['answer']['strokes'][-1]['width']==20
            page.get_by_role('button',name='笔颜色：红色',exact=True).click()
            page.get_by_label('正式答案笔粗细',exact=True).focus();page.keyboard.press('Home');line(400)
            red=saved(3);assert red['document']['answer']['strokes'][-1]['color']=='#dc2626';assert red['document']['answer']['strokes'][-1]['width']==1
            # Native color input's change event, without opening an OS picker in headless mode.
            page.get_by_label('正式答案自定义笔颜色',exact=True).evaluate('e=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;set.call(e,"#117799");e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));}')
            page.get_by_label('正式答案笔粗细',exact=True).focus();page.keyboard.press('End');line(500)
            custom=saved(4);assert custom['document']['answer']['strokes'][-1]['color']=='#117799'
            im=Image.open(io.BytesIO(base64.b64decode(custom['document']['image'].split(',')[1]))).convert('RGB')
            assert im.getpixel((700,300))==(37,99,235)
            assert im.getpixel((700,307))==(37,99,235)
            assert im.getpixel((700,405))==(255,255,255)
            assert im.getpixel((700,500))==(17,119,153)
            checks.append('preset/custom color and pen width affect actual PNG pixels; earlier strokes keep their styles')
            page.get_by_role('button',name='橡皮',exact=True).click()
            page.get_by_label('正式答案橡皮大小',exact=True).focus();page.keyboard.press('End');line(500)
            erased=saved(5);assert erased['document']['answer']['strokes'][-1]['width']==100
            im=Image.open(io.BytesIO(base64.b64decode(erased['document']['image'].split(',')[1]))).convert('RGB');assert im.getpixel((700,500))==(255,255,255)
            page.get_by_role('button',name='撤销',exact=True).click();saved(4)
            page.get_by_role('button',name='重做',exact=True).click();saved(5)
            page.get_by_role('button',name='撤销',exact=True).click();saved(4)
            page.get_by_role('button',name='笔',exact=True).click()
            page.locator('dialog main').evaluate('(e)=>e.scrollTop=0');shot(page,'ink-style-expanded')
            page.set_viewport_size({'width':900,'height':800});shot(page,'ink-style-narrow');assert page.locator('dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+2')
            page.get_by_role('button',name='收起书写',exact=True).click();enter()
            expect(page.get_by_label('正式答案笔粗细',exact=True)).to_have_value('20')
            expect(page.get_by_label('正式答案自定义笔颜色',exact=True)).to_have_value('#117799')
            page.get_by_role('button',name='橡皮',exact=True).click();expect(page.get_by_label('正式答案橡皮大小',exact=True)).to_have_value('100')
            page.get_by_role('button',name='打开草稿纸',exact=True).click()
            scratch=page.locator('.ink-board').filter(has=page.get_by_label('草稿纸',exact=True))
            scratch.get_by_role('button',name='笔颜色：绿色',exact=True).click()
            expect(page.get_by_label('草稿纸自定义笔颜色',exact=True)).to_have_value('#16803d')
            assert case.api(path)['document']['answer']['strokes']==custom['document']['answer']['strokes']
            checks.append('eraser size, undo/redo, reload persistence, narrow layout and independent scratch controls')
            assert not errors,errors
            # Cross-session persistence does not depend on browser preferences.
            case.stop();case.start();restored=case.api(path)
            assert restored['document']['answer']['strokes']==custom['document']['answer']['strokes']
            checks.append('server restart retains legacy and colored strokes together')
        except Exception:
            shot(page,'ink-style-failure');raise
        finally:browser.close()
    report={'ok':True,'checks':checks,'case':str(case.case),'mode':'isolated Edge UI and pixel checks; no paid model calls'}
    (ROOT/'verification/ink-style-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
finally:case.close()
