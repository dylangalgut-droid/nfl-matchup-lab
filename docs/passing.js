(() => {
  const get = key => document.getElementById('pass-' + key);
  const depth = {behind:'Behind the line', short:'Short (0–9 yards)', intermediate:'Intermediate (10–19 yards)', deep:'Deep (20+ yards)', unknown:'Unknown depth'};
  const side = {left:'Left', middle:'Middle', right:'Right', unknown:'Unknown direction'};
  const concepts = {is_screen_pass:'Screen', is_play_action:'Play-action', is_rpo:'Run-pass option', other:'None of these designs'};
  let data, selected;
  function playerDetail(key, profiles, code, oppCode, defensive) {
    const section = get('players');
    section.replaceChildren();
    function add(tag, value) {
      const el = document.createElement(tag);
      el.textContent = value;
      section.append(el);
    }
    if (!key) { add('p', 'Select a throw type to see the players targeted on those throws.'); return; }
    if (defensive && !oppCode) {
      const game = data.games.filter(g => String(g.season) === get('season').value && g.status === 'scheduled' &&
        [g.home,g.away].includes(code) && Date.parse(g.kickoff) >= Date.parse(data.updatedAt)).sort((a,b)=>a.kickoff.localeCompare(b.kickoff))[0];
      if (game) oppCode = game.home === code ? game.away : game.home;
    }
    const off = defensive ? oppCode : code, def = defensive ? code : oppCode;
    add('h3', label(key) + (off ? ' · ' + off + ' receivers' : ' · Receivers'));
    if (!off) { add('p','Choose a comparison offence to see its receivers.'); return; }
    const defence = profiles.defence?.[def], league = sumLeague(profiles.defence || {});
    function ypt(record) {
      const v = record?.groups[key];
      return v && v[1] === v[2] && v[0] ? v[3]/v[0] : null;
    }
    const edge = difference(ypt(defence), ypt(league));
    const denom = profiles.offence?.[off]?.groups[key]?.[0];
    const seasonGames = new Set(data.games.filter(g=>String(g.season)===get('season').value && g.boxVerified).map(g=>g.id));
    const appearances = {};
    for (const row of data.stats) {
      if (row.team===off && seasonGames.has(row.game) && (row.targets>0 || row.carries>0 || row.attempts>0))
        appearances[row.player] = (appearances[row.player] || 0) + 1;
    }
    const members = new Map(data.players.map(p=>[p.id,p]));
    const entries = Object.entries(profiles.receivers?.[off] || {}).filter(([,v])=>v[key]>0)
      .sort((a,b)=>b[1][key]-a[1][key]);
    if (!entries.length) { add('p','No recorded player targets of this type for this team and season.'); return; }
    add('p',edge === null ? 'Ranked by observed targets. Choose a defence with coverage to see the matchup.' :
      def+' allows '+fmt(edge,false,true)+' yards per target versus the NFL on these throws ('+
      defence.groups[key][0]+' defensive targets). '+(Math.abs(edge)<.05?'Neutral matchup.':edge>0?'Positive exposure highlights receivers who could benefit.':'Negative exposure highlights receivers facing a tougher matchup.'));
    add('p','Yardage exposure equals this player’s targets of the selected type per game with a target, carry or pass attempt × the defensive difference per target. It describes this season’s matchup. The weekly model discounts small samples and accounts for other factors.');
    const wrap = document.createElement('div'); wrap.className='pass-scroll';
    const table = document.createElement('table'); wrap.append(table); section.append(wrap);
    table.createTHead().append(tableRow('th',['Player','Targets of this type','Share of team’s type','Yardage exposure / game','Current roster']));
    const body = table.createTBody();
    for (const [id,v] of entries) {
      const p = members.get(id);
      const tr = tableRow('td',[p?.name || id,v[key],fmt(ratio(v[key]*100,denom),true),fmt(edge!==null && appearances[id] ? edge*v[key]/appearances[id] : null,false,true),
        p?.activeRoster && p.team===off ? (p.injury || 'On roster') : 'Membership unconfirmed / former']);
      if (edge !== null && Math.abs(edge)>=.05) tr.cells[3].className=edge>0?'more':'less';
      if (v[key] === entries[0][1][key] && edge !== null && Math.abs(edge)>=.05) tr.cells[0].className=edge>0?'more':'less';
      body.append(tr);
    }
  }
  function choices(select, values, initial) {
    const previous = select.value;
    select.replaceChildren(...values.map(([id, name]) => new Option(name,id)));
    select.value = values.some(([id]) => id === previous) ? previous : initial;
  }
  function label(key) {
    const [group, a, b] = key.split('/');
    if (group === 'zone') return depth[a] + ' · ' + side[b];
    return ({depth,side,concept:concepts})[group][a];
  }
  function sumLeague(teams) {
    const league = {games:0,groups:{}};
    for (const team of Object.values(teams)) {
      league.games += team.games;
      for (const [key, values] of Object.entries(team.groups)) {
        const total = league.groups[key] ||= [0,0,0,0];
        values.forEach((v,i) => {total[i] += v;});
      }
    }
    return league;
  }
  const zero = [0,0,0,0];
  const ratio = (num, den) => den ? num / den : null;
  function yardage(team, key, unit) {
    if (!team) return null;
    const [,catches,measured,yards] = team.groups[key] || zero;
    if (catches !== measured) return null;
    return ratio(yards,unit === 'game' ? team.games : measured);
  }
  function share(team, key, denom) {
    return team ? ratio(100*(team.groups[key]?.[0] || 0), team.groups[denom]?.[0]) : null;
  }
  const difference = (a,b) => a === null || b === null ? null : a-b;
  const fmt = (v,pct=false,signed=false) => v === null ? '—' : (signed && v>=.05 ? '+' : '') + v.toFixed(1) + (pct ? '%' : '');
  function tableRow(tag, items) {
    const row = document.createElement('tr');
    for (const text of items) {
      const cell = document.createElement(tag);
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }
  function draw() {
    const mode = get('view').value, defensive = mode === 'defence';
    const group = get('group').value, unit = get('unit').value, code = get('team').value;
    const profiles = data.passProfiles?.[get('season').value] || {};
    const teams = profiles[mode] || {}, team = teams[code], league = sumLeague(teams);
    const oppCode = get('opp').value, opposite = profiles[defensive?'offence':'defence'] || {};
    const opponent = opposite[oppCode], compareLeague = sumLeague(opposite);
    const denom = group === 'concept' ? 'charted' : 'all';
    const table = get('table');
    table.replaceChildren();
    playerDetail(null, profiles, code, oppCode, defensive);
    get('unit-label').hidden = !defensive && !oppCode;
    if (!team?.groups[denom]?.[0]) {
      get('summary').textContent = 'No verified targets with this coverage for the selected team and season.';
      return;
    }
    const n = team.groups[denom][0], total = team.groups.all[0];
    get('summary').textContent = code + ' · ' + team.games + ' verified games · ' + (denom==='charted' ? n+' of '+total+' targets charted' : n+' targeted throws') + '. ' +
      (defensive ? 'Sorted by yards above or below the league average.' : 'Sorted by the share of throws aimed at each type.') +
      (group === 'concept' && unit === 'game' && (defensive || oppCode) ? ' Per-game yardage is unavailable for partially charted play designs.' : '');
    const measure = unit==='game'?'yd/game':'yd/catch';
    const headers = defensive ? ['Throw type','Catches','Targets',code+' '+measure,'NFL '+measure,'Difference'] :
      ['Throw type','Targets',code+' share','NFL share','Catches'];
    if (oppCode) headers.push(oppCode+(defensive?' target share':' allowed Δ '+measure));
    table.createTHead().append(tableRow('th',headers));
    const body = table.createTBody();
    function yards(record,key) {
      if (group==='concept' && unit==='game' && record?.groups.charted?.[0] !== record?.groups.all?.[0]) return null;
      return yardage(record,key,unit);
    }
    const rows = Object.keys(league.groups).filter(k=>k.startsWith(group+'/')).map(k=>{
      const [targets,catches] = team.groups[k] || zero;
      const avg = yards(team,k), nfl = yards(league,k), delta = difference(avg,nfl);
      const frequency = share(team,k,denom);
      const values = defensive ? [label(k),catches,targets,fmt(avg),fmt(nfl),fmt(delta,false,true)] :
        [label(k),targets,fmt(frequency,true),fmt(share(league,k,denom),true),catches];
      if (oppCode) values.push(defensive ? fmt(share(opponent,k,denom),true) :
        fmt(difference(yards(opponent,k),yards(compareLeague,k)),false,true));
      return {key:k,values,order:(defensive?delta:frequency) ?? -Infinity,delta};
    });
    rows.sort((a,b)=>b.order-a.order || a.values[0].localeCompare(b.values[0]));
    for (const row of rows) {
      const tr = tableRow('td',row.values);
      if (defensive && Math.abs(row.delta)>=.05) tr.cells[5].className=row.delta>0?'more':'less';
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = row.values[0];
      button.setAttribute('aria-pressed',String(selected===row.key));
      tr.cells[0].replaceChildren(button);
      tr.onclick = () => {
        selected = row.key;
        body.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
        playerDetail(selected, profiles, code, oppCode, defensive);
        get('players').scrollIntoView({block:'nearest'});
      };
      body.append(tr);
      if (selected === row.key) playerDetail(selected, profiles, code, oppCode, defensive);
    }
  }
  window.NFLPassing = {mount(snapshot) {
    data = snapshot;
    const years = Object.keys(data.passProfiles || {}).sort().reverse();
    const teams = data.teams.map(t=>[t.id,t.name]).sort((a,b)=>a[1].localeCompare(b[1]));
    choices(get('season'),years.map(y=>[y,y]),String(data.season));
    choices(get('team'),teams,teams[0][0]);
    choices(get('opp'),[['','None'],...teams],'');
    for (const id of ['season','team','opp','view','unit','group']) get(id).onchange=draw;
    draw();
  }};
})();
