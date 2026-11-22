"""Multi-page API, real browser interactions and cursor geometry; isolated data only."""
import base64,copy,io,json,time,re
from PIL import Image,ImageDraw
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,Model,ROOT,document

checks=[]
def image(color):
    im=Image.new('RGB',(1200,900),'white');ImageDraw.Draw(im).line([(100,100),(250,240),(450,100)],fill=color,width=5)
    raw=io.BytesIO();im.save(raw,format='PNG');return 'data:image/png;base64,'+base64.b64encode(raw.getvalue()).decode()
def api_checks():
    c=Case(ROOT/'target/release/study-agent.exe')
    try:
        c.fixture();c.model_config();eid=c.exercise();path=f'/exercises/{eid}/ink';legacy=document()
        c.api(path,'PUT',{'revision':0,'document':legacy});assert c.api(path)['document']==legacy
        doc=copy.deepcopy(legacy);doc['answer_extra']=[{'sheet':copy.deepcopy(legacy['answer']),'image':image('blue')}];doc['answer_extra'][0]['sheet']['strokes'][0]['color']='#0000ff'
        doc['scratch_extra']=[copy.deepcopy(legacy['scratch'])]
        for invalid in ['missing_image','bad_point','too_many']:
            bad=copy.deepcopy(doc)
            if invalid=='missing_image':bad['answer_extra'][0]['image']=''
            elif invalid=='bad_point':bad['scratch_extra'][0]['strokes'][0]['points'][0][0]=1400
            else:bad['answer_extra']*=20
            c.api(path,'PUT',{'revision':1,'document':bad},400)
        c.api(path,'PUT',{'revision':1,'document':doc});c.api(path+'/recognize','POST',{'revision':2})
        content=Model.seen[-1]['messages'][-1]['content'];assert [p['image_url']['url'] for p in content if p['type']=='image_url']==[doc['image'],doc['answer_extra'][0]['image']]
        assert any('第 2 页' in p.get('text','') for p in content)
        assert 'scratch' not in json.dumps(content) and '999' not in ''.join(p.get('text','') for p in content)
        count=len(Model.seen);doc['scratch_extra'][0]['strokes'][0]['points'][0][0]=998
        c.api(path,'PUT',{'revision':2,'document':doc});assert c.api(path)['recognized_revision']==3
        c.api(path+'/recognize','POST',{'revision':3});assert len(Model.seen)==count
        doc['answer_extra'][0]['image']=image('red');doc['answer_extra'][0]['sheet']['strokes'][0]['color']='#ff0000'
        c.api(path,'PUT',{'revision':3,'document':doc});assert c.api(path)['recognized_revision']==-1
        c.api(path+'/recognize','POST',{'revision':4});assert len(Model.seen)==count+1
        blank=copy.deepcopy(doc);blank['answer']={'strokes':[]};blank['image']=''
        c.api(path,'PUT',{'revision':4,'document':blank});c.api(path+'/recognize','POST',{'revision':5})
        content=Model.seen[-1]['messages'][-1]['content'];assert len([x for x in content if x['type']=='image_url'])==1;assert any('第 2 页' in p.get('text','') for p in content)
        c.api(path,'PUT',{'revision':5,'document':doc})
        c.stop();c.start();assert c.api(path)['document']==doc
        job=c.api(f'/exercises/{eid}/grade','POST',{'answer':'全部两页的已核对答案','handwriting_revision':6,'handwriting_confirmed':True,'include_image':True})
        assert c.wait(job['id'])['status']=='done'
        content=Model.seen[-1]['messages'][-1]['content'];assert [p['image_url']['url'] for p in content if p['type']=='image_url']==[doc['image'],doc['answer_extra'][0]['image']]
        c.api(path,'PUT',{'revision':6,'document':doc},409)
        checks.append('legacy documents preserved; page validation, all-page recognition/grading, scratch exclusion, later-page cache invalidation, blank first page and server restart pass')
    finally:c.close()

def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)

def ui_checks():
    c=Case(ROOT/'target/release/study-agent.exe')
    try:
        c.fixture();c.model_config();eid=c.exercise();path=f'/exercises/{eid}/ink'
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True);context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            def enter():
                page.goto(f'http://127.0.0.1:{c.port}');page.locator('.course-card').filter(has_text='手写练习演示').click();page.get_by_role('button',name='学习助教',exact=True).click();page.get_by_role('button',name='本节练习',exact=False).click()
                expect(page.get_by_role('button',name='展开书写',exact=True)).to_be_enabled();page.get_by_role('button',name='手写答题',exact=True).click();page.get_by_role('button',name='展开书写',exact=True).click()
            def notebook(kind='答题纸'):return page.get_by_role('region',name=kind+'分页',exact=True)
            def canvas(kind='答题纸'):return notebook(kind).get_by_label('正式答案' if kind=='答题纸' else '草稿纸',exact=True)
            def draw(kind='答题纸',y=.3):
                cv=canvas(kind);cv.scroll_into_view_if_needed();b=cv.bounding_box();x=b['x']+b['width']*.3;sy=b['y']+b['height']*y
                page.mouse.move(x,sy);page.mouse.down();page.mouse.move(x+b['width']*.2,sy+10,steps=8);page.mouse.up()
            def saved(predicate):
                for _ in range(100):
                    v=c.api(path)
                    if predicate(v['document']):return v
                    time.sleep(.1)
                raise AssertionError('page save timeout')
            try:
                enter();draw();saved(lambda d:len(d['answer']['strokes'])==1)
                first=canvas().evaluate('e=>e.toDataURL()')
                assert 'data:image/svg+xml' in canvas().evaluate('e=>getComputedStyle(e).cursor')
                notebook().get_by_role('button',name='新增答题纸',exact=True).click();expect(notebook().get_by_role('button',name='答题纸第 2 页',exact=True)).to_have_attribute('aria-current','page')
                notebook().get_by_role('button',name='笔颜色：蓝色',exact=True).click();draw(y=.5)
                state=saved(lambda d:len(d.get('answer_extra',[]))==1 and len(d['answer_extra'][0]['sheet']['strokes'])==1)
                second=canvas().evaluate('e=>e.toDataURL()');assert second!=first
                notebook().get_by_role('button',name='答题纸上一页',exact=True).click();assert canvas().evaluate('e=>e.toDataURL()')==first
                draw(y=.6);saved(lambda d:len(d['answer']['strokes'])==2)
                notebook().get_by_role('button',name='答题纸下一页',exact=True).click();assert canvas().evaluate('e=>e.toDataURL()')==second
                page.get_by_role('button',name='打开草稿纸',exact=True).click();draw('草稿纸')
                notebook('草稿纸').get_by_role('button',name='新增草稿纸',exact=True).click();draw('草稿纸',.5)
                state=saved(lambda d:len(d.get('scratch_extra',[]))==1 and len(d['scratch_extra'][0]['strokes'])==1)
                assert len(state['document']['answer']['strokes'])==2 and len(state['document']['answer_extra'][0]['sheet']['strokes'])==1
                # The transparent ring is separate DOM: hovering cannot change stored/canvas pixels.
                board=notebook();board.get_by_role('button',name='橡皮',exact=True).click();slider=board.get_by_label('正式答案橡皮大小',exact=True)
                slider.focus();page.keyboard.press('Home');cv=canvas();cv.scroll_into_view_if_needed();b=cv.bounding_box();page.mouse.move(b['x']+b['width']*.5,b['y']+b['height']*.5)
                ring=board.locator('.ink-eraser-cursor');expect(ring).to_be_visible();small=ring.bounding_box()['width']
                assert cv.evaluate('e=>getComputedStyle(e).cursor')=='none';assert ring.evaluate('e=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
                assert ring.evaluate('e=>parseFloat(getComputedStyle(e).borderTopWidth)>0')
                slider.focus();page.keyboard.press('End');cv.scroll_into_view_if_needed();b=cv.bounding_box();page.mouse.move(b['x']+b['width']*.5,b['y']+b['height']*.5)
                expect(ring).to_be_visible();big=ring.bounding_box()['width'];assert big>small*10;assert abs(big-b['width']*100/1200)<1
                assert cv.evaluate('e=>e.toDataURL()')==second
                shot(page,'multipage-eraser')
                board.get_by_role('button',name='笔',exact=True).click();cv.scroll_into_view_if_needed();b=cv.bounding_box();page.mouse.move(b['x']+50,b['y']+50);expect(ring).to_be_hidden()
                assert 'data:image/svg+xml' in cv.evaluate('e=>getComputedStyle(e).cursor')
                page.get_by_role('button',name='上下排列',exact=True).click();page.set_viewport_size({'width':820,'height':600})
                assert page.locator('dialog').evaluate('e=>e.scrollWidth<=e.clientWidth+2');assert canvas().evaluate('e=>e.toDataURL()')==second
                page.set_viewport_size({'width':1440,'height':1000});page.get_by_role('button',name='左右排列',exact=True).click()
                page.get_by_role('button',name='收起书写',exact=True).click();enter()
                expect(notebook().get_by_role('button',name='答题纸第 2 页',exact=True)).to_have_attribute('aria-current','page');assert canvas().evaluate('e=>e.toDataURL()')==second
                page.get_by_role('button',name='打开草稿纸',exact=True).click();expect(notebook('草稿纸').get_by_role('button',name='草稿纸第 2 页',exact=True)).to_have_attribute('aria-current','page')
                page.get_by_role('button',name='识别手写答案',exact=True).click();expect(page.get_by_label('核对识别文字与公式（也可手动填写）')).to_have_value(re.compile('x = 3'))
                imgs=[x['image_url']['url'] for x in Model.seen[-1]['messages'][-1]['content'] if x['type']=='image_url'];assert len(imgs)==2
                page.get_by_label('我已对照原稿核对文字和公式').check();page.get_by_label('批改时同时发送全部答题页图片',exact=False).check();page.get_by_role('button',name='确认并提交批改',exact=True).click()
                expect(page.get_by_text('90 / 100',exact=True)).to_be_visible(timeout=15000)
                page.get_by_text('查看手写原稿（2 页）',exact=True).click();book=notebook();expect(book.get_by_role('button',name='答题纸第 2 页',exact=True)).to_be_visible();book.get_by_role('button',name='答题纸第 1 页',exact=True).click()
                assert book.get_by_role('button',name='新增答题纸',exact=True).count()==0;expect(book.get_by_role('button',name='笔',exact=True)).to_be_disabled()
                page.get_by_role('button',name='放大原稿',exact=False).click();expect(page.locator('dialog').get_by_role('region',name='答题纸分页',exact=True)).to_be_visible()
                assert not errors,errors
                checks.append('UI adds and revisits both notebooks; per-page writing and reload persist; transparent eraser scales to actual footprint; pen cursor, narrow layout and submitted read-only review pass')
            except Exception:
                shot(page,'multipage-failure');raise
            finally:browser.close()
    finally:c.close()

try:
    api_checks();ui_checks()
    report={'ok':True,'checks':checks,'model':'deterministic local fixture; no paid AI calls'}
    (ROOT/'verification/multipage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
except Exception:
    (ROOT/'verification/multipage.json').write_text(json.dumps({'ok':False,'completed':checks},ensure_ascii=False,indent=2),encoding='utf-8');raise
