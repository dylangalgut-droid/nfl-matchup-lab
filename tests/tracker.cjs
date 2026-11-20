'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {indexData,verifyLeg,evaluate,totals,validBet,mergeBackup,emptyLedger,saveProofs,localDay}=require('../docs/tracker.js');

const legs=[
  {game:'g1',player:'p1',stat:'rush_rec_yards',target:80,op:'gte'},
  {game:'g2',player:'p2',stat:'tds',target:1,op:'gte'}
];
const data={games:[{id:'g1',status:'final',boxVerified:true},{id:'g2',status:'final',boxVerified:true}],
  stats:[{game:'g1',player:'p1',carries:10,rushing_yards:53,receiving_yards:27},{game:'g2',player:'p2',attempts:20,passing_tds:2,tds:0}]};
const ix=indexData(data), b={id:'b1',type:'multi',description:'Two players',date:'2026-10-20',odds:2.5,stake:2,legs};

test('combined yards uses both official fields and counts as one leg',()=>{
  assert.equal(verifyLeg(legs[0],ix).value,80);
  assert.equal(verifyLeg(legs[0],ix).status,'won');
  const solo={...b,type:'single',legs:[legs[0]]};
  assert.equal(evaluate(solo,ix).net,3);
  assert.equal(verifyLeg({...legs[0],op:'over'},ix).status,'review');
  assert.equal(verifyLeg({...legs[0],op:'under',target:80.5},ix).status,'won');
});
test('passes thrown do not count as a touchdown scored; a losing multi is one loss',()=>{
  const res=totals([b],ix);assert.equal(res.lost,1);assert.equal(res.net,-2);assert.equal(res.pending,0);
});
test('unknown, postponed, live, unverified, DNP and incomplete totals never default to zero',()=>{
  for(const g of [{status:'postponed'},{status:'in_progress'},{status:'final',boxVerified:false}]) {
    assert.equal(verifyLeg(legs[0],indexData({...data,games:[{id:'g1',...g}]})).status,'pending');
  }
  assert.equal(verifyLeg({...legs[0],player:'absent'},ix).status,'review');
  for(const row of [{carries:0},{carries:1,rushing_yards:32,receiving_yards:null}]) {
    assert.equal(verifyLeg(legs[0],indexData({...data,stats:[{game:'g1',player:'p1',...row}]})).status,'review');
  }
  const unfinished={...b,legs:[legs[1],{...legs[0],game:'not-yet'}]};
  assert.equal(evaluate(unfinished,ix).status,'pending');
});
test('custom cash-outs, voids and pending review are counted at bet level',()=>{
  assert.equal(evaluate({...b,manual:{status:'lost',totalReturn:1.4}},ix).net,1.4-2);
  assert.equal(evaluate({...b,manual:{status:'void',totalReturn:null}},ix).net,0);
  const res=totals([{...b,legs:[]}],ix);assert.equal(res.pending,1);assert.equal(res.review,1);
});
test('final evidence survives a later season and updates with official corrections',()=>{
  const ledger=emptyLedger();ledger.bets.push(structuredClone(b));
  assert.equal(saveProofs(ledger,ix),true);const leg=ledger.bets[0].legs[0];
  assert.equal(verifyLeg(leg,indexData(null)).value,80);
  const corrected=indexData({...data,stats:[{...data.stats[0],rushing_yards:48},data.stats[1]]});
  saveProofs(ledger,corrected);assert.equal(verifyLeg(leg,indexData(null)).value,75);
  saveProofs(ledger,indexData({...data,games:[{id:'g1',status:'in_progress'}]}));
  assert.equal(verifyLeg(leg,indexData(null)).status,'pending');
});
test('backup merge preserves existing active and removed records and rejects invalid imports',()=>{
  const first=emptyLedger();first.bets=[structuredClone(b)];
  const other=emptyLedger();other.bets=[{...b,description:'old version'}];other.removed=[{...b,id:'b2'}];
  mergeBackup(first,JSON.parse(JSON.stringify(other)));
  assert.equal(first.bets[0].description,b.description);assert.equal(first.removed.length,1);
  assert.throws(()=>mergeBackup(first,{...other,bets:[{...b,stake:'2'}]}));assert.equal(first.bets.length,1);
  assert.equal(validBet({...b,type:'single'}),false);
});
test('Melbourne uses DST and crosses calendar dates',()=>{
  assert.equal(localDay('2026-11-19T18:00:00Z'),'2026-11-20');
  assert.equal(localDay('2026-05-01T13:00:00Z'),'2026-05-01');
});
