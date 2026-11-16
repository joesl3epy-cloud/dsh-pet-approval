import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { requestNavigation, navigationItems, acknowledgeNavigation } from '../navigation.mjs'

test('导航必须有会话；过期、错版本、已结束的请求不能报成功', () => {
 assert.equal(requestNavigation({}), false)
 const item = {id:'approval',sessionId:'session',resolve(){throw new Error('navigation must not authorize')}}
 const state = {pending:new Map([[item.id,item]])}
 requestNavigation(item,100)
 assert.equal(navigationItems(state,101).length,1)
 assert.equal(item.viewed, undefined)
 assert.equal(acknowledgeNavigation(state,{id:item.id,revision:2,ok:true},102),false)
 assert.equal(acknowledgeNavigation(state,{id:item.id,revision:1,ok:false},102),true)
 assert.equal(item.navigation.status,'failed')
 assert.equal(item.viewed,false)
 requestNavigation(item,200)
 assert.equal(acknowledgeNavigation(state,{id:item.id,revision:2,ok:true},201),true)
 assert.equal(item.viewed,true)
 assert.equal(state.pending.size,1)
 requestNavigation(item,300)
 assert.equal(navigationItems(state,16000).length,0)
 assert.equal(item.navigation.status,'failed')
 state.pending.clear()
 assert.equal(acknowledgeNavigation(state,{id:item.id,revision:3,ok:true},301),false)
})

const client = fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8')
test('真实客户端入口只导航并确认，不触发授权；隐藏窗口不抢会话', async () => {
 for (const focused of [true,false]) {
  let definition,cleanup,opened=null,ack=null
  const sandbox = {document:{hasFocus:()=>focused},setTimeout:()=>1,clearTimeout(){},
   window:{__ModuleLoader__:{load(d){definition=d}}},
   fetch:async (url,options={}) => {
    if(options.method==='POST') {ack=JSON.parse(options.body); return {ok:true}}
    return {ok:true,json:async()=>({items:[{id:'approval',sessionId:'target',revision:1}]})}
   }}
  vm.runInNewContext(client,sandbox)
  assert.equal(definition.id,'dsh-pet-approval')
  const ctx={effect(fn){cleanup=fn()},uiWorkspace:{async openSession(id){opened=id}},sessions:{list:{getSnapshot:()=>({current:opened})}}}
  definition.factory().apply(ctx)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(opened,focused?'target':null)
  assert.equal(ack?.ok,focused?true:undefined)
  if(ack) assert.deepEqual(Object.keys(ack).sort(),['id','ok','revision'])
  cleanup()
 }
})

test('普通/高风险卡片各仅一个按钮，悬停保留完整请求，不把待导航当成功', () => {
 let definition
 const actions={attrs:{},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},innerHTML:''}
 const tip={textContent:'',getAttribute(){return null}}
 const card={classList:{toggle(){},remove(){}},querySelector(s){return s==='.dpa-tip'?tip:s==='.dpa-actions'?actions:null},querySelectorAll(){return []},title:''}
 const sandbox={console,document:{currentScript:{getAttribute(){return 'fixture'}},querySelector(){return null},getElementById(){return {}},head:{appendChild(){}}},setTimeout:()=>1,clearTimeout(){},window:{__ModuleLoader__:{load(d){definition=d}}}}
 let source=fs.readFileSync(new URL('../runtime/pet-approval.js',import.meta.url),'utf8')
 source=source.slice(0,source.lastIndexOf('  if (document.readyState'))+'globalThis.draw=function(item){card=globalThis.fixture;renderCard(item,0)};})()'
 sandbox.fixture=card
 vm.createContext(sandbox);vm.runInContext(source,sandbox)
 const reason='请求理由'.repeat(40)
 sandbox.draw({id:'one',risk:'medium',toolName:'tool',reason})
 assert.equal((actions.innerHTML.match(/<button /g)||[]).length,1)
 assert.ok(actions.innerHTML.includes('allowed-once'))
 assert.ok(actions.innerHTML.includes('>允许</button>'))
 assert.ok(card.title.includes(reason))
 sandbox.draw({id:'two',risk:'high',navigationStatus:'pending'})
 assert.equal((actions.innerHTML.match(/<button /g)||[]).length,1)
 assert.ok(actions.innerHTML.includes('data-outcome="view"'))
 assert.ok(!actions.innerHTML.includes('allowed-once'))
 assert.equal(tip.textContent,'正在打开…')
 sandbox.draw({id:'two',risk:'high',navigationStatus:'failed'})
 assert.equal(tip.textContent,'未能定位 · 请重试')
})
