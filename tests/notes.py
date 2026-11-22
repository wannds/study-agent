"""Notes API and UI tests against an isolated real backend; no paid model calls."""
import base64,copy,io,json,time
from urllib.parse import urlencode
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,Model,ROOT,document
checks=[]
def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
def api_checks():
    c=Case(ROOT/'target/release/study-agent.exe')
    try:
        cid=c.fixture();assert c.api('/notes')['total']==0
        note=c.api('/notes','POST',{'title':'课程笔记','course_id':cid});nid=note['id'];path='/notes/'+nid
        assert note['revision']==0 and note['document']['answer']['strokes']==[]
        doc=document();doc['scratch']={'strokes':[]};doc['answer_extra']=[{'sheet':copy.deepcopy(doc['answer']),'image':doc['image']}]
        note.update(text='独立文字与多页手写。检索术语：导数',document=doc)
        c.api(path,'PUT',note);saved=c.api(path);assert saved['revision']==1 and saved['document']==doc
        c.api(path,'PUT',note,409)
        assert c.api('/notes?'+urlencode({'q':'导数','course_id':cid}))['items'][0]['id']==nid
        assert c.api('/notes?'+urlencode({'q':'%'}))['total']==0
        for patch in [{'title':'字'*121},{'course_id':'missing-course'},{'text':'x'*100001},{'revision':-1}]:
            invalid=copy.deepcopy(saved);invalid.update(patch);c.api(path,'PUT',invalid,400)
        invalid=copy.deepcopy(saved);invalid['document']['answer_extra'][0]['sheet']['strokes'][0]['points'][0][0]=1300;c.api(path,'PUT',invalid,400)
        invalid=copy.deepcopy(saved);invalid['document']['scratch']=document()['scratch'];c.api(path,'PUT',invalid,400)
        c.api('/notes/missing',expected=404)
        saved['archived']=True;c.api(path,'PUT',saved);assert c.api('/notes')['total']==0;assert c.api('/notes?archived=true')['items'][0]['id']==nid
        saved=c.api(path);assert saved['document']==doc;saved['archived']=False;c.api(path,'PUT',saved)
        for i in range(51):c.api('/notes','POST',{'title':f'分页测试 {i}'})
        assert len(c.api('/notes?'+urlencode({'q':'分页测试'}))['items'])==50
        tail=c.api('/notes?'+urlencode({'q':'分页测试','offset':50}));assert tail['total']==51 and len(tail['items'])==1
        c.stop();c.start();assert c.api(path)['document']==doc and c.api(path)['text']==note['text']
        assert not Model.seen
        checks.append('API create/save/course links, title and text search, pagination, validation, conflicts, trash/restore and restart persistence pass without AI calls')
    finally:c.close()

def ui_checks():
    c=Case(ROOT/'target/release/study-agent.exe')
    try:
        cid=c.fixture()
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True);context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            def enter():page.goto(f'http://127.0.0.1:{c.port}');page.get_by_role('button',name='我的笔记',exact=True).click()
            def create():page.locator('.page-heading').get_by_role('button',name='新建笔记',exact=True).click();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('未命名笔记')
            def saved(nid,predicate):
                for _ in range(100):
                    v=c.api('/notes/'+nid)
                    if predicate(v):return v
                    time.sleep(.1)
                raise AssertionError('note autosave timeout')
            def draw(y=.3):
                canvas=page.get_by_label('手写笔记',exact=True);canvas.scroll_into_view_if_needed();b=canvas.bounding_box();x=b['x']+b['width']*.25;sy=b['y']+b['height']*y
                page.mouse.move(x,sy);page.mouse.down();page.mouse.move(x+b['width']*.3,sy+25,steps=8);page.mouse.up()
            try:
                enter();expect(page.get_by_text('还没有笔记，点击“新建笔记”开始记录。',exact=True)).to_be_visible();create()
                nid=c.api('/notes')['items'][0]['id'];path='/notes/'+nid
                page.get_by_label('笔记标题',exact=True).fill('微积分复习');page.get_by_label('关联课程',exact=True).select_option(cid)
                page.get_by_label('笔记正文',exact=True).fill('# 导数\n\n记住变化率与切线斜率。')
                saved(nid,lambda n:n['title']=='微积分复习' and n['course_id']==cid and '变化率' in n['text'])
                page.get_by_role('button',name='预览排版',exact=True).click();expect(page.locator('.notes-preview').get_by_role('heading',name='导数',exact=True)).to_be_visible()
                page.get_by_role('button',name='手写笔记',exact=True).click();draw();saved(nid,lambda n:len(n['document']['answer']['strokes'])==1)
                first=page.get_by_label('手写笔记',exact=True).evaluate('e=>e.toDataURL()')
                page.get_by_role('button',name='新增笔记纸',exact=True).click();page.get_by_role('button',name='笔颜色：蓝色',exact=True).click();draw(.5)
                original=saved(nid,lambda n:len(n['document'].get('answer_extra',[]))==1 and len(n['document']['answer_extra'][0]['sheet']['strokes'])==1)
                second=page.get_by_label('手写笔记',exact=True).evaluate('e=>e.toDataURL()');assert first!=second
                page.get_by_role('button',name='笔记纸上一页',exact=True).click();assert page.get_by_label('手写笔记',exact=True).evaluate('e=>e.toDataURL()')==first
                page.get_by_role('button',name='笔记纸下一页',exact=True).click()
                page.locator('.notes-editor').evaluate('e=>e.scrollTop=0');shot(page,'notes-handwriting')
                sep=page.get_by_role('separator',name='调整笔记列表与编辑区大小',exact=True);sep.focus();before=sep.get_attribute('aria-valuenow');page.keyboard.press('ArrowRight');assert sep.get_attribute('aria-valuenow')!=before
                page.set_viewport_size({'width':820,'height':600});page.get_by_role('separator',name='调整导航栏宽度',exact=True).focus();page.keyboard.press('End')
                expect(page.locator('[data-layout="notes-list"]')).to_have_attribute('data-axis','vertical')
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');shot(page,'notes-narrow')
                page.set_viewport_size({'width':1440,'height':1000});page.locator('.topbar').get_by_role('button',name='恢复默认布局',exact=True).click()
                page.get_by_role('button',name='课程空间',exact=True).click();page.get_by_role('button',name='我的笔记',exact=True).click()
                expect(page.get_by_label('笔记标题',exact=True)).to_have_value('微积分复习');expect(page.get_by_role('button',name='笔记纸第 2 页',exact=True)).to_have_attribute('aria-current','page')
                c.stop();c.start();enter();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('微积分复习');assert page.get_by_label('手写笔记',exact=True).evaluate('e=>e.toDataURL()')==second
                page.get_by_role('button',name='文字笔记',exact=True).click();expect(page.get_by_label('笔记正文',exact=True)).to_have_value(original['text'])
                # Switching notes while an autosave is pending cannot cross-write the two notes.
                page.get_by_label('笔记正文',exact=True).fill('离开前最后写下的一段');create();second_id=next(n['id'] for n in c.api('/notes')['items'] if n['id']!=nid)
                expect(page.get_by_label('笔记正文',exact=True)).to_have_value('');saved(nid,lambda n:n['text']=='离开前最后写下的一段')
                page.get_by_label('笔记标题',exact=True).fill('独立灵感');saved(second_id,lambda n:n['title']=='独立灵感')
                page.get_by_role('button',name='移到回收站',exact=True).click();expect(page.get_by_text('笔记已移到回收站，可随时恢复',exact=True)).to_be_visible()
                page.locator('.notes-list-tabs').get_by_role('button',name='回收站',exact=True).click();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('独立灵感');expect(page.get_by_label('笔记正文',exact=True)).to_be_disabled()
                page.get_by_role('button',name='恢复笔记',exact=True).click();expect(page.get_by_text('笔记已恢复',exact=True)).to_be_visible();assert not c.api('/notes/'+second_id)['archived']
                page.locator('.notes-list-tabs').get_by_role('button',name='笔记',exact=True).click();page.get_by_label('搜索笔记',exact=True).fill('最后写下')
                expect(page.locator('.notes-list-item')).to_have_count(1);page.locator('.notes-list-item').click();expect(page.get_by_label('笔记标题',exact=True)).to_have_value('微积分复习')
                # A failed save retains edits and can be retried.
                def fail(route):
                    if route.request.method=='PUT':route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'测试：保存暂时失败'}))
                    else:route.continue_()
                page.route('**/api/notes/'+nid,fail);page.get_by_label('笔记正文',exact=True).fill('网络失败时仍保留的内容')
                expect(page.locator('.notes-editor [role="alert"]')).to_contain_text('测试：保存暂时失败')
                expect(page.get_by_label('笔记正文',exact=True)).to_have_value('网络失败时仍保留的内容');page.unroute('**/api/notes/'+nid,fail)
                page.get_by_role('button',name='重试保存',exact=True).click();saved(nid,lambda n:n['text']=='网络失败时仍保留的内容')
                remote=c.api(path);remote['text']='另一窗口的已保存内容';c.api(path,'PUT',remote)
                page.get_by_label('笔记正文',exact=True).fill('当前窗口冲突草稿');expect(page.locator('.notes-editor [role="alert"]')).to_contain_text('其他窗口修改')
                assert c.api(path)['text']=='另一窗口的已保存内容'
                with page.expect_download() as download:page.get_by_role('button',name='导出本窗口草稿',exact=True).click()
                content=json.loads(open(download.value.path(),encoding='utf-8').read());assert content['text']=='当前窗口冲突草稿';assert content['document']==original['document']
                page.once('dialog',lambda dialog:dialog.accept());page.get_by_role('button',name='重新载入',exact=True).click();expect(page.get_by_label('笔记正文',exact=True)).to_have_value('另一窗口的已保存内容')
                # Course entry selects the course filter without invoking any model.
                page.get_by_role('button',name='课程空间',exact=True).click();page.locator('.course-card').filter(has_text='手写练习演示').click();
                if page.get_by_role('button',name='课程笔记',exact=True).get_attribute('aria-pressed')!='true':page.get_by_role('button',name='课程笔记',exact=True).click()
                page.get_by_role('button',name='打开笔记库',exact=True).click()
                expect(page.get_by_label('按课程筛选笔记',exact=True)).to_have_value(cid)
                assert not errors,errors;assert not Model.seen
                checks.append('UI text/Markdown preview and multi-page handwriting, split resizing, narrow layout, navigation/restart, search, archive/restore, failed-save retry and conflict backup all pass; no AI calls')
            except Exception:
                shot(page,'notes-failure');raise
            finally:browser.close()
    finally:c.close()

try:
    api_checks();ui_checks();report={'ok':True,'checks':checks,'data':'isolated fixtures only; no user data changed'}
    (ROOT/'verification/notes-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
except Exception:
    (ROOT/'verification/notes-tests.json').write_text(json.dumps({'ok':False,'completed':checks},ensure_ascii=False,indent=2),encoding='utf-8');raise
