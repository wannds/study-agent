import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, LoaderCircle, Maximize2, NotebookPen, Plus, RefreshCw, X } from 'lucide-react';
import { NoteEditor, rememberedNote, rememberNote } from './NotesPage';
import { noteStore, type Note, type NoteList, type NoteSummary } from './notes';
import { request } from './ink';
import './course-notes.css';
type Course={id:string;title:string};
export default function CourseNotesPanel({course,courses,onClose,onOpenLibrary,onOpenCourse,toast}:{course:Course;courses:Course[];onClose:()=>void;onOpenLibrary:()=>void;onOpenCourse:(id:string)=>void;toast:(message:string)=>void}){
 const [items,setItems]=useState<NoteSummary[]>([]),[total,setTotal]=useState(0),[nextOffset,setNextOffset]=useState(0),[selected,setSelected]=useState('');
 const [loading,setLoading]=useState(true),[creating,setCreating]=useState(false),[leaving,setLeaving]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
 const ticket=useRef(0),alive=useRef(true),selection=useRef(''),firstLoad=useRef(true);
 const dialog=useRef<HTMLDialogElement>(null),expandButton=useRef<HTMLButtonElement>(null);
 function choose(id:string){selection.current=id;setSelected(id);rememberNote(id,course.id,false)}
 const load=useCallback(async(offset=0,showLoading=false)=>{
  const id=++ticket.current;if(showLoading)setLoading(true);
  try{
   const result=await request<NoteList>(`/notes?${new URLSearchParams({course_id:course.id,archived:'false',offset:String(offset)})}`);
   if(!alive.current||id!==ticket.current)return;
   let restored:Note|null=null;
   let pick=selection.current || (firstLoad.current?rememberedNote(course.id,false):'');
   if(!offset && pick){
    const state=noteStore(pick).value;
    if(state.note && (state.note.course_id!==course.id || state.note.archived)){pick=''}
    else if(!result.items.some(n=>n.id===pick)){
     try{const n=await request<Note>(`/notes/${pick}`);if(n.course_id===course.id&&!n.archived){restored=n}else{pick=''}}catch(e){if((e as Error&{status?:number}).status===404)pick='';else throw e}
    }
   }
   if(!alive.current||id!==ticket.current)return;
   firstLoad.current=false;setError('');setTotal(result.total);setNextOffset(offset+result.items.length);
   setItems(old=>{
    const next=offset?[...old,...result.items.filter(n=>!old.some(x=>x.id===n.id))]:result.items;
    if(restored&&!next.some(n=>n.id===restored!.id)){const n=restored;return [...next,{...n,course_title:course.title,preview:n.text.slice(0,100),page_count:1+(n.document.answer_extra?.length||0)}]}
    return next;
   });
   if(!offset){pick=pick||result.items[0]?.id||'';choose(pick)}
  }catch(e){if(alive.current&&id===ticket.current)setError((e as Error).message)}
  finally{if(alive.current&&id===ticket.current)setLoading(false)}
 },[course.id,course.title]);
 useEffect(()=>{alive.current=true;void load(0,true);return()=>{alive.current=false;ticket.current++}},[load]);
 useEffect(()=>{const changed=()=>void load();window.addEventListener('study-notes-changed',changed);return()=>window.removeEventListener('study-notes-changed',changed)},[load]);
 useEffect(()=>{if(expanded&&dialog.current&&!dialog.current.open)dialog.current.showModal()},[expanded]);
 async function create(){
  setCreating(true);setError('');
  try{const note=await request<Note>('/notes','POST',{title:'未命名笔记',course_id:course.id});noteStore(note.id,note);if(!alive.current)return;choose(note.id);await load()}
  catch(e){if(alive.current)setError((e as Error).message)}finally{if(alive.current)setCreating(false)}
 }
 async function leave(next:()=>void){
  setLeaving(true);
  try{if(selected&&noteStore(selected).value.dirty)await noteStore(selected).flush();next()}
  catch{toast('笔记尚未保存成功，请在笔记区重试保存或导出备份。')}
  finally{if(alive.current)setLeaving(false)}
 }
 function collapse(){setExpanded(false);requestAnimationFrame(()=>expandButton.current?.focus())}
 const editor=selected?<NoteEditor key={selected} id={selected} courses={courses} compact onMoved={()=>{choose('');void load()}} onOpenCourse={onOpenCourse} toast={toast}/>:error?<div className="course-note-empty"><p>暂时无法显示课程笔记，请重试读取。</p></div>:<div className="course-note-empty"><NotebookPen size={30}/><h3>边学边记</h3><p>这门课程还没有笔记。新建后会自动关联当前课程，并同步到「我的笔记」。</p><button className="button primary small" disabled={creating||loading||!!error} onClick={create}><Plus size={15}/>新建课程笔记</button></div>;
 return <aside className="course-notes-panel" aria-label="课程笔记面板">
  <header className="course-notes-heading"><NotebookPen size={19}/><div><strong>课程笔记</strong><span title={course.title}>{course.title}</span></div><button ref={expandButton} className="icon-button" aria-label="放大笔记" title="放大笔记，方便手写" disabled={!selected||leaving} onClick={()=>setExpanded(true)}><Maximize2 size={16}/></button><button className="icon-button" aria-label="收起课程笔记" disabled={leaving} onClick={()=>void leave(onClose)}><X size={17}/></button></header>
  <div className="course-notes-picker"><label htmlFor={`course-note-${course.id}`}>本课程笔记<select aria-label="本课程笔记" id={`course-note-${course.id}`} disabled={loading||creating||leaving||!items.length} value={selected} onChange={e=>choose(e.target.value)}>{!items.length&&<option value="">{loading?'正在读取…':'尚无笔记'}</option>}{items.map(n=><option key={n.id} value={n.id}>{n.title} · {n.page_count} 页</option>)}</select></label><div className="course-notes-commands"><button className="button secondary small" disabled={loading||creating||leaving} onClick={create}>{creating?<LoaderCircle className="spin" size={14}/>:<Plus size={14}/>}新建笔记</button><button className="text-button" disabled={leaving} onClick={()=>void leave(onOpenLibrary)}><ExternalLink size={13}/>打开笔记库</button><button className="icon-button" aria-label="刷新课程笔记" disabled={loading||creating} onClick={()=>void load(0,true)}><RefreshCw size={14}/></button></div>{nextOffset<total&&<button className="text-button" disabled={loading} onClick={()=>void load(nextOffset)}>加载更多笔记（{items.length}/{total}）</button>}</div>
  {error&&<div className="ink-error course-notes-error" role="alert">{error}<button className="text-button" onClick={()=>void load(0,true)}>重试读取</button></div>}
  {loading&&!selected?<p className="course-notes-loading" role="status"><LoaderCircle className="spin" size={17}/>正在读取课程笔记…</p>:expanded?<div className="course-note-empty"><p>正在放大窗口中编辑笔记</p></div>:editor}
  {expanded&&selected&&createPortal(<dialog ref={dialog} className="course-note-dialog" aria-label="放大课程笔记" onCancel={e=>{e.preventDefault();collapse()}} onClose={()=>setExpanded(false)}><header><div><NotebookPen size={20}/><strong>课程笔记</strong><span>{course.title}</span></div><button className="button secondary small" onClick={collapse}><X size={16}/>返回学习页</button></header>{editor}</dialog>,document.body)}
 </aside>;
}
