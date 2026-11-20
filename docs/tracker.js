/* NFL Matchup Lab — private browser-local bet tracker. */
(function (root) {
  'use strict';

  const MARKETS = {
    passing_yards: 'Passing yards', passing_tds: 'Passing touchdowns',
    rushing_yards: 'Rushing yards', carries: 'Rushing attempts',
    receiving_yards: 'Receiving yards', receptions: 'Receptions',
    rush_rec_yards: 'Rushing + receiving yards', tds: 'Touchdowns scored (anytime TD)'
  };
  const OPERATORS = {gte: 'At least', over: 'Over', under: 'Under'};
  const STATUS = {won: 'Won', lost: 'Lost', void: 'Void', pending: 'Pending', review: 'Needs review'};
  const STORAGE = 'nfl-matchup-lab.bets.v1';
  const finite = Number.isFinite;
  const signed = n => (n > 0 ? '+' : '') + n.toLocaleString('en-AU', {maximumFractionDigits: 3});
  const uid = () => crypto.randomUUID();
  const dateFmt = new Intl.DateTimeFormat('en-CA', {timeZone: 'Australia/Melbourne', year:'numeric',month:'2-digit',day:'2-digit'});
  const localDay = date => dateFmt.format(new Date(date));
  const timeFmt = new Intl.DateTimeFormat('en-AU', {timeZone:'Australia/Melbourne', weekday:'short', month:'short', day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const opt = (v,t,s) => '<option value="'+esc(v)+'"'+(String(v)===String(s)?' selected':'')+'>'+esc(t)+'</option>';
  const dateOK = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && finite(Date.parse(s+'T12:00:00Z')) && new Date(s+'T12:00:00Z').toISOString().slice(0,10) === s;
  const idOK = x => typeof x === 'string' && x.length > 0 && x.length<=200;
  const short = (v,k) => typeof v==='string' && v.length<=k;
  function newDraft() {
    return {description:'',type:'single',odds:'',stake:'',date:localDay(Date.now()),legs:[]};
  }
  function indexData(s) {
    const games=new Map(), players=new Map(), byGame=new Map(), byDay=new Map();
    for(const g of s?.games || []) {
      games.set(g.id,g);
      const day=g.kickoff && finite(Date.parse(g.kickoff)) ? localDay(g.kickoff) : 'TBD';
      if (!byDay.has(day)) byDay.set(day,[]);
      byDay.get(day).push(g);
    }
    for(const p of s?.players || []) players.set(p.id,p);
    for(const row of s?.stats || []) {
      if (!byGame.has(row.game)) byGame.set(row.game,new Map());
      byGame.get(row.game).set(row.player,row);
    }
    return {games,players,byGame,byDay};
  }
  function verifyLeg(l, ix) {
    const g = ix.games.get(l.game);
    if (!g) {
      if (l.proof && finite(l.proof.value)) return judge(l, l.proof.value, 'Saved final box score');
      return {status:'pending',note:'Game missing from this snapshot'};
    }
    if (g.status!=='final') return {status:'pending',note:g.status==='postponed'?'Postponed · settlement pending':'Waiting for a verified final'};
    if (!g.boxVerified) return {status:'pending',note:'Final result available · box score unverified'};
    const row = ix.byGame.get(l.game)?.get(l.player);
    if (!row) return {status:'review',note:'No box-score row · check participation and DNP rules'};
    // A zero stat in an unused player's row does not establish participation.
    const appeared = row.participated===true || ['attempts','carries','targets','receptions','tds'].some(k=>finite(row[k]) && row[k]>0);
    if (!appeared) return {status:'review',note:'Participation unconfirmed · check DNP rules'};
    let actual = row[l.stat];
    if(l.stat==='rush_rec_yards') actual=finite(row.rushing_yards)&&finite(row.receiving_yards)?row.rushing_yards+row.receiving_yards:null;
    if (!finite(actual)) return {status:'review',note:'Official statistic unavailable'};
    return {...judge(l,actual,'Final box score'),verified:true};
  }
  function judge(l,value,source) {
    if(l.op!=='gte' && value===l.target) return {status:'review',value,note:source+' · push, confirm bookmaker settlement'};
    const won=l.op==='gte'?value>=l.target:l.op==='over'?value>l.target:value<l.target;
    return {status:won?'won':'lost',value,note:source};
  }
  function evaluate(b,ix) {
    const legs=b.legs.map(l=>verifyLeg(l,ix));
    let status;
    if(b.manual) status=b.manual.status;
    else if(!legs.length || legs.some(x=>x.status==='review')) status='review';
    else if(legs.some(x=>x.status==='pending')) status='pending';
    else status=legs.every(x=>x.status==='won')?'won':'lost';
    const gross=b.manual?.totalReturn;
    const net=finite(gross)?gross-b.stake:status==='won'?b.stake*(b.odds-1):status==='lost'?-b.stake:0;
    return {status,net,legs};
  }
  function totals(bets,ix) {
    const out={won:0,lost:0,void:0,pending:0,review:0,net:0};
    for(const b of bets) {
      const r=evaluate(b,ix);
      out[r.status]++;
      if(r.status==='review') out.pending++;
      out.net+=r.net;
    }
    return out;
  }
  function validBet(b) {
    return b && idOK(b.id) && short(b.description,500) && b.description.trim() && dateOK(b.date) &&
      ['single','multi'].includes(b.type) && finite(b.odds) && b.odds>1 && finite(b.stake) && b.stake>0 && finite(b.stake*b.odds) &&
      Array.isArray(b.legs) && (b.legs.length<=1 || b.type==='multi') && b.legs.every(l=>l && idOK(l.game) && idOK(l.player) &&
        Object.hasOwn(MARKETS,l.stat) && Object.hasOwn(OPERATORS,l.op) && finite(l.target) && (!l.proof||finite(l.proof.value)) &&
        (!l.name||short(l.name,250)) && (!l.match||short(l.match,250))) &&
      (!b.manual || (['won','lost','void','pending'].includes(b.manual.status) && (b.manual.totalReturn==null ||
        (b.manual.status!=='pending' && finite(b.manual.totalReturn) && b.manual.totalReturn>=0))));
  }
  function parseLedger(obj) {
    if (!obj || obj.format!=='nfl-matchup-lab' || obj.version!==1 || !Array.isArray(obj.bets) || !Array.isArray(obj.removed))
      throw Error('Unrecognised NFL Matchup Lab backup.');
    const all=obj.bets.concat(obj.removed);
    if(!all.every(validBet) || new Set(all.map(b=>b.id)).size!==all.length)
      throw Error('Backup contains invalid bets or duplicate IDs.');
    return {format:'nfl-matchup-lab',version:1,bets:obj.bets,removed:obj.removed};
  }
  function mergeBackup(existing,backup) {
    const incoming=parseLedger(backup), seen=new Set(existing.bets.concat(existing.removed).map(b=>b.id));
    for(const list of ['bets','removed']) for(const b of incoming[list]) if(!seen.has(b.id)) {
      existing[list].push(b); seen.add(b.id);
    }
    return existing;
  }
  function emptyLedger() { return {format:'nfl-matchup-lab',version:1,bets:[],removed:[]}; }
  function saveProofs(ledger,ix) {
    let changed=false;
    for(const b of ledger.bets) for(const leg of b.legs) {
      const result=verifyLeg(leg,ix);
      if(result.verified && result.value!==leg.proof?.value) {leg.proof={value:result.value}; changed=true;}
      // Invalidate stale evidence when a newer snapshot explicitly disputes it.
      else if(ix.games.has(leg.game) && !result.verified && leg.proof) {delete leg.proof; changed=true;}
    }
    return changed;
  }
  const api={indexData,verifyLeg,evaluate,totals,validBet,mergeBackup,emptyLedger,saveProofs,localDay};
  if(typeof module==='object' && module.exports) module.exports=api;
  if(!root.document) return;
  let container, ix=indexData(null), draft, historyDay=localDay(Date.now()), ledger=emptyLedger(), blocked=false;
  let editId='', showRemoved=false, loaded=false;
  const draftKey=STORAGE+'.draft';
  const readLedger=()=>{const raw=localStorage.getItem(STORAGE);return raw?parseLedger(JSON.parse(raw)):emptyLedger();};
  function notify(msg) {const n=container?.querySelector('[data-notice]');if(n)n.textContent=msg;}
  function transact(fn) {
    try {
      if(blocked) throw Error('Local storage is unavailable or damaged. Export your stored data before making changes.');
      const next=readLedger(); fn(next); localStorage.setItem(STORAGE,JSON.stringify(next)); ledger=next;return true;
    } catch(e) {notify('Could not save. '+e.message);return false;}
  }
  function persistDraft() {
    if(blocked)return;
    try {localStorage.setItem(draftKey,JSON.stringify(draft));} catch {notify('Browser storage is full or unavailable. Your draft is currently held in this tab.');}
  }
  function newLeg() {
    const date= ix.byDay.has(draft.date)?draft.date:'';
    return {date,game:'',player:'',stat:'receiving_yards',op:'gte',target:''};
  }
  function candidates(gameId) {
    const g=ix.games.get(gameId);
    if(!g)return [];
    const gameRows=ix.byGame.get(gameId)||new Map(), picks=new Map();
    for(const [id,r] of gameRows) {const p=ix.players.get(id);picks.set(id,{id,name:p?.name||id,position:r.position,team:r.team});}
    // Historic game participants stay selectable after roster moves. Include the current
    // roster as a fallback for late entries, inactive players and missing box rows.
    for(const p of ix.players.values()) if([g.home,g.away].includes(p.team) && p.activeRoster && !picks.has(p.id))picks.set(p.id,p);
    return [...picks.values()].sort((a,b)=>a.team.localeCompare(b.team)||a.name.localeCompare(b.name));
  }
  function fixture(g) {return g.away+' @ '+g.home+' · '+(g.kickoff?timeFmt.format(new Date(g.kickoff)):'Kickoff TBD');}
  function legForm(l,i) {
    const allDays=Array.from(ix.byDay.keys()).sort().reverse();
    const dayOptions=allDays.map(d=>opt(d,d,l.date)).join('');
    let games=l.date?(ix.byDay.get(l.date)||[]):Array.from(ix.games.values());
    games=[...games].sort((a,b)=>(b.kickoff||'').localeCompare(a.kickoff||''));
    const gameOptions=games.map(g=>opt(g.id,fixture(g),l.game)).join('');
    const players=candidates(l.game);
    let playerOptions=players.map(p=>opt(p.id,p.name+' · '+p.team+' '+p.position,l.player)).join('');
    if(l.player && !players.some(p=>p.id===l.player))playerOptions+=opt(l.player,l.name||l.player,l.player);
    const marketOptions=Object.entries(MARKETS).map(([v,t])=>opt(v,t,l.stat)).join('');
    const operatorOptions=Object.entries(OPERATORS).map(([v,t])=>opt(v,t,l.op)).join('');
    return `<fieldset class="bt-leg" data-index="${i}"><legend>Leg ${i+1}</legend>
      <div class="bt-grid">
      <label>Game day · Melbourne<select data-leg="date">${opt('','All game days',l.date)}${l.date&&!allDays.includes(l.date)?opt(l.date,l.date,l.date):''}${dayOptions}</select></label>
      <label class="bt-wide">Game<select data-leg="game" required>${opt('','Select game',l.game)}${l.game&&!games.some(g=>g.id===l.game)?opt(l.game,l.match||l.game,l.game):''}${gameOptions}</select></label>
      <label>Player<select data-leg="player" required>${opt('','Select player',l.player)}${playerOptions}</select></label>
      <label>Statistic<select data-leg="stat">${marketOptions}</select></label>
      <label>Condition<select data-leg="op">${operatorOptions}</select></label>
      <label>Target<input type="number" step="any" required data-leg="target" value="${esc(l.target)}"></label>
      </div><button type="button" class="bt-text" data-act="remove-leg" data-n="${i}">Remove leg ${i+1}</button></fieldset>`;
  }
  function renderDraft() {
    const form=container.querySelector('[data-form]');
    form.innerHTML=`<div class="bt-grid"><label class="bt-wide">Bet description<input data-field="description" required maxlength="500" placeholder="Describe your bet" value="${esc(draft.description)}"></label>
      <label>Bet type<select data-field="type">${opt('single','Single',draft.type)}${opt('multi','Multi',draft.type)}</select></label>
      <label>Bet date · Melbourne<input type="date" data-field="date" required value="${esc(draft.date)}"></label>
      <label>Decimal odds<input type="number" data-field="odds" min="1" step="any" required placeholder="1.90" value="${esc(draft.odds)}"></label>
      <label>Stake (units)<input type="number" data-field="stake" min="0" step="any" required placeholder="1.00" value="${esc(draft.stake)}"></label></div>
      <div data-legs>${draft.legs.map(legForm).join('')}</div><div class="bt-actions"><button type="button" data-act="add-leg">Add leg</button><button type="submit" class="bt-primary">Save bet</button></div>`;
  }
  function betCard(b) {
    const r=evaluate(b,ix);
    const li=b.legs.map((l,i)=>{
      const g=ix.games.get(l.game),res=r.legs[i];
      const gameLabel=g?fixture(g):(l.match||l.game);
      return `<li><strong>${esc(l.name||ix.players.get(l.player)?.name||l.player)}</strong> · ${esc(MARKETS[l.stat])} · ${esc(OPERATORS[l.op])} ${esc(l.target)}
      <small>${esc(gameLabel)} · ${esc(STATUS[res.status])} · ${esc(res.note)}${finite(res.value)?' · Actual '+esc(res.value):''}</small></li>`;
    }).join('');
    const manual=b.manual?.totalReturn!=null?' · Total returned '+signed(b.manual.totalReturn)+'u':'';
    return `<article class="bt-record"><div class="bt-record-head"><div><small>${esc(b.date)} · ${esc(b.type)} · ${b.legs.length} structured leg${b.legs.length===1?'':'s'}</small><h3>${esc(b.description)}</h3></div><span class="bt-status s-${r.status}">${STATUS[r.status]}</span></div>
      <p>${signed(b.stake)}u at ${b.odds} · Net <strong>${signed(r.net)}u</strong>${b.manual?' · Manual correction':''}${esc(manual)}</p><ul>${li}</ul>
      <div class="bt-actions"><button type="button" data-act="correct" data-id="${esc(b.id)}">Review / correct</button><button type="button" class="bt-text" data-act="remove" data-id="${esc(b.id)}">Remove</button></div>
      ${editId===b.id?manualForm(b,r):''}</article>`;
  }
  function manualForm(b,r) {
    const c=b.manual?.status || (['won','lost','void'].includes(r.status)?r.status:'pending');
    return `<form class="bt-correction" data-correction="${esc(b.id)}"><p>Use the bookmaker’s final settlement for pushes, void legs, cash-outs or repriced multis.</p>
      <div class="bt-grid"><label>Bet outcome<select name="status">${['pending','won','lost','void'].map(v=>opt(v,STATUS[v],c)).join('')}</select></label>
      <label>Total returned (units, includes stake)<input name="gross" type="number" step="any" min="0" placeholder="Optional" value="${esc(b.manual?.totalReturn??'')}"></label></div>
      <div class="bt-actions"><button class="bt-primary">Save correction</button><button type="button" data-act="reset-manual" data-id="${esc(b.id)}">Use automatic settlement</button><button type="button" data-act="close-correction">Cancel</button></div></form>`;
  }
  function renderHistory() {
    const all=totals(ledger.bets,ix), daily=totals(ledger.bets.filter(b=>b.date===historyDay),ix);
    const box=container.querySelector('[data-summary]');
    box.innerHTML=`<div><small>ALL-TIME NET</small><strong>${signed(all.net)}u</strong></div><div><small>DAILY NET · BET DATE</small><strong>${signed(daily.net)}u</strong><input type="date" aria-label="Daily net date" data-history-day value="${esc(historyDay)}"></div>
      <div class="bt-record-summary"><small>TOTAL TIP RECORD</small><span><b>${all.won}</b> wins · <b>${all.lost}</b> losses · <b>${all.void}</b> voids · <b>${all.pending}</b> pending</span>
      ${all.review?'<small>'+all.review+' pending bookmaker review</small>':''}</div>`;
    container.querySelector('[data-log]').innerHTML=[...ledger.bets].sort((a,b)=>b.date.localeCompare(a.date)).map(betCard).join('') || '<p class="bt-muted">Your saved bets will appear here.</p>';
    container.querySelector('[data-bin]').innerHTML=`<button type="button" data-act="toggle-bin" aria-expanded="${showRemoved}">Removed bets (${ledger.removed.length})</button>
      ${showRemoved?ledger.removed.map(b=>`<div class="bt-bin-item">${esc(b.date)} · ${esc(b.description)} <button type="button" data-act="restore" data-id="${esc(b.id)}">Restore</button></div>`).join(''):''}`;
  }
  function renderShell() {
    container.classList.add('nfl-tracker');
    container.innerHTML=`<div data-summary class="bt-summary"></div><section class="bt-panel"><h2>Log a bet</h2><p class="bt-muted">Include player legs for automatic settlement. Games remain selectable after kickoff.</p><form data-form></form></section>
      <div role="status" aria-live="polite" data-notice></div>
      <section class="bt-panel"><div class="bt-section-head"><h2>Bet history</h2><div class="bt-actions"><button type="button" data-act="export">Export backup</button><button type="button" data-act="import">Import backup</button><input type="file" accept=".json,application/json" hidden data-import></div></div>
      <p class="bt-muted">Private to this browser and site address. Export a backup before clearing your data or switching devices. Import adds missing bets and preserves existing records.</p><div data-log></div><div data-bin></div></section>`;
    renderDraft();renderHistory();
  }
  function onField(e) {
    const t=e.target;
    if(t.hasAttribute('data-field')) {
      const key=t.dataset.field;
      if(key==='type' && t.value==='single' && draft.legs.length>1) {
        t.value='multi';notify('Multiple legs are recorded as one multi.');
      }
      draft[key]=t.value;persistDraft();
    }
    if(t.hasAttribute('data-leg')) {
      const n=Number(t.closest('fieldset').dataset.index),l=draft.legs[n],key=t.dataset.leg;
      if(!l)return;
      if(key==='date' && t.value!==l.date) {
        const current=ix.games.get(l.game);
        if(current && t.value && !(ix.byDay.get(t.value)||[]).some(g=>g.id===l.game)) {l.game='';l.player='';l.name='';l.match='';}
      }
      if(key==='game' && t.value!==l.game) {l.player='';l.name='';l.match=ix.games.has(t.value)?fixture(ix.games.get(t.value)):'';}
      l[key]=t.value;
      if(key==='player')l.name=ix.players.get(t.value)?.name||t.value;
      if(key==='stat' && t.value==='tds') {l.op='gte';l.target='1';}
      persistDraft();
      if(['date','game','stat'].includes(key)) renderDraft();
    }
    if(t.hasAttribute('data-history-day') && dateOK(t.value)) {historyDay=t.value;renderHistory();}
  }
  function saveBet() {
    const b={...draft,id:uid(),description:draft.description.trim(),odds:Number(draft.odds),stake:Number(draft.stake),legs:[]};
    for(const l of draft.legs) {
      if(l.target==='') {notify('Enter a target on each leg.');return;}
      b.legs.push({game:l.game,player:l.player,name:l.name||ix.players.get(l.player)?.name||l.player,match:l.match,stat:l.stat,op:l.op,target:Number(l.target)});
    }
    if(!validBet(b)){notify('Enter a description, valid date, positive stake and odds above 1.00. Complete every added leg.');return;}
    if(!transact(s=>{s.bets.unshift(b);saveProofs(s,ix);}))return;
    draft=newDraft();persistDraft();renderDraft();renderHistory();notify('Bet saved in this browser.');
  }
  function onSubmit(e) {
    e.preventDefault();
    if(e.target.hasAttribute('data-form')) return saveBet();
    const id=e.target.dataset.correction;if(!id)return;
    const data=new FormData(e.target),status=data.get('status'),v=data.get('gross');
    const totalReturn=v===''?null:Number(v);
    if(totalReturn!==null && (!finite(totalReturn)||totalReturn<0 || status==='pending')) {notify('Select a settled outcome when entering a total return.');return;}
    if(transact(s=>{const b=s.bets.find(x=>x.id===id);if(b)b.manual={status,totalReturn};})) {
      editId='';renderHistory();notify('Bookmaker correction saved.');
    }
  }
  function downloadBackup() {
    try {
      const raw=localStorage.getItem(STORAGE) || JSON.stringify(ledger);
      const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='nfl-matchup-lab-bets-'+localDay(Date.now())+'.json';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);notify('Backup exported. Keep this private file somewhere safe.');
    }catch(e){notify(e.message);}
  }
  async function onImport(e) {
    const input=e.target;if(!input.hasAttribute('data-import'))return;
    try {
      const file=input.files[0];if(!file)return;
      const inputLedger=parseLedger(JSON.parse(await file.text()));
      if(transact(s=>mergeBackup(s,inputLedger))){renderHistory();notify('Backup merged. Existing bet IDs were preserved.');}
    }catch(err){notify('Import failed. '+err.message);}
    finally{input.value='';}
  }
  function onClick(e) {
    const button=e.target.closest('[data-act]');if(!button)return;
    const action=button.dataset.act,id=button.dataset.id;
    if(action==='add-leg') {draft.legs.push(newLeg());if(draft.legs.length>=2)draft.type='multi';persistDraft();renderDraft();container.querySelector('[data-index="'+(draft.legs.length-1)+'"] select')?.focus();return;}
    if(action==='remove-leg') {draft.legs.splice(Number(button.dataset.n),1);persistDraft();renderDraft();return;}
    if(action==='export')return downloadBackup();
    if(action==='import')return container.querySelector('[data-import]').click();
    if(action==='toggle-bin')showRemoved=!showRemoved;
    if(action==='correct')editId=id;
    if(action==='close-correction')editId='';
    if(action==='reset-manual') {if(!transact(s=>{const b=s.bets.find(x=>x.id===id);if(b)delete b.manual;}))return;editId='';}
    if(action==='remove'||action==='restore') {
      const from=action==='remove'?'bets':'removed',to=action==='remove'?'removed':'bets';
      if(!transact(s=>{const i=s[from].findIndex(b=>b.id===id);if(i>=0)s[to].unshift(s[from].splice(i,1)[0]);}))return;
      notify(action==='remove'?'Bet moved to Removed bets.':'Bet restored.');
    }
    renderHistory();
  }
  function mount(el,snapshot) {
    if(!el)return;
    ix=indexData(snapshot);
    if(container!==el || !loaded) {
      container=el;let msg='';
      try {ledger=readLedger();blocked=false;}catch(e){blocked=true;msg='Local storage is unavailable or damaged. Your existing data has been preserved. '+e.message;}
      draft=newDraft();
      try {
        const raw=JSON.parse(localStorage.getItem(draftKey));
        if(raw && Array.isArray(raw.legs)&&typeof raw.description==='string' && dateOK(raw.date))draft=raw;
      }catch {/* A damaged draft must not prevent access to the saved ledger. */}
      renderShell();if(msg)notify(msg);
      el.addEventListener('input',e=>{if(e.target.tagName==='INPUT' && e.target.type!=='file')onField(e);});
      el.addEventListener('change',e=>{if(e.target.tagName==='SELECT')onField(e);onImport(e);});
      el.addEventListener('submit',onSubmit);el.addEventListener('click',onClick);
      if(!loaded)root.addEventListener('storage',e=>{
        if(e.key===STORAGE){try{ledger=readLedger();renderHistory();}catch(err){notify(err.message);}}
      });
      loaded=true;
    } else {
      // Update option lists without replacing the form, moving focus, or discarding
      // a typed line. Existing selections are always retained, including retired IDs.
      for(const fs of el.querySelectorAll('fieldset[data-index]')){
        const n=Number(fs.dataset.index), tmp=document.createElement('template');
        tmp.innerHTML=legForm(draft.legs[n],n);
        for(const key of ['date','game','player']){
          const sel=fs.querySelector('[data-leg="'+key+'"]');
          const replacement=tmp.content.querySelector('[data-leg="'+key+'"]');
          if(sel.innerHTML!==replacement.innerHTML)sel.innerHTML=replacement.innerHTML;
        }
      }
    }
    if(!blocked && snapshot && ledger.bets.length) {
      try {const current=readLedger();if(saveProofs(current,ix))localStorage.setItem(STORAGE,JSON.stringify(current));ledger=current;}
      catch(e){notify('Unable to cache final results. '+e.message);}
    }
    // Preserve an open correction form on background data refresh.
    if(!editId)renderHistory();
  }
  root.NFLTracker={mount};
})(typeof window==='object'?window:globalThis);
