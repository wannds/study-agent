"""Course side notes, real isolated backend and browser; no model calls."""
import io,json,time
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,Model,ROOT

checks=[]
c=Case(ROOT/'target/release/study-agent.exe')
def saved(nid,predicate):
    for _ in range(100):
        n=c.api('/notes/'+nid)
        if predicate(n):return n
        time.sleep(.1)
    raise AssertionError('autosave timeout: '+nid)
def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
try:
    a=c.api('/courses','POST',{'title':'课程甲','format':'markdown','content':'# 学习方法\n## 第一节\n学习需要记录。\n## 第二节\n复习需要回顾。'})['id']
    b=c.api('/courses','POST',{'title':'课程乙','format':'markdown','content':'# 数学\n## 第一节\n函数和方程。'})['id']
    n1=c.api('/notes','POST',{'title':'甲的笔记','course_id':a})['id']
    n2=c.api('/notes','POST',{'title':'甲的第二篇','course_id':a})['id']
    c.api('/notes','POST',{'title':'独立笔记'})
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True)
        context=browser.new_context(viewport={'width':1600,'height':1000})
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        def enter(title):
            page.get_by_role('button',name='课程空间',exact=True).click()
            page.locator('.course-card').filter(has_text=title).click()
            expect(page.get_by_role('button',name='课程笔记',exact=True)).to_have_attribute('aria-pressed','false')
            expect(page.get_by_role('button',name='学习助教',exact=True)).to_have_attribute('aria-pressed','false')
            expect(page.locator('.agent-panel,.course-notes-panel')).to_have_count(0)
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(page.get_by_label('课程笔记面板',exact=True)).to_be_visible()
        def body():return page.get_by_label('笔记正文',exact=True)
        try:
            page.goto(f'http://127.0.0.1:{c.port}');enter('课程甲')
            picker=page.get_by_label('本课程笔记',exact=True)
            expect(picker.locator('option')).to_have_count(2);picker.select_option(n1)
            body().fill('第一节的学习记录');saved(n1,lambda n:n['text']=='第一节的学习记录')
            page.locator('.lesson-sidebar button').last.click();expect(body()).to_have_value('第一节的学习记录')
            layout=page.locator('[data-layout="reader-agent"]')
            expect(layout).to_have_attribute('data-axis','horizontal')
            agent=page.locator('.reader-panel').bounding_box();notes=page.locator('.course-notes-panel').bounding_box()
            assert notes['x']>=agent['x']+agent['width']-1
            assert page.locator('.agent-panel').count()==0
            reading_width=page.locator('.reader-panel').bounding_box()['width']
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(page.locator('.agent-panel,.course-notes-panel')).to_have_count(0)
            assert page.locator('.reader-panel').bounding_box()['width']>reading_width+250
            shot(page,'optional-panels-reading')
            page.get_by_role('button',name='学习助教',exact=True).click()
            expect(page.locator('.agent-panel')).to_be_visible()
            page.get_by_label('向助教提问',exact=True).fill('保留未发送的问题')
            page.get_by_role('button',name='学习助教',exact=True).click()
            expect(page.locator('.agent-panel,.course-notes-panel')).to_have_count(0)
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(body()).to_have_value('第一节的学习记录')
            body().fill('切换面板时保存')
            page.get_by_role('button',name='学习助教',exact=True).click()
            expect(page.locator('.course-notes-panel')).to_have_count(0)
            expect(page.get_by_label('向助教提问',exact=True)).to_have_value('保留未发送的问题')
            saved(n1,lambda n:n['text']=='切换面板时保存')
            shot(page,'optional-panels-assistant')
            page.get_by_role('button',name='收起学习助教',exact=True).click()
            expect(page.locator('.agent-panel,.course-notes-panel')).to_have_count(0)
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(body()).to_have_value('切换面板时保存')
            shot(page,'optional-panels-notes')
            checks.append('default reading-only view; both top buttons toggle; assistant and notes are mutually exclusive; closing restores reader width; switching flushes notes and preserves unsent question')
            body().fill('快速切课前的内容');enter('课程乙')
            expect(page.get_by_role('button',name='新建课程笔记',exact=True)).to_be_visible()
            page.get_by_role('button',name='新建课程笔记',exact=True).click()
            expect(page.get_by_label('笔记标题',exact=True)).to_have_value('未命名笔记')
            nb=page.get_by_label('本课程笔记',exact=True).input_value()
            body().fill('乙的独立内容');saved(nb,lambda n:n['course_id']==b and n['text']=='乙的独立内容')
            saved(n1,lambda n:n['text']=='快速切课前的内容')
            enter('课程甲');expect(picker).to_have_value(n1);expect(body()).to_have_value('快速切课前的内容')
            picker.select_option(n2);body().fill('第二篇记录');saved(n2,lambda n:n['text']=='第二篇记录')
            enter('课程乙');expect(picker).to_have_value(nb);enter('课程甲');expect(picker).to_have_value(n2)
            checks.append('course-filtered notes; new notes inherit course; same-course lesson changes preserve note; pending saves and remembered selection isolated by course')
            page.get_by_role('button',name='手写笔记',exact=True).click()
            page.get_by_role('button',name='放大笔记',exact=True).click()
            expect(page.get_by_role('dialog',name='放大课程笔记')).to_be_visible()
            page.get_by_role('button',name='新增笔记纸',exact=True).click()
            canvas=page.get_by_label('手写笔记',exact=True);canvas.scroll_into_view_if_needed();box=canvas.bounding_box()
            x=box['x']+box['width']*.25;y=box['y']+box['height']*.3
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+box['width']*.3,y+30,steps=8);page.mouse.up()
            original=saved(n2,lambda n:len(n['document'].get('answer_extra',[]))==1 and len(n['document']['answer_extra'][0]['sheet']['strokes'])==1)
            pixels=canvas.evaluate('e=>e.toDataURL()');shot(page,'course-notes-expanded')
            page.get_by_role('button',name='返回学习页',exact=True).click()
            expect(page.get_by_role('button',name='笔记纸第 2 页',exact=True)).to_have_attribute('aria-current','page')
            assert canvas.evaluate('e=>e.toDataURL()')==pixels
            page.get_by_role('button',name='学习助教',exact=True).click()
            expect(page.locator('.course-notes-panel')).to_have_count(0)
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(page.locator('.agent-panel')).to_have_count(0)
            expect(page.get_by_role('button',name='笔记纸第 2 页',exact=True)).to_have_attribute('aria-current','page')
            assert canvas.evaluate('e=>e.toDataURL()')==pixels
            page.get_by_role('button',name='放大笔记',exact=True).click();page.keyboard.press('Escape')
            expect(page.get_by_role('dialog')).to_have_count(0);assert canvas.evaluate('e=>e.toDataURL()')==pixels
            page.get_by_role('button',name='打开笔记库',exact=True).click()
            expect(page.get_by_label('按课程筛选笔记',exact=True)).to_have_value(a)
            expect(page.get_by_label('笔记标题',exact=True)).to_have_value('甲的第二篇')
            assert canvas.evaluate('e=>e.toDataURL()')==pixels
            page.get_by_role('button',name='文字笔记',exact=True).click();body().fill('从笔记库更新');saved(n2,lambda n:n['text']=='从笔记库更新')
            enter('课程甲');expect(body()).to_have_value('从笔记库更新')
            assert c.api('/notes/'+n2)['document']==original['document']
            checks.append('multi-page handwriting and exact canvas pixels preserved across enlarge, return, Escape and shared notes library; text edits shared both ways')
            sep=page.get_by_role('separator',name='调整阅读区与课程笔记大小',exact=True)
            sep.scroll_into_view_if_needed();box=sep.bounding_box();before=sep.get_attribute('aria-valuenow')
            x=box['x']+box['width']/2;y=box['y']+50
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x-50,y,steps=8);page.mouse.up()
            assert sep.get_attribute('aria-valuenow')!=before
            pref=page.evaluate("localStorage.getItem('study-layout-v1')")
            page.reload();enter('课程甲');assert page.evaluate("localStorage.getItem('study-layout-v1')")==pref
            page.get_by_role('button',name='收起课程笔记',exact=True).click();expect(page.get_by_label('课程笔记面板',exact=True)).to_have_count(0)
            page.reload();page.locator('.course-card').filter(has_text='课程甲').click()
            expect(page.get_by_role('button',name='课程笔记',exact=True)).to_have_attribute('aria-pressed','false')
            page.get_by_role('button',name='课程笔记',exact=True).click();expect(body()).to_have_value('从笔记库更新')
            page.set_viewport_size({'width':820,'height':700});expect(layout).to_have_attribute('data-axis','vertical')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.locator('.course-notes-panel').scroll_into_view_if_needed();shot(page,'course-notes-narrow')
            page.set_viewport_size({'width':1600,'height':1000})
            checks.append('mouse resizing survives reload; new course entry defaults to closed; narrow windows stack the single notes panel without horizontal overflow')
            def fail(route):
                if route.request.method=='PUT':route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'测试保存失败'}))
                else:route.continue_()
            page.route('**/api/notes/'+n2,fail);body().fill('失败后保留的草稿')
            expect(page.locator('.notes-editor [role="alert"]')).to_contain_text('测试保存失败')
            page.get_by_role('button',name='收起课程笔记',exact=True).click()
            expect(page.get_by_text('笔记尚未保存成功，请在笔记区重试保存或导出备份。',exact=True)).to_be_visible()
            expect(body()).to_have_value('失败后保留的草稿')
            page.get_by_role('button',name='学习助教',exact=True).click()
            expect(page.locator('.agent-panel')).to_have_count(0)
            expect(body()).to_have_value('失败后保留的草稿')
            page.get_by_role('button',name='课程笔记',exact=True).click()
            expect(page.get_by_role('button',name='课程笔记',exact=True)).to_have_attribute('aria-pressed','true')
            page.unroute('**/api/notes/'+n2,fail);page.get_by_role('button',name='重试保存',exact=True).click()
            saved(n2,lambda n:n['text']=='失败后保留的草稿')
            checks.append('failed save retains draft and blocks panel close; retry persists content')
            # Restore a selected note beyond the first API page, then load the remainder.
            for i in range(52):c.api('/notes','POST',{'title':f'甲分页 {i}','course_id':a})
            assert n2 not in [n['id'] for n in c.api('/notes?course_id='+a)['items']]
            page.reload();enter('课程甲');expect(picker).to_have_value(n2)
            expect(body()).to_have_value('失败后保留的草稿')
            page.get_by_role('button',name='加载更多笔记',exact=False).click()
            expect(picker.locator('option')).to_have_count(54)
            assert len(set(picker.locator('option').evaluate_all('xs=>xs.map(x=>x.value)')))==54
            checks.append('remembered note beyond first 50 restored; remaining metadata pages loaded without skipped or duplicate entries')
            assert not errors,errors;assert not Model.seen
        except Exception:
            shot(page,'course-notes-failure');raise
        finally:browser.close()
    report={'ok':True,'checks':checks,'data':'isolated fixtures; no production changes or AI calls'}
    (ROOT/'verification/course-notes-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
finally:c.close()
