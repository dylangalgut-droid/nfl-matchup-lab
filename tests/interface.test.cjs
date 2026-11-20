const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const docs = path.join(__dirname, '../docs');
const html = fs.readFileSync(path.join(docs,'index.html'),'utf8');
const app = fs.readFileSync(path.join(docs,'app.js'),'utf8');

// Exercise the normal app entry point and filter handlers with an in-memory DOM.
// Layout is checked separately at desktop and mobile sizes.
function element(textContent = '') {
  const classes = new Set(), handlers = {};
  return {
    textContent, value:'', innerHTML:'', dataset:{}, children:[],
    addEventListener(name,fn) {handlers[name]=fn;},
    dispatch(name, event={target:this}) {return handlers[name](event);},
    classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)},
    setAttribute() {}, scrollIntoView() {},
    replaceChildren(...options) {this.options=options;this.value=options[0]?.value ?? '';}
  };
}
function boot(data) {
  const ids = new Map([...html.matchAll(/\sid="([^"]+)"/g)].map(([,id]) => [id, element()]));
  const nav = ['defence','matchups','performance','bets'].map(page=>{
    const b = element(); b.dataset.page=page; b.children=[element(),element(page)]; return b;
  });
  const weeks=[element(),element()], days=[element(),element()];
  const query = {'.nav-link':nav,'.page':[],'.selected-cell':[],'.week-picker':weeks,'.day-picker':days};
  const document = {getElementById:id=>ids.get(id),querySelectorAll:s=>query[s] || []};
  const context = {window:{addEventListener(){},setInterval(){}}, document,location:{hash:''}, console,
    fetch:async(url)=>({ok:true,json:async()=>url === './data.json' ? data : JSON.parse(fs.readFileSync(path.join(docs,url),'utf8'))}), Option:class {constructor(text,value){this.text=text;this.value=value;}}};
  vm.runInNewContext(app,context);
  return {id:i=>ids.get(i),days,weeks};
}
const stats = [{id:'receiving_yards',label:'Receiving yards',positions:['WR']}];
function fixture() {
  const game = {id:'game-1',season:2026,week:11,away:'A',home:'B',kickoff:'2026-11-20T23:30:00Z',status:'scheduled'};
  const players=['Positive','Unflagged'].map((name,i)=>({id:name,name,team:'A',position:'WR',role:'wr',game:game.id,
    injury:i?'Questionable':null,flags:i?[]:[{stat:'receiving_yards',baseline:30,projected:35,delta:5,direction:'Favourable',explanation:'Receiver allowance and recent production.',limitations:'Small sample.'}]}));
  return {season:2026, updatedAt:'2026-11-19T20:00:00Z',teams:[{id:'A',name:'Away'},{id:'B',name:'Home'}],games:[game],
    model:{roles:[{id:'wr',label:'Wide receiver',position:'WR'}],stats,performance:[{stat:'receiving_yards',n:10,mae:12,baselineMae:13,rmse:14,baselineRmse:15,directionalN:8,directionalAccuracy:50}],
      weeks:{'2026-11':{players,cells:{wr:{receiving_yards:{B:{avg:58.5,league:40,diff:18.5,n:4,leagueN:100}}}}}}},coverage:[]};
}
test('heatmap drill-down includes all matching opponents at every allowance sign',async()=>{
  for (const [diff, text] of [[18.5,'+18.5'],[-3,'-3.0'],[0,'0.0']]) {
    const data=fixture();
    const cell=data.model.weeks['2026-11'].cells.wr.receiving_yards.B;
    cell.diff=diff;cell.avg=cell.league+diff;
    const ui=boot(data); await new Promise(resolve=>setImmediate(resolve));
    assert.match(ui.id('heatmap-table').innerHTML,/small-sample/);
    assert.ok(ui.id('heatmap-table').innerHTML.includes(text));
    const b=element();b.dataset={role:'wr',team:'B'};
    ui.id('heatmap-table').dispatch('click',{target:{closest:()=>b}});
    const detail=ui.id('heatmap-detail').innerHTML;
    for(const word of ['Positive','Unflagged','Questionable','Small sample','100 player-games']) assert.ok(detail.includes(word));
    assert.ok(ui.id('signal-list').innerHTML.includes('Positive'));
    assert.ok(!ui.id('signal-list').innerHTML.includes('Unflagged'));
    assert.ok(ui.id('performance-metrics').innerHTML.includes('50.0%'));
    assert.equal(ui.days[0].options[1].value,'2026-11-21');
    assert.match(ui.days[0].options[1].text,/Sat/);
  }
});

test('published fixture and week files feed heatmap, matchup scanner and performance views',async()=>{
  const snapshot = JSON.parse(fs.readFileSync(path.join(docs,'data.json'),'utf8'));
  assert.equal(snapshot.teams.length,32);
  assert.ok(snapshot.games.some(g=>g.boxVerified && g.status==='final'));
  const ui = boot(snapshot);
  await new Promise(resolve=>setImmediate(resolve));
  const realWeek = snapshot.model.weeks[ui.weeks[0].value];
  assert.equal(typeof realWeek,'object');
  assert.ok(realWeek.players.length);
  assert.ok(ui.id('signal-list').innerHTML.includes('signal-game'));
  assert.ok(ui.id('performance-metrics').innerHTML.includes('Player-games'));
  const available = realWeek.players.find(p=>p.position==='WR' && realWeek.cells.wr?.receiving_yards?.[p.opponent]);
  assert.ok(available);
  const b=element(); b.dataset={role:available.role,team:available.opponent};
  ui.id('heatmap-table').dispatch('click',{target:{closest:()=>b}});
  assert.ok(ui.id('heatmap-detail').innerHTML.includes(available.name.replace(/'/g,'&#39;')));
  assert.ok(ui.id('heatmap-detail').innerHTML.includes('League sample'));
  assert.ok(ui.id('coverage').innerHTML.includes('nflverse'));
  const final = snapshot.games.find(g=>g.status==='final' && g.boxVerified);
  ui.weeks[0].value=final.season+'-'+final.week; ui.weeks[0].dispatch('change');
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(ui.id('heat-slate').innerHTML.includes('Final'));
});
