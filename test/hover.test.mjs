import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.listeners={};this.style={};this.textContent='';this.classList={toggle(){},remove(){},add(){}}}
 appendChild(el){this.children.push(el);el.parentNode=this;return el}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null}
 removeChild(el){el.remove()}
 replaceChildren(){this.children=[]}
 setAttribute(k,v){this.attrs[k]=v}
 getAttribute(k){return this.attrs[k]??null}
 removeAttribute(k){delete this.attrs[k]}
 addEventListener(k,fn){(this.listeners[k]??=[]).push(fn)}
 emit(k){for(const fn of this.listeners[k]||[])fn({stopPropagation(){},preventDefault(){}})}
 getBoundingClientRect(){const x=parseFloat(this.style.left)||20,y=parseFloat(this.style.top)||12,width=Math.min(parseFloat(this.style.width)||200,340),height=Math.min(parseFloat(this.style.maxHeight)||40,180);return {x,y,width,height,bottom:y+height}}
 querySelector(s){return s==='.dpa-tip'?this.tip:s==='.dpa-actions'?this.actions:null}
 querySelectorAll(){return []}
}
function setup(){
 const host=new Element('div'),body=new Element('body'),regions=[],timers=new Map();let serial=0;
 const doc={currentScript:{getAttribute:()=> 'fixture'},body,head:new Element('head'),getElementById:()=>({}),querySelector:()=>host,
 createElement(tag){const el=new Element(tag);if(tag==='div'){el.tip=new Element('span');el.actions=new Element('div')}return el}}
 const sandbox={console,document:doc,window:{innerWidth:220,innerHeight:190,petBridge:{setInputRegions(v){regions.push(v)}}},
 setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id},clearTimeout(id){timers.delete(id)}};
 let source=fs.readFileSync(new URL('../runtime/pet-approval.js',import.meta.url),'utf8');
 source=source.slice(0,source.lastIndexOf('  if (document.readyState'))+`globalThis.api={renderCard,removeCard,cardRects,hideDetails,showDetails,placeDetails,answer,get card(){return card},get detail(){return detail}};})()`;
 vm.runInNewContext(source,sandbox);
 return {api:sandbox.api,body,regions,timers,window:sandbox.window,run(ms){for(const [id,t] of [...timers])if(t.ms===ms){timers.delete(id);t.fn()}}}
}
const item={id:'one',risk:'medium',toolName:'run_command',reason:'在演示文件夹写入 hello.txt\n仅用于演示'};

test('悬停延迟出现完整请求；离开前取消不会残留提示，不发起授权',()=>{
 const h=setup();h.api.renderCard(item,0);const card=h.api.card;
 assert.equal(h.api.detail,null);card.emit('mouseenter');assert.equal(h.api.detail,null);
 card.emit('mouseleave');h.run(300);assert.equal(h.api.detail,null);
 card.emit('mouseenter');h.run(300);
 assert.equal(h.api.detail.getAttribute('role'),'tooltip');
 assert.equal(h.api.detail.children[0].textContent,'请求工具：run_command');
 assert.equal(h.api.detail.children[1].textContent,item.reason);
 assert.match(h.api.detail.children[2].textContent,/仅授权当前这一次/);
 assert.equal(card.getAttribute('title'),null);
 assert.equal(card.getAttribute('aria-describedby'),'dpa-request-details');
});

test('可以移入详情阅读，滚动区纳入点击区域，延迟离开和撤销卡片会清理',()=>{
 const h=setup();h.api.renderCard(item,0);h.api.card.emit('mouseenter');h.run(300);
 h.api.card.emit('mouseleave');h.api.detail.emit('mouseenter');h.run(180);assert.ok(h.api.detail);
 assert.equal(h.api.cardRects().length,2);assert.equal(h.regions.at(-1).rects.length,2);
 h.api.detail.emit('mouseleave');h.run(180);assert.equal(h.api.detail,null);
 h.api.card.emit('mouseenter');h.api.removeCard();h.run(300);assert.equal(h.api.detail,null);assert.equal(h.body.children.length,0);
});

test('同一请求内容/风险更新立刻刷新，长文本和HTML按原文展示，新请求不继承旧浮层',()=>{
 const h=setup();h.api.renderCard(item,0);h.api.showDetails();
 const reason='<img src=x onerror=alert(1)>\n'+ '完整内容'.repeat(2000);
 h.api.renderCard({...item,reason,risk:'high'},0);
 assert.equal(h.api.detail.children[1].textContent,reason);assert.equal(h.api.detail.children[1].children.length,0);
 assert.match(h.api.detail.children[2].textContent,/回 DSH 手动决定/);
 assert.match(h.api.card.actions.innerHTML,/data-outcome="view"/);assert.doesNotMatch(h.api.card.actions.innerHTML,/allowed-once/);
 const box=h.api.detail.getBoundingClientRect();assert.ok(box.x>=8&&box.y>=8);assert.ok(box.x+box.width<=212);assert.ok(box.y+box.height<=182);
 h.api.renderCard({...item,id:'two'},0);assert.equal(h.api.detail,null);
});

test('缺少理由明确回DSH查看；键盘焦点可展开，关闭后释放提示区域',()=>{
 const h=setup();h.api.renderCard({id:'empty'},0);h.api.card.emit('focusin');
 assert.match(h.api.detail.children[1].textContent,/未提供具体请求说明/);
 h.api.hideDetails();assert.equal(h.api.card.getAttribute('aria-describedby'),null);assert.equal(h.api.cardRects().length,1);
});
