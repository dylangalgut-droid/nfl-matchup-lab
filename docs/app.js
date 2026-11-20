'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
  const nfmt = (value, decimals = 1) => Number.isFinite(value)
    ? value.toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—';
  function signed(value, decimals = 1) {
    if (!Number.isFinite(value)) return '—';
    const rounded = Number(value.toFixed(decimals)) || 0;
    return (rounded > 0 ? '+' : '') + nfmt(rounded, decimals);
  }
  const precision = stat => ['passing_tds','tds'].includes(stat) ? 2 : 1;
  const zone = 'Australia/Melbourne';
  const dateFormat = (locale, options) => new Intl.DateTimeFormat(locale, {timeZone: zone, ...options});
  const dayKey = dateFormat('en-CA', {year:'numeric',month:'2-digit',day:'2-digit'});
  const dayLabel = dateFormat('en-AU', {weekday:'short',day:'numeric',month:'short'});
  const fullDay = dateFormat('en-AU', {day:'numeric',month:'short',year:'numeric'});
  const timeLabel = dateFormat('en-AU', {weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  function formatDate(value, formatter, fallback = 'Kickoff TBA') {
    const time = value ? new Date(value) : null;
    return time && Number.isFinite(time.valueOf()) ? formatter.format(time) : fallback;
  }
  function options(select, entries, value) {
    select.replaceChildren(...entries.map(([id, name]) => new Option(name, id)));
    if (entries.some(([id]) => id === value)) select.value = value;
  }
  let snapshot = null, model, weeks, gamesByWeek, teamsById;
  let state = {week:'', day:'', stat:'receiving_yards', position:'', team:'', role:'', game:'', direction:'', signalStat:''};
  const key = (g) => g.season + '-' + g.week;
  const blankWeek = {cells:{},players:[]};
  const weekRequests = new Map();
  const getWeek = () => typeof model.weeks[state.week] === 'object' ? model.weeks[state.week] : blankWeek;
  function completeSeason(season) {
    return snapshot.games.filter(g => g.season === season && g.stage === 'REG').length === 272;
  }
  const weekGames = () => gamesByWeek.get(state.week) || [];
  const gameDay = (game) => formatDate(game.kickoff, dayKey, 'tba');
  const dayGames = () => weekGames().filter(g => !state.day || gameDay(g) === state.day);
  const statBy = (id) => model.stats.find(s => s.id === id);
  const roleBy = (id) => model.roles.find(r => r.id === id);
  const teamName = (id) => teamsById.get(id)?.name || id;
  const tag = (g) => ({final:'Final',scheduled:'Scheduled',postponed:'Postponed',in_progress:'In progress',unconfirmed:'Status unconfirmed'}[g.status] || 'Status unknown');
  const metric = (label, value, sub = '') => '<div class="metric-item"><div class="metric-title">' + escape(label) + '</div><div class="metric-value">' + escape(value) + ' <span>' + escape(sub) + '</span></div></div>';
  const empty = (copy) => '<p class="empty-view">' + escape(copy) + '</p>';
  function pageFromHash() {
    const hash = location.hash.slice(1);
    return ['defence','matchups','passing','performance','bets'].includes(hash) ? hash : 'defence';
  }
  function navigate() {
    const page = pageFromHash();
    all('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
    for (const button of all('.nav-link')) {
      const name = button.children[1].textContent;
      const active = button.dataset.page === page;
      button.classList.toggle('active', active);
      button.setAttribute('aria-label', name);
      button.setAttribute('aria-current', active ? 'page' : 'false');
      button.title = name;
      if (active) $('crumb-page').textContent = name;
    }
  }
  function weekName(week) {
    const [season, number] = week.split('-');
    const playoff = {19:'Wild card',20:'Divisional',21:'Conference championships',22:'Super Bowl'};
    return season + ' · ' + (playoff[number] || 'Week ' + number);
  }
  function controls() {
    const entries = weeks.map(w => [w, weekName(w)]);
    for (const s of all('.week-picker')) options(s, entries, state.week);
    const days = new Map([['','All game days']]);
    for (const g of weekGames()) days.set(gameDay(g),formatDate(g.kickoff, dayLabel));
    if (!days.has(state.day)) state.day = '';
    for (const s of all('.day-picker')) options(s,[...days],state.day);
    const stats = model.stats.map(s => [s.id,s.label]);
    options($('heat-stat'), stats, state.stat);
    options($('signal-stat'), [['','All statistics'],...stats], state.signalStat);
    const fixtures = dayGames().map(g => [g.id, g.away + ' at ' + g.home + ' · ' + formatDate(g.kickoff,dayLabel)]);
    if (!fixtures.some(([id]) => state.game === id)) state.game = '';
    options($('game-picker'), [['','All fixtures'],...fixtures], state.game);
  }
  function scale(stat) {
    return ({passing_yards:35, passing_tds:.5, rushing_yards:15, carries:4, receiving_yards:18, receptions:1.5, rush_rec_yards:22, tds:.28})[stat] || 10;
  }
  function cellColour(diff) {
    if (!Number.isFinite(diff)) return '#152032';
    const intensity = Math.min(1, Math.abs(diff) / scale(state.stat));
    if (intensity < .07) return '#203043';
    const from = [31,45,61], to = diff > 0 ? [29,116,92] : [145,61,77];
    return 'rgb(' + from.map((v,i) => Math.round(v + (to[i]-v) * Math.sqrt(intensity))).join(',') + ')';
  }
  function renderHeat() {
    const wk = getWeek(), stat = statBy(state.stat);
    const games = dayGames(), verified = weekGames().filter(g => g.boxVerified).length;
    $('heat-metrics').innerHTML = metric('DEFENCES',teamsById.size,'NFL') + metric('SELECTED WEEK',state.week.split('-')[1],state.week.split('-')[0]) +
      metric('FIXTURES IN VIEW',games.length,'games') + metric('VERIFIED BOX SCORES',verified,'this week');
    const compatible = model.roles.filter(r => !stat.positions || stat.positions.includes(r.position));
    const roles = compatible.filter(r => !state.position || r.position === state.position);
    $('heat-intro').textContent = (state.stat === 'passing_tds' || state.stat === 'tds' ? 'Touchdowns are a lower-confidence, high-variance view. ' : '') +
      'Each cell is the defensive average minus the league role average. Select any cell to see its opponents.' + (wk.asOf ? ' Week cutoff: ' + formatDate(wk.asOf,timeLabel) + '.' : '');
    const teams = snapshot.teams;
    $('heatmap-table').innerHTML = '<thead><tr><th scope="col">Offensive role</th>' + teams.map(t => '<th scope="col" class="heatmap-team" title="' + escape(t.name) + '">' + escape(t.id) + '</th>').join('') + '</tr></thead><tbody>' +
      roles.map(r => '<tr><th scope="row"><span class="heatmap-pos">' + escape(r.position) + '</span> ' + escape(r.label) + '</th>' + teams.map(t => {
        const c = wk.cells?.[r.id]?.[state.stat]?.[t.id];
        const small = (c?.n > 0 && c.n < 8), chosen = t.id === state.team && r.id === state.role;
        const caption = signed(c?.diff,precision(state.stat));
        return '<td><button class="heatmap-cell' + (small?' small-sample':'') + (chosen?' selected-cell':'') + '" style="background:' + cellColour(c?.diff) +
          '" data-role="' + escape(r.id) + '" data-team="' + escape(t.id) + '" aria-pressed="' + chosen + '" aria-label="' +
          escape(t.name + ', ' + r.label + ', ' + stat.label + ', ' + caption + ' from league average, sample ' + (c?.n || 0)) + '">' + caption + (small?'<small>·</small>':'') + '</button></td>';
      }).join('') + '</tr>').join('') + '</tbody>';
    if (!roles.some(r => r.id === state.role)) state.role = '';
    showDetail(roles.length === 0 ? 'This statistic has no supported roles for that position. Choose another position or statistic.' : '');
    $('heat-slate').innerHTML = games.length ? '<ul class="fixture-list">' + games.map(g => '<li><strong>' + escape(g.away + ' at ' + g.home) + '</strong><span>' +
      escape(formatDate(g.kickoff,timeLabel)) + ' · ' + escape(tag(g)) + (g.venue ? ' · ' + escape(g.venue) : '') + '</span></li>').join('') + '</ul>' : empty('No fixtures are listed for this selection.');
  }
  function showDetail(message = '') {
    const el = $('heatmap-detail');
    if (!state.role || !state.team) {
      el.textContent = message || 'Select a cell to inspect its averages and opposing players.';
      return;
    }
    const wk = getWeek(), team = state.team, role = roleBy(state.role), c = wk.cells?.[role.id]?.[state.stat]?.[team];
    const gameMatches = g => g.home === team || g.away === team;
    const fixtures = dayGames().filter(gameMatches);
    const precise = v => nfmt(v, 2);
    const number = Number.isFinite(c?.diff)
      ? precise(c.avg) + ' allowed − ' + precise(c.league) + ' league average ≈ <b>' + (c.diff > 0 ? '+' : '') + precise(c.diff) + '</b> ' + escape(statBy(state.stat).label.toLowerCase()) + ' per qualifying player-game.'
      : 'No comparable role average is available.';
    let html = '<h3>' + escape(teamName(team) + ' · ' + role.label) + '</h3>' + number +
      ' <span class="subtle">Defensive sample: ' + nfmt(c?.n || 0,0) + ' player-games. League sample: ' + nfmt(c?.leagueN,0) + ' player-games.' + (c?.n > 0 && c.n < 8?' Small sample.':'') + '</span>';
    if (!fixtures.length) {
      const weekFixture = weekGames().find(gameMatches);
      const noGame = weekFixture ? 'No game on this Melbourne day. The week’s fixture is ' + weekFixture.away + ' at ' + weekFixture.home + ' (' + formatDate(weekFixture.kickoff,timeLabel) + ').'
        : weekGames().some(g => g.stage === 'REG') && completeSeason(Number(state.week.split('-')[0])) ? 'Bye week. No fixture is listed for this defence.' : 'No fixture listed for this team in the selected week.';
      html += '<p>' + escape(noGame) + '</p>';
    }
    for (const g of fixtures) {
      const opponent = g.home === team ? g.away : g.home;
      html += '<p><b>' + escape(teamName(opponent)) + ' opponents</b> · ' + escape(formatDate(g.kickoff,timeLabel)) + ' · ' + escape(tag(g)) + '</p>';
      const matches = (wk.players || []).filter(p => p.game === g.id && p.team === opponent && p.role === role.id);
      html += matches.length ? '<ul>' + matches.map(p => '<li><strong>' + escape(p.name) + '</strong>' + (p.injury ? ' · <span class="limit">' + escape(p.injury) + '</span>' : '') + '</li>').join('') +
        '</ul>' : '<p>No matching players identified in the available roster and usage data.</p>';
    }
    if (fixtures.length) html += '<p class="subtle">' + escape(wk.rosterSource || 'Role membership includes unflagged players.') + ' Missing injury information leaves availability unconfirmed.</p>';
    el.innerHTML = html;
  }
  function workloadText(work) {
    if (!work) return '';
    return [['carries','carries'],['targets','targets'],['target_share','target share'],['red_zone_carries','red-zone carries'],['red_zone_targets','red-zone targets']]
      .filter(([key]) => Number.isFinite(work[key])).map(([key,label]) => (key === 'target_share' ? nfmt(100*work[key]) + '%' : nfmt(work[key])) + ' ' + label).join(' · ');
  }
  function cards(rows) {
    return rows.map(({p, f}) => {
      const limits = Array.isArray(f.limitations) ? f.limitations.join(' ') : f.limitations;
      const workload = workloadText(p.workload);
      return '<article class="signal-row"><div class="signal-title"><h3>' + escape(p.name) + '</h3><small>' + escape(p.team + ' · ' + (roleBy(p.role)?.label || p.position) + ' · ' + (statBy(f.stat)?.label || f.stat)) +
        '</small><span class="' + (f.direction === 'Favourable' ? 'tag-fav' : 'tag-unfav') + '">' + escape(f.direction) + '</span></div><div class="nums"><span>Baseline <b>' + nfmt(f.baseline,precision(f.stat)) +
        '</b></span><span>Projected <b>' + nfmt(f.projected,precision(f.stat)) + '</b></span><span>Difference <b>' + signed(f.delta,precision(f.stat)) + '</b></span></div><p>' + escape(f.explanation) + '</p>' +
        (limits || p.injury ? '<p class="limit">' + escape(limits || p.injury) + '</p>' : '') +
        (workload ? '<details class="workload-note"><summary>Established workload</summary>' + escape(workload) + ' per eligible game (target share is a proportion of team targets).</details>' : '') + '</article>';
    }).join('');
  }
  function venueText(g) {
    const parts = [g.venue, g.roof && 'Roof: ' + g.roof];
    const w = g.weather;
    if (w && typeof w === 'object') {
      if (Number.isFinite(w.temperatureF)) parts.push(nfmt((w.temperatureF-32)*5/9,0) + '°C');
      if (Number.isFinite(w.gustMph)) parts.push('Gusts ' + nfmt(w.gustMph * 1.60934,0) + ' km/h');
      if (Number.isFinite(w.precipitationPct)) parts.push('Precipitation ' + nfmt(w.precipitationPct,0) + '%');
      if (w.asOf) parts.push('Forecast as of ' + formatDate(w.asOf,timeLabel));
    }
    return parts.filter(Boolean).join(' · ') || 'Venue conditions unavailable.';
  }
  function renderSignals() {
    const ids = new Set(dayGames().map(g => g.id));
    const players = (getWeek().players || []).filter(p => ids.has(p.game));
    const rows = players.flatMap(p => (p.flags || []).map(f => ({p,f})));
    const pos = rows.filter(x => x.f.direction === 'Favourable').length;
    $('nav-count').textContent = rows.length;
    $('match-metrics').innerHTML = metric('GAMES ON SLATE',ids.size) + metric('FAVOURABLE',pos) + metric('UNFAVOURABLE',rows.length-pos) + metric('PLAYERS FLAGGED',new Set(rows.map(x=>x.p.id)).size);
    const games = dayGames().filter(g => !state.game || g.id === state.game);
    const chosen = rows.filter(({f}) => (!state.direction || state.direction === f.direction) && (!state.signalStat || state.signalStat === f.stat));
    $('signal-list').innerHTML = games.length ? games.map((g,i) => {
      const subset = chosen.filter(({p}) => p.game === g.id);
      return '<details class="signal-game"' + (i === 0 ? ' open' : '') + '><summary>' + escape(teamName(g.away) + ' at ' + teamName(g.home)) + '<small>' +
        escape(formatDate(g.kickoff,timeLabel)) + ' · ' + escape(tag(g)) + ' · ' + subset.length + ' signals</small></summary>' +
        '<p class="fixture-info">' + escape(venueText(g)) + '</p>' +
        (subset.length ? cards(subset) : empty('No flagged player-stat matchups for this fixture and filter.')) + '</details>';
    }).join('') : empty('No fixtures match the selected week and day.');
  }
  function methodText() {
    return (model.methodology || []).map(m => '<h3>' + escape(m.title) + '</h3><p>' + escape(m.body) + '</p>').join('');
  }
  function renderPerformance() {
    $('performance-notes').innerHTML = methodText();
    $('definitions').innerHTML = (model.methodology || []).filter(m => ['Who qualifies','Position and role','Receiver coverage','Reading the heatmap'].includes(m.title)).map(m => '<h3>'+escape(m.title)+'</h3><p>'+escape(m.body)+'</p>').join('') || methodText();
    const records = model.performance || [];
    if (!records.some(r => r.n)) {
      $('performance-metrics').innerHTML = '<p class="audit-note">Insufficient earlier and later player-games for a verified chronological evaluation.</p>';
      return;
    }
    const headers = ['Statistic','Player-games','Model MAE','Without throw mix MAE','Average MAE','Model RMSE','Average RMSE','Direction correct','Directional sample'];
    const vals = r => [statBy(r.stat)?.label || r.stat, nfmt(r.n,0), nfmt(r.mae,2), nfmt(r.withoutThrowMae,2), nfmt(r.baselineMae,2), nfmt(r.rmse,2), nfmt(r.baselineRmse,2),Number.isFinite(r.directionalAccuracy) ? nfmt(r.directionalAccuracy) + '%' : '—',nfmt(r.directionalN,0)];
    const window = model.testWindow;
    const range = window?.first && window?.last ? '<p class="audit-note">' + escape(window.weeks + ' evaluated weeks · ' + formatDate(window.first,fullDay) + ' to ' + formatDate(window.last,fullDay)) + '</p>' : '';
    $('performance-metrics').innerHTML = range + '<div class="performance-panel-scroll" role="region" tabindex="0" aria-label="Backtest results, scroll for all metrics"><table class="allow-table perf"><thead><tr>' + headers.map(h => '<th scope="col">' + h + '</th>').join('') +
      '</tr></thead><tbody>' + records.map(r => '<tr>' + vals(r).map((v,i) => i ? '<td>'+escape(v)+'</td>' : '<th scope="row">'+escape(v)+'</th>').join('') + '</tr>').join('') + '</tbody></table></div>' +
      '<p class="audit-note">MAE is the average absolute miss in the statistic’s own units. RMSE gives larger misses more weight. Lower values indicate smaller errors. Direction compares actual production with the player’s baseline.</p>';
  }
  function renderCoverage() {
    const updated = formatDate(snapshot.updatedAt, timeLabel, 'Unknown');
    $('footer-update').textContent = 'Last successful update · ' + updated;
    $('coverage').innerHTML = '<p>Last successful snapshot: <b>' + escape(updated) + '</b>. The target source refresh interval is 12 hours. Scheduler delays and late upstream reports can leave older data in view. Reload latest data fetches the published snapshot.</p><ul class="coverage-list">' +
      (snapshot.coverage || []).map(c => '<li><b>' + (/^https?:\/\//.test(c.url || '') ? '<a target="_blank" rel="noopener" href="' + escape(c.url) + '">' + escape(c.source) + '</a>' : escape(c.source)) + '</b> · ' + escape(c.detail) + '</li>').join('') + '</ul>';
  }
  function weekStatus(message) {
    $('heat-intro').textContent = message;
    $('signal-list').innerHTML = empty(message);
  }
  async function loadWeek(selection, src, owner) {
    if (weekRequests.has(selection)) return;
    const token = {};
    weekRequests.set(selection, token);
    try {
      const response = await fetch('./' + src, {cache:'no-cache'});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const wk = await response.json();
      if (!wk?.cells || !Array.isArray(wk.players)) throw Error('Incomplete week snapshot.');
      if (model === owner) {
        model.weeks[selection] = wk;
        if (selection === state.week) render();
      }
    } catch (err) {
      if (selection === state.week && model === owner) weekStatus('The selected week could not load. Reload latest data to retry.');
      console.error(err);
    } finally {if (weekRequests.get(selection) === token) weekRequests.delete(selection);}
  }
  function render() {
    controls();
    renderHeat();
    renderSignals();
    const src = model.weeks[state.week];
    if (typeof src === 'string') {
      weekStatus('Loading ' + weekName(state.week) + '…');
      loadWeek(state.week, src, model);
    }
  }
  function accept(data) {
    if (!data?.model?.stats?.length || !Array.isArray(data.games) || !Array.isArray(data.teams)) throw Error('Incomplete data snapshot.');
    weekRequests.clear();
    snapshot = data; model = data.model; teamsById = new Map(data.teams.map(t => [t.id,t]));
    gamesByWeek = new Map();
    const sorted = [...data.games].sort((a,b) => (a.kickoff || 'z').localeCompare(b.kickoff || 'z'));
    for (const game of sorted) {
      if (!gamesByWeek.has(key(game))) gamesByWeek.set(key(game),[]);
      gamesByWeek.get(key(game)).push(game);
    }
    weeks = [...gamesByWeek.keys()].sort((a,b) => {
      const [y,w] = a.split('-').map(Number), [yy,ww] = b.split('-').map(Number);
      return y - yy || w - ww;
    });
    if (!weeks.length) throw Error('No verified fixtures are available.');
    if (!weeks.includes(state.week)) {
      const season = sorted.filter(g=>g.season === data.season);
      const next = season.find(g => g.kickoff && Date.parse(g.kickoff) >= Date.now() && g.status !== 'postponed');
      const latest = season.filter(g=>g.kickoff).at(-1);
      state.week = next ? key(next) : latest ? key(latest) : weeks.at(-1);
    }
    if (!statBy(state.stat)) state.stat = model.stats[0].id;
    render();
    renderPerformance();
    renderCoverage();
    window.NFLPassing?.mount(data);
    window.NFLTracker?.mount($('bet-tracker'), data);
  }
  let refreshing = false;
  async function reload() {
    if (refreshing) return;
    refreshing = true;
    const refresh = $('refresh-btn'), live = $('live-pill');
    refresh.disabled = true;
    try {
      const response = await fetch('./data.json', {cache:'no-store'});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (!snapshot || data.updatedAt !== snapshot.updatedAt) accept(data);
      else if (typeof model.weeks[state.week] === 'string') render();
      const stale = Date.now() - Date.parse(data.updatedAt) > 36 * 60 * 60 * 1000;
      live.className = 'live-pill ' + (stale ? 'warning' : 'synced');
      live.innerHTML = '<span></span>' + (stale ? 'OLDER SNAPSHOT' : 'SNAPSHOT LOADED');
      live.title = 'Last successful update: ' + formatDate(data.updatedAt,timeLabel);
      $('error-banner').classList.add('hidden');
    } catch (error) {
      live.className = 'live-pill warning';
      live.innerHTML = '<span></span>UPDATE UNAVAILABLE';
      const banner = $('error-banner');
      banner.classList.remove('hidden');
      banner.textContent = 'Could not load the published snapshot. ' + (snapshot ? 'Showing the last data loaded in this tab.' : 'Reload latest data to retry. Your local bet tracker remains available.');
      console.error(error);
    } finally {refresh.disabled = false; refreshing = false;}
  }
  all('.nav-link').forEach(b => b.addEventListener('click', () => {location.hash = b.dataset.page;}));
  window.addEventListener('hashchange', navigate);
  all('.week-picker').forEach(s => s.addEventListener('change', () => {state.week = s.value; state.day = ''; state.game = ''; render();}));
  all('.day-picker').forEach(s => s.addEventListener('change', () => {state.day = s.value; render();}));
  $('heat-stat').addEventListener('change', e=>{state.stat = e.target.value; renderHeat();});
  $('heat-position').addEventListener('change',e=>{state.position = e.target.value; renderHeat();});
  $('heatmap-table').addEventListener('click',e=>{
    const b = e.target.closest('button[data-role]'); if (!b) return;
    all('.selected-cell').forEach(old=>{old.classList.remove('selected-cell');old.setAttribute('aria-pressed','false');});
    b.classList.add('selected-cell'); b.setAttribute('aria-pressed','true');
    state.role = b.dataset.role; state.team = b.dataset.team;
    showDetail();
    $('heatmap-detail').scrollIntoView({block:'nearest'});
  });
  for (const [id, field] of [['direction','direction'],['game-picker','game'],['signal-stat','signalStat']])
    $(id).addEventListener('change', e=>{state[field] = e.target.value; renderSignals();});
  $('refresh-btn').addEventListener('click',reload);
  navigate();
  window.NFLTracker?.mount($('bet-tracker'), null);
  reload();
  window.setInterval(()=>{if (!document.hidden) reload();}, 30*60*1000);
})();
