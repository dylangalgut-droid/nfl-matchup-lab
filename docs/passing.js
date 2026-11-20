(() => {
  const get = key => document.getElementById('pass-' + key);
  const depth = {behind:'Behind the line', short:'Short (0–9 yards)', intermediate:'Intermediate (10–19 yards)', deep:'Deep (20+ yards)', unknown:'Unknown depth'};
  const side = {left:'Left', middle:'Middle', right:'Right', unknown:'Unknown direction'};
  const concepts = {is_screen_pass:'Screen', is_play_action:'Play-action', is_rpo:'Run-pass option', other:'None of these designs'};
  let data;
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
      return {values,order:(defensive?delta:frequency) ?? -Infinity,delta};
    });
    rows.sort((a,b)=>b.order-a.order || a.values[0].localeCompare(b.values[0]));
    for (const row of rows) {
      const tr = tableRow('td',row.values);
      if (defensive && Math.abs(row.delta)>=.05) tr.cells[5].className=row.delta>0?'more':'less';
      body.append(tr);
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
