"""50-page notes and course-scoped selection checks against isolated data."""
import copy,io,json,time
from urllib.parse import urlencode
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,ROOT,document,Model
c=Case(ROOT/'target/release/study-agent.exe');checks=[]
def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
try:
    a=c.fixture();b=c.api('/courses','POST',{'title':'另一门课程','format':'markdown','content':'# 第二门课程\n独立的课程材料。'})['id']
    def create(title,cid=None):return c.api('/notes','POST',{'title':title,'course_id':cid})
    na=create('课程 A · 五十页手写',a);nb=create('课程 B · 第一篇',b);nb2=create('课程 B · 第二篇',b);nc=create('独立灵感')
    doc=document();doc['scratch']={'strokes':[]};doc['answer_extra']=[{'sheet':{'strokes':[]},'image':''} for _ in range(48)]
    na.update(document=doc,text='只属于课程 A 的内容');c.api('/notes/'+na['id'],'PUT',na)
    too_many=c.api('/notes/'+na['id']);too_many['document']['answer_extra'] += [{'sheet':{'strokes':[]},'image':''}]*2
    c.api('/notes/'+na['id'],'PUT',too_many,400)
    assert {n['id'] for n in c.api('/notes?'+urlencode({'course_id':a}))['items']}=={na['id']}
    assert {n['id'] for n in c.api('/notes?'+urlencode({'course_id':b}))['items']}=={nb['id'],nb2['id']}
    assert {n['id'] for n in c.api('/notes?unlinked=true')['items']}=={nc['id']}
    c.api('/notes?'+urlencode({'course_id':a,'unlinked':'true'}),expected=400)
    checks.append('course and independent-note API filters isolate data; 51-page save is rejected')
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1000});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        def enter():page.goto(f'http://127.0.0.1:{c.port}');page.get_by_role('button',name='我的笔记',exact=True).click();expect(page.get_by_label('按课程筛选笔记',exact=True)).to_be_visible()
        def course(cid):page.get_by_label('按课程筛选笔记',exact=True).select_option(cid)
        def saved(nid,predicate):
            for _ in range(100):
                note=c.api('/notes/'+nid)
                if predicate(note):return note
                time.sleep(.1)
            raise AssertionError('save timed out')
        try:
            enter();course(a);expect(page.locator('.notes-list-item')).to_have_count(1);expect(page.get_by_label('笔记标题',exact=True)).to_have_value(na['title'])
            page.get_by_role('button',name='手写笔记',exact=True).click();page.get_by_role('button',name='新增笔记纸',exact=True).click()
            expect(page.get_by_role('button',name='笔记纸第 50 页',exact=True)).to_have_attribute('aria-current','page');expect(page.get_by_role('button',name='新增笔记纸',exact=True)).to_be_disabled()
            canvas=page.get_by_label('手写笔记',exact=True);canvas.scroll_into_view_if_needed();box=canvas.bounding_box();x=box['x']+box['width']*.3;y=box['y']+box['height']*.3
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+80,y+30,steps=8);page.mouse.up()
            saved50=saved(na['id'],lambda n:len(n['document'].get('answer_extra',[]))==49 and len(n['document']['answer_extra'][48]['sheet']['strokes'])==1)
            pixels=canvas.evaluate('e=>e.toDataURL()');page.locator('.notes-editor').evaluate('e=>e.scrollTop=0');shot(page,'notes50-pages')
            c.stop();c.start();enter();expect(page.get_by_label('按课程筛选笔记',exact=True)).to_have_value(a)
            expect(page.get_by_role('button',name='笔记纸第 50 页',exact=True)).to_have_attribute('aria-current','page');assert page.get_by_label('手写笔记',exact=True).evaluate('e=>e.toDataURL()')==pixels
            page.get_by_role('button',name='文字笔记',exact=True).click();page.get_by_label('笔记正文',exact=True).fill('切换课程前写下的独立内容')
            course(b);expect(page.locator('.notes-list-item')).to_have_count(2);page.locator('.notes-list-item').filter(has_text=nb2['title']).click()
            expect(page.get_by_label('笔记标题',exact=True)).to_have_value(nb2['title']);expect(page.get_by_label('笔记正文',exact=True)).to_have_value('')
            saved(na['id'],lambda n:n['text']=='切换课程前写下的独立内容' and n['course_id']==a)
            course(a);expect(page.get_by_label('笔记标题',exact=True)).to_have_value(na['title'])
            course(b);expect(page.get_by_label('笔记标题',exact=True)).to_have_value(nb2['title'])
            page.locator('.page-heading').get_by_role('button',name='新建笔记',exact=True).click();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('未命名笔记');expect(page.get_by_label('关联课程',exact=True)).to_have_value(b)
            notes=c.api('/notes?'+urlencode({'course_id':b}))['items'];new_id=next(n['id'] for n in notes if n['id'] not in [nb['id'],nb2['id']]);assert c.api('/notes/'+new_id)['course_id']==b
            course('__unlinked__');expect(page.locator('.notes-list-item')).to_have_count(1);expect(page.get_by_label('笔记标题',exact=True)).to_have_value(nc['title'])
            page.locator('.page-heading').get_by_role('button',name='新建笔记',exact=True).click();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('未命名笔记');expect(page.get_by_label('关联课程',exact=True)).to_have_value('')
            assert c.api('/notes?unlinked=true')['total']==2
            course(b);expect(page.locator('.notes-list-item')).to_have_count(3);shot(page,'notes50-course')
            # Rapid switching must settle on the last course, with no stale editor from the previous one.
            for cid in [a,b,a,b]:course(cid)
            expect(page.locator('.notes-list-item')).to_have_count(3);expect(page.get_by_label('关联课程',exact=True)).to_have_value(b)
            page.reload();page.get_by_role('button',name='我的笔记',exact=True).click();expect(page.get_by_label('按课程筛选笔记',exact=True)).to_have_value(b);expect(page.get_by_label('关联课程',exact=True)).to_have_value(b)
            assert c.api('/notes/'+na['id'])['document']==saved50['document'];assert not Model.seen;assert not errors,errors
            checks.append('UI adds page 50, prevents page 51, restores page 50 and ink after restart; course selection and per-course note memory persist; creation follows the selected course; independent notes and rapid switching stay isolated')
        except Exception:
            shot(page,'notes50-failure');raise
        finally:browser.close()
    report={'ok':True,'checks':checks,'mode':'isolated data, no AI calls'}
    (ROOT/'verification/notes50-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
finally:c.close()
