"""Resize all split views, check state persistence and original handwriting pixels."""
import io,json,time
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from layout_fixture import LayoutFixture,ROOT

fixture=LayoutFixture();checks=[]
def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True);context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        video_state='empty';plan_state='empty'
        def fulfill(route,value,status=200):route.fulfill(status=status,content_type='application/json',body=json.dumps(value,ensure_ascii=False))
        def video(route):
            if route.request.url.endswith('/status'):return fulfill(route,{'root':'isolated-test','ready':True,'local_asr_ready':True,'tools':[]})
            tasks=[] if video_state=='empty' else [{'id':'fixture-video','title':'布局测试视频','source':'local-fixture','status':video_state,'stage':'测试阶段','percent':45,'error':'本地测试错误' if video_state=='failed' else '','course_id':fixture.cid if video_state=='done' else '','created_at':0}]
            fulfill(route,tasks)
        page.route('**/api/video/**',video)
        def plans(route):
            if plan_state=='error':return fulfill(route,{'error':'计划列表测试失败'},500)
            plan={'id':'layout-plan','course_id':fixture.cid,'title':'布局测试计划','status':plan_state,'daily_minutes':30,'start_date':'2026-11-18','stage':'测试状态','error':'测试分析失败' if plan_state=='failed' else ''}
            if route.request.url.endswith('/plans'):return fulfill(route,[] if plan_state=='empty' else [plan])
            fulfill(route,{'plan':plan,'analysis':{'summary':'这是隔离测试数据。','units':[]},'tasks':[]})
        page.route('**/api/plans**',plans)
        def enter():
            page.goto(fixture.url);page.locator('.course-card').filter(has_text='手写练习演示').click()
            expect(page.get_by_role('separator',name='调整课程目录宽度',exact=True)).to_be_visible()
            page.get_by_role('button',name='学习助教',exact=True).click()
        def drag(label,delta):
            sep=page.get_by_role('separator',name=label,exact=True);sep.scroll_into_view_if_needed();b=sep.bounding_box();vertical=sep.get_attribute('aria-orientation')=='vertical'
            x=b['x']+b['width']/2;y=b['y']+b['height']/2
            before=float(sep.get_attribute('aria-valuenow'));page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+delta if vertical else x,y if vertical else y+delta,steps=8);page.mouse.up()
            after=float(sep.get_attribute('aria-valuenow'));assert abs(before-after)>3,(label,before,after);return after
        def reset():page.locator('.topbar').get_by_role('button',name='恢复默认布局',exact=True).click()
        def pref():return json.loads(page.evaluate("localStorage.getItem('study-layout-v1')") or '{}')
        try:
            enter();drag('调整导航栏宽度',45);drag('调整课程目录宽度',45);drag('调整阅读区与学习助教大小',-60);drag('调整对话区与输入区高度',-35)
            saved=pref();assert len(saved)>=4
            shot(page,'layout-workspace')
            enter();assert pref()==saved
            sep=page.get_by_role('separator',name='调整课程目录宽度',exact=True);before=sep.get_attribute('aria-valuenow');sep.focus();page.keyboard.press('ArrowRight');assert sep.get_attribute('aria-valuenow')!=before
            sep.dblclick();assert 'toc.horizontal' not in pref()
            # A cancelled drag leaves both preference and body cursor unchanged.
            sep=page.get_by_role('separator',name='调整导航栏宽度',exact=True);b=sep.bounding_box();before=pref();page.mouse.move(b['x']+4,b['y']+80);page.mouse.down();page.mouse.move(b['x']+40,b['y']+80);page.keyboard.press('Escape');page.mouse.up();assert pref()==before
            checks.append('navigation, TOC, reader/assistant and input height drag; reload persistence, keyboard/double-click reset and Escape cancel')
            page.get_by_role('button',name='本节练习',exact=False).click();expect(page.get_by_role('button',name='手写答题',exact=True)).to_be_enabled()
            page.get_by_role('button',name='手写答题',exact=True).click();page.get_by_role('button',name='展开书写',exact=True).click()
            canvas=page.get_by_label('正式答案',exact=True);canvas.scroll_into_view_if_needed();b=canvas.bounding_box();x,y=b['x']+b['width']*.3,b['y']+b['height']*.3
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+80,y+40,steps=10);page.mouse.up()
            for _ in range(60):
                ink=fixture.case.api(f'/exercises/{fixture.eid}/ink')
                if ink['revision']>0:break
                time.sleep(.1)
            original=ink['document'];pixels=canvas.evaluate('e=>e.toDataURL()')
            drag('调整题目区与书写区大小',65)
            page.get_by_role('button',name='上下排列',exact=True).click();expect(page.get_by_role('separator',name='调整题目区与书写区大小')).to_have_attribute('aria-orientation','horizontal')
            drag('调整题目区与书写区大小',45);assert canvas.evaluate('e=>e.toDataURL()')==pixels
            shot(page,'layout-handwriting-vertical')
            page.get_by_role('button',name='收起书写',exact=True).click();page.get_by_role('button',name='展开书写',exact=True).click()
            expect(page.get_by_role('button',name='上下排列',exact=True)).to_have_attribute('aria-pressed','true')
            page.locator('dialog').get_by_role('button',name='恢复默认布局',exact=True).click();expect(page.get_by_role('button',name='左右排列',exact=True)).to_have_attribute('aria-pressed','true')
            assert fixture.case.api(f'/exercises/{fixture.eid}/ink')['document']==original
            checks.append('handwriting horizontal/vertical splits, direction persistence and local reset preserve stroke data and bitmap pixels')
            page.get_by_role('button',name='收起书写',exact=True).click();reset();assert pref()=={}
            page.get_by_role('button',name='视频转笔记',exact=True).click();drag('调整视频输入区与说明区大小',-60)
            expect(page.get_by_text('还没有符合条件的视频任务。添加一份视频开始。')).to_be_visible()
            for state in ['running','failed','done']:
                video_state=state;expect(page.get_by_text('布局测试视频',exact=False)).to_be_visible(timeout=10000)
                expect(page.locator('.video-task .status-pill')).to_have_text({'running':'转换中','failed':'失败','done':'已完成'}[state],timeout=10000)
            shot(page,'layout-video')
            page.locator('.main-nav').get_by_role('button',name='学习计划',exact=True).click();expect(page.get_by_text('还没有学习计划。',exact=False)).to_be_visible()
            plan_state='error';expect(page.get_by_role('alert')).to_contain_text('计划列表测试失败',timeout=10000)
            plan_state='running';page.get_by_role('button',name='刷新',exact=True).click();expect(page.get_by_role('separator',name='调整计划列表与详情区大小')).to_be_visible(timeout=10000)
            drag('调整计划列表与详情区大小',55)
            for state in ['failed','draft','completed']:
                plan_state=state;expect(page.locator('.plan-content .quiet-badge').first).to_have_text({'failed':'需重试','draft':'待确认','completed':'已完成安排'}[state],timeout=10000)
            checks.append('video and plan panes resize in empty, failure, running and completed states')
            for name in ['课程空间','练习记录','运行任务','导出中心','账号连接']:
                page.get_by_role('button',name=name,exact=True).click();expect(page.get_by_role('separator',name='调整导航栏宽度')).to_be_visible();drag('调整导航栏宽度',10)
                assert page.locator('.main-shell').evaluate('e=>e.clientWidth>350')
            checks.append('shared navigation resizing remains available on all eight module pages')
            enter();reset();page.set_viewport_size({'width':820,'height':600})
            expect(page.locator('[data-layout="reader-agent"]')).to_have_attribute('data-axis','vertical')
            drag('调整阅读区与学习助教大小',20)
            shot(page,'layout-narrow')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.set_viewport_size({'width':1440,'height':1000});expect(page.locator('[data-layout="reader-agent"]')).to_have_attribute('data-axis','horizontal')
            reset();assert pref()=={}
            assert fixture.case.api(f'/exercises/{fixture.eid}/ink')['document']==original
            assert not errors,errors
            checks.append('minimum desktop window stacks constrained panels, restores wide arrangement and global reset leaves course/ink data intact')
            report={'ok':True,'checks':checks,'case':str(fixture.case.case),'mode':'current built frontend with isolated local backend and fixture states'}
            (ROOT/'verification/layout-ui.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
        except Exception:
            shot(page,'layout-ui-failure');raise
        finally:browser.close()
finally:fixture.close()
