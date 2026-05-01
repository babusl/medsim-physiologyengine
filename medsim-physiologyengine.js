// ═══════════════════════════════════════════════════════════════════════════════
//  medsim-physiologyengine.js  —  MedSim Physiologic Engine
//  Version: 2.0 — Complete rewrite with drug stacking + offset curves
//
//  KEY ARCHITECTURAL CHANGE FROM v1.x:
//  Instead of trSet() overwriting targets, every drug registers an ACTIVE EFFECT
//  with its own onset, peak, and offset curve. The engine sums ALL active effects
//  each frame and adds them to baseline. Multiple drugs stack correctly.
//
//  Example: propofol drops BP by 30. Phenyl raises by 22. Net = -8 from baseline.
//  As propofol wears off over 5 min, phenyl effect remains. Correct physiology.
//
//  UPLOAD THIS FILE TO: babusl.github.io/medsim-physiologyengine/
//  One file update fixes physiology across all tools.
// ═══════════════════════════════════════════════════════════════════════════════

(function(global){
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PATIENT PARAMETERS
// ─────────────────────────────────────────────────────────────────────────────
var P = {
  mode:    'adult',
  weight:  70,
  age:     35,
  baseline: {hr:72, sbp:112, dbp:70, spo2:98, rr:14, etco2:35}
};

var DEFAULT_PEDS_AGE = 3;

// Anesthetized 25-50th percentile vitals by age
function ageNorms(yrs) {
  if(yrs < 0.08) return {hr:135,sbp:55, dbp:35,rr:40,weight:3.5, label:'Neonate'};
  if(yrs < 0.5)  return {hr:135,sbp:65, dbp:40,rr:36,weight:5,   label:'Young infant'};
  if(yrs < 1)    return {hr:125,sbp:70, dbp:45,rr:30,weight:8,   label:'Infant'};
  if(yrs < 2)    return {hr:115,sbp:76, dbp:48,rr:26,weight:11,  label:'Toddler'};
  if(yrs < 5)    return {hr:100,sbp:82, dbp:50,rr:22,weight:16,  label:'Preschool'};
  if(yrs < 8)    return {hr:90, sbp:88, dbp:54,rr:20,weight:23,  label:'School age'};
  if(yrs < 12)   return {hr:82, sbp:94, dbp:58,rr:18,weight:35,  label:'Older child'};
  if(yrs < 16)   return {hr:75, sbp:100,dbp:62,rr:16,weight:55,  label:'Adolescent'};
  return                {hr:72, sbp:112,dbp:70,rr:14,weight:70,  label:'Adult'};
}

function setPatient(opts){
  if(opts.mode)   P.mode   = opts.mode;
  if(opts.weight) P.weight = opts.weight;
  if(opts.age)    P.age    = opts.age;
  if(opts.baseline) P.baseline = Object.assign({},P.baseline,opts.baseline);
  _emit('patient');
}

function setPatientAge(yrs){
  P.age = yrs;
  var n = ageNorms(yrs);
  P.weight = n.weight;
  P.baseline = {hr:n.hr, sbp:n.sbp, dbp:n.dbp, spo2:98, rr:n.rr, etco2:35};
  // Apply immediately, clear all drug effects
  S.hr=n.hr; S.sbp=n.sbp; S.dbp=n.dbp; S.spo2=98; S.rr=n.rr; S.etco2=35;
  S.weight=n.weight;
  _activeEffects = [];
  _infusions = {};
  _emit('patient'); _emit('state');
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHYSIOLOGIC STATE  (display values — derived each frame from baseline + effects)
// ─────────────────────────────────────────────────────────────────────────────
var S = {
  hr:72, sbp:112, dbp:70, spo2:98, rr:14, etco2:35, temp:37.0,
  rhythm:'NSR', weight:70,
  // Vent
  ventMode:'VCV', rr_set:14, tv:450, peep:5, fio2:50, compliance:50, resistance:5,
  ventPath:'normal', ps:10, ie:2.0, pipLimit:40, apl:30,
  // Flags
  etco2On:true, artLine:false,
  _paralyzed:false, _nmbSavedRR:14,
  // Internal physiology
  _svr:1200, _co:5.0, _preload:1.0, _inotropy:1.0
};

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVE EFFECTS REGISTRY
//  Each drug gives registers an effect object. Every frame, all active effects
//  are summed and applied ON TOP OF baseline. Effects decay over time.
// ─────────────────────────────────────────────────────────────────────────────
var _activeEffects = [];
// { id, drug, peak:{hr,sbp,dbp,spo2,rr,etco2}, elapsed:0,
//   onset:s, duration:s, offset:s, mode:'iv'|'push'|'slow' }

var _infusions = {};
// { name: { drug, dose, weight, elapsed:0, rampTime:60, peak:{...} } }

var _effectId = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  EFFECT CURVE  (unitless 0→1)
//  Three-phase: onset ramp → plateau → offset decay
//  elapsed = seconds since drug was given
// ─────────────────────────────────────────────────────────────────────────────
function effectCurve(elapsed, onset, duration, offset){
  if(elapsed < 0) return 0;
  if(elapsed < onset){
    // Rising phase — smooth S-curve
    var t = elapsed / onset;
    return t * t * (3 - 2*t); // smoothstep
  }
  if(elapsed < onset + duration){
    return 1.0; // plateau
  }
  var decayElapsed = elapsed - onset - duration;
  if(decayElapsed >= offset) return 0;
  // Falling phase — exponential-ish decay
  var t = decayElapsed / offset;
  return 1.0 - t*t*(3 - 2*t);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRUG LIBRARY
//  peak: max delta from current baseline (+ = increase, - = decrease)
//  onset:    seconds to full effect
//  duration: seconds at full effect before wearing off
//  offset:   seconds to fully wear off after duration ends
//
//  NOTE: peaks are applied to BASELINE, not current state.
//  Interaction example:
//    Baseline SBP = 112. Propofol peak.sbp = -30. Phenyl peak.sbp = +22.
//    Frame 60s later: prop curve=0.9, phenyl curve=1.0
//    Computed SBP = 112 + (0.9 * -30) + (1.0 * 22) = 112 - 27 + 22 = 107
// ─────────────────────────────────────────────────────────────────────────────
var DRUGS = {

  // ── VASOPRESSORS ────────────────────────────────────────────────────────────

  phenylephrine: {
    onset:5, duration:200, offset:120,
    peak: function(dose,wt,mode){
      var rise = Math.min(40, dose * 0.22);
      var brady = mode==='peds' ? rise*0.08 : rise*0.55;
      return {sbp:rise, dbp:Math.round(rise*0.55), hr:-Math.round(brady)};
    }
  },

  epinephrine_push: {
    onset:4, duration:90, offset:120,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0, dose/50);
      // Bronchodilation handled separately
      return {hr:Math.round(20+i*55), sbp:Math.round(25+i*55), dbp:Math.round(10+i*22)};
    },
    onGive: function(dose,wt,mode){
      if(S.ventPath==='bronchospasm') _applyBronchodilation(Math.min(1,dose/50)*0.5);
    }
  },

  epinephrine_code: {
    onset:5, duration:120, offset:150,
    peak: function(dose,wt,mode){
      return {sbp:55, dbp:28, hr:45};
    }
  },

  epinephrine: { // infusion — handled via _infusions
    rampTime:60,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0, dose/0.2);
      return {hr:Math.round(12+i*35), sbp:Math.round(10+i*55), dbp:Math.round(4+i*20)};
    }
  },

  norepinephrine_bolus: {
    onset:5, duration:150, offset:120,
    peak: function(dose,wt,mode){
      var rise = Math.min(45, dose*0.25);
      return {sbp:rise, dbp:Math.round(rise*0.65), hr:Math.round(rise*0.06)};
    }
  },

  norepinephrine: { // infusion
    rampTime:90,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0, dose/0.15);
      var rise = Math.round(i*38);
      return {sbp:rise, dbp:Math.round(rise*0.65), hr:Math.round(rise*0.06)};
    }
  },

  vasopressin_bolus: {
    onset:5, duration:400, offset:180,
    peak: function(dose,wt,mode){
      var i = mode==='peds' ? Math.min(1,dose/0.02) : Math.min(1,dose/1.0);
      return {sbp:Math.round(25+i*20), dbp:Math.round(12+i*10), hr:0};
    }
  },

  vasopressin: { // infusion
    rampTime:120,
    peak: function(dose,wt,mode){
      var i = mode==='peds' ? Math.min(1,dose/20) : Math.min(1,dose/2.0);
      return {sbp:Math.round(i*28), dbp:Math.round(i*12), hr:0};
    }
  },

  ephedrine: {
    onset:5, duration:400, offset:200,
    peak: function(dose,wt,mode){
      var i = Math.min(1,dose/10);
      return {hr:Math.round(i*16), sbp:Math.round(i*18), dbp:Math.round(i*8)};
    }
  },

  dopamine: { // infusion
    rampTime:60,
    peak: function(dose,wt,mode){
      var beta  = Math.min(1,Math.max(0,(dose-5)/5));
      var alpha = Math.min(1,Math.max(0,(dose-10)/10));
      return {hr:Math.round(beta*18+alpha*10), sbp:Math.round(beta*8+alpha*30), dbp:Math.round(beta*3+alpha*14)};
    }
  },

  phenylephrine_infusion: {
    rampTime:60,
    peak: function(dose,wt,mode){
      // dose in mcg/kg/min, typical 0.5-3
      var i = Math.min(1,dose/2.0);
      var rise = Math.round(i*35);
      var brady = mode==='peds' ? rise*0.08 : rise*0.5;
      return {sbp:rise, dbp:Math.round(rise*0.55), hr:-Math.round(brady)};
    }
  },

  // ── INDUCTION AGENTS ────────────────────────────────────────────────────────

  propofol: {
    onset:6, duration:180, offset:300,
    // Vasodilation + mild negative inotropy. Duration ~3-5 min at induction dose.
    // Larger doses = more BP drop, longer duration.
    peak: function(dose,wt,mode){
      var i = Math.min(1.5, dose/(wt*2.0)); // 1.0 at 2mg/kg, 1.5 at 3+ mg/kg
      var bpDrop = Math.round(22 + i*20); // 22-50 mmHg depending on dose
      // HR: genuinely inconsistent — small random variation
      var hrDelta = Math.round((Math.random()-0.5)*8); // -4 to +4
      return {sbp:-bpDrop, dbp:-Math.round(bpDrop*0.55), hr:hrDelta, rr:-14};
    },
    adjustDuration: function(dose,wt){
      // Higher dose = longer effect
      return Math.round(180 + (dose/(wt*2.0)) * 120);
    }
  },

  ketamine: {
    onset:6, duration:600, offset:300,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0,dose/(wt*2.0));
      // Mild sympathomimetic — not like a pressor
      return {hr:Math.round(8+i*10), sbp:Math.round(10+i*12), dbp:Math.round(4+i*5)};
    }
  },

  etomidate: {
    onset:5, duration:300, offset:150,
    peak: function(dose,wt,mode){
      // Hemodynamically neutral. Apnea.
      return {hr:0, sbp:0, dbp:0, rr:-14};
    }
  },

  midazolam: {
    onset:6, duration:1200, offset:600,
    peak: function(dose,wt,mode){
      var rrDrop = mode==='peds' ? -4 : -3;
      return {hr:0, sbp:-3, dbp:-2, rr:rrDrop};
    }
  },

  dexmedetomidine_bolus: {
    onset:8, duration:300, offset:300,
    peak: function(dose,wt,mode){
      // Transient HTN then sustained brady/hypotension
      // Model net effect (skipping the brief HTN spike for simplicity)
      return {hr:-14, sbp:-8, dbp:-5};
    }
  },

  dexmedetomidine: { // infusion
    rampTime:120,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0,dose/1.0);
      return {hr:-Math.round(i*18), sbp:-Math.round(i*14), dbp:-Math.round(i*8)};
    }
  },

  // ── OPIOIDS ─────────────────────────────────────────────────────────────────

  fentanyl: {
    onset:5, duration:1800, offset:900,
    peak: function(dose,wt,mode){
      // dose in mcg. Adults: 50-250mcg. Peds: 1-2 mcg/kg.
      var mcgPerKg = dose/wt;
      var i = Math.min(1.0,mcgPerKg/3.0);
      return {hr:-Math.round(4+i*8), sbp:-Math.round(3+i*10), dbp:-Math.round(2+i*5), rr:-Math.round(2+i*8)};
    }
  },

  morphine: {
    onset:120, duration:3600, offset:1800, // SLOW onset — minutes not seconds
    peak: function(dose,wt,mode){
      var i = Math.min(1.0,dose/10);
      // Histamine → vasodilation → BP ↓, HR ↑ mild
      return {hr:Math.round(3+i*5), sbp:-Math.round(4+i*12), dbp:-Math.round(2+i*6), rr:-Math.round(2+i*6)};
    }
  },

  remifentanil: { // infusion
    rampTime:30, // very fast onset
    peak: function(dose,wt,mode){
      var i = Math.min(1.0,dose/0.2);
      return {hr:-Math.round(i*16), sbp:-Math.round(i*18), dbp:-Math.round(i*10), rr:-Math.round(i*10)};
    }
  },

  naloxone: {
    onset:4, duration:1200, offset:600,
    peak: function(dose,wt,mode){
      // Reversal — pull opioid effects back toward 0 by removing them
      _removeEffectsByClass('opioid');
      return {rr:12, hr:5, sbp:8, dbp:4};
    }
  },

  // ── ANTICHOLINERGICS ─────────────────────────────────────────────────────────

  atropine: {
    onset:4, duration:1200, offset:600,
    peak: function(dose,wt,mode){
      var i = mode==='peds' ? Math.min(1,dose/(wt*0.02)) : Math.min(1,dose/0.5);
      return {hr:Math.round(15+i*25), sbp:Math.round(3+i*8), dbp:Math.round(1+i*4)};
    }
  },

  glycopyrrolate: {
    onset:15, duration:1800, offset:900,
    peak: function(dose,wt,mode){
      var i = Math.min(1,dose/0.2);
      return {hr:Math.round(8+i*15), sbp:Math.round(2+i*5), dbp:Math.round(1+i*2)};
    }
  },

  // ── ANTIARRHYTHMICS ──────────────────────────────────────────────────────────

  amiodarone_arrest: {
    onset:10, duration:3600, offset:1800,
    peak: function(dose,wt,mode){ return {hr:-8}; }
  },

  amiodarone_infusion: {
    onset:120, duration:7200, offset:3600,
    peak: function(dose,wt,mode){ return {hr:-12, sbp:-8, dbp:-4}; }
  },

  lidocaine: {
    onset:5, duration:900, offset:300,
    peak: function(dose,wt,mode){ return {}; } // no hemodynamic effect
  },

  magnesium: {
    onset:15, duration:1800, offset:900,
    peak: function(dose,wt,mode){ return {hr:-4, sbp:-5, dbp:-3}; }
  },

  // ── FLUIDS ───────────────────────────────────────────────────────────────────

  fluid_bolus: {
    onset:60, duration:600, offset:900,
    // Preload-dependent effect
    peak: function(dose,wt,mode){
      var normalDose = mode==='peds' ? wt*15 : 500;
      var i = Math.min(1.0,dose/normalDose);
      var preloadBonus = Math.max(0, 1.2 - S._preload);
      var scale = Math.min(1.5, i*(1.0+preloadBonus));
      S._preload = Math.min(1.4, S._preload + i*0.2);
      var hrDrop = S.hr > (P.baseline.hr+20) ? -Math.round(scale*14) : -Math.round(scale*4);
      return {hr:hrDrop, sbp:Math.round(scale*12), dbp:Math.round(scale*6), etco2:Math.round(scale*3)};
    }
  },

  blood: {
    onset:60, duration:900, offset:600,
    peak: function(dose,wt,mode){
      var i = Math.min(1.0,dose/2.0);
      S._preload = Math.min(1.4,S._preload+i*0.25);
      return {hr:-Math.round(i*12), sbp:Math.round(i*14), dbp:Math.round(i*7), spo2:Math.round(i*4)};
    }
  },

  // ── BRONCHODILATORS ──────────────────────────────────────────────────────────

  albuterol: {
    onset:3, duration:1200, offset:600,
    peak: function(dose,wt,mode){
      _applyBronchodilation(0.7);
      return {hr:8, spo2:6, etco2:-8};
    }
  },

  // ── ELECTROLYTES ─────────────────────────────────────────────────────────────

  calcium_chloride: {
    onset:5, duration:1200, offset:600,
    peak: function(dose,wt,mode){ return {hr:5, sbp:10, dbp:5}; }
  },

  sodium_bicarb: {
    onset:10, duration:900, offset:300,
    peak: function(dose,wt,mode){ return {hr:2}; }
  },

  diphenhydramine: {
    onset:8, duration:3600, offset:1800,
    peak: function(dose,wt,mode){ return {hr:3, sbp:-3, dbp:-2}; }
  },

  methylprednisolone: {
    onset:60, duration:14400, offset:7200,
    peak: function(dose,wt,mode){ return {}; }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  EFFECT CLASS TAGS  (for reversal — naloxone removes opioid class)
// ─────────────────────────────────────────────────────────────────────────────
var DRUG_CLASSES = {
  fentanyl:'opioid', morphine:'opioid', remifentanil:'opioid'
};

function _removeEffectsByClass(cls){
  _activeEffects = _activeEffects.filter(function(e){
    return DRUG_CLASSES[e.drug] !== cls;
  });
  // Also stop infusions of that class
  Object.keys(_infusions).forEach(function(k){
    if(DRUG_CLASSES[_infusions[k].drug]===cls) delete _infusions[k];
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GIVE() — register a drug effect
// ─────────────────────────────────────────────────────────────────────────────
function give(drugKey, dose, opts){
  opts = opts || {};
  var wt   = opts.weight || S.weight || P.weight;
  var mode = P.mode;
  var drug = DRUGS[drugKey];

  if(!drug){ console.warn('medsimcore: unknown drug', drugKey); return; }

  // Special handlers
  if(drug.onGive) drug.onGive(dose, wt, mode);

  // NMB drugs
  if(DRUG_NMB[drugKey]){ _applyNMB(drugKey, dose, wt, mode); return; }
  if(DRUG_NMB_REV[drugKey]){ _applyNMBReversal(drugKey, dose, wt); return; }

  // Adenosine special
  if(drugKey==='adenosine'){ _applyAdenosine(dose); return; }

  // Procedure
  if(DRUG_PROC[drugKey]){ DRUG_PROC[drugKey](dose,wt,mode); return; }

  // Infusion — register in _infusions, not _activeEffects
  if(drug.rampTime != null){
    _infusions[drugKey] = {drug:drugKey, dose:dose, weight:wt, elapsed:0, rampTime:drug.rampTime};
    return;
  }

  // Compute peak delta from current baseline
  if(!drug.peak) return;
  var peak = drug.peak(dose, wt, mode);

  // Duration may be dose-adjusted
  var dur = drug.adjustDuration ? drug.adjustDuration(dose,wt) : (drug.duration||300);

  _activeEffects.push({
    id:    ++_effectId,
    drug:  drugKey,
    peak:  peak,
    elapsed: 0,
    onset:   drug.onset    || 5,
    duration:dur,
    offset:  drug.offset   || 300
  });
}

function startInfusion(name, drugKey, dose, wt){ give(drugKey, dose, {weight:wt||P.weight}); }
function stopInfusion(name){ delete _infusions[name]; }

// ─────────────────────────────────────────────────────────────────────────────
//  NMB LOGIC
// ─────────────────────────────────────────────────────────────────────────────
var DRUG_NMB = {
  succinylcholine:1, rocuronium:1, vecuronium:1
};
var DRUG_NMB_REV = {
  sugammadex:1, neostigmine:1
};

var _nmbOnsets = {
  succinylcholine: 25,
  rocuronium: function(dose,wt){ return (dose/wt)>=1.0 ? 35 : 120; },
  vecuronium: 120
};

var _nmbDurations = {
  succinylcholine: 480,
  rocuronium: function(dose,wt){ return (dose/wt)>=1.0 ? 3600 : 1800; },
  vecuronium: 1800
};

function _applyNMB(key, dose, wt, mode){
  S._paralyzed = true;
  S._nmbSavedRR = S.rr_set || P.baseline.rr || 14;
  if(S.ventMode==='Manual'){
    // Apnea — rr and etco2 drop with NMB onset speed
    var onsetTime = typeof _nmbOnsets[key]==='function'
      ? _nmbOnsets[key](dose,wt) : (_nmbOnsets[key]||30);
    _activeEffects.push({
      id:++_effectId, drug:key+'_apnea',
      peak:{rr:-S.rr, etco2:-S.etco2},
      elapsed:0, onset:onsetTime, duration:_nmbDurations[key]||1800, offset:60
    });
  }
  // Sux infant bradycardia
  if(key==='succinylcholine' && P.mode==='peds' && wt<8 && dose/wt>2.5){
    _activeEffects.push({
      id:++_effectId, drug:'sux_brady',
      peak:{hr:-15}, elapsed:0, onset:25, duration:60, offset:60
    });
  }
  _emit('state');
}

function _applyNMBReversal(key, dose, wt){
  S._paralyzed = false;
  // Remove NMB apnea effects
  _activeEffects = _activeEffects.filter(function(e){
    return !e.drug.endsWith('_apnea');
  });
  if(S.ventMode==='Manual'){
    // Breathing returns
    _activeEffects.push({
      id:++_effectId, drug:'nmb_rev',
      peak:{rr:S._nmbSavedRR||P.baseline.rr},
      elapsed:0, onset:45, duration:3600, offset:300
    });
  }
  // Sugammadex rare brady
  if(key==='sugammadex'){
    _activeEffects.push({
      id:++_effectId, drug:'sugammadex_brady',
      peak:{hr:-2}, elapsed:0, onset:10, duration:120, offset:60
    });
  }
  _emit('state');
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADENOSINE
// ─────────────────────────────────────────────────────────────────────────────
function _applyAdenosine(dose){
  var prev = S.rhythm;
  S.rhythm='Asystole'; S.hr=0; S.sbp=0; S.dbp=0;
  _emit('state');
  setTimeout(function(){
    if(prev==='SVT'){ S.rhythm='NSR'; S.hr=78; S.sbp=P.baseline.sbp; S.dbp=P.baseline.dbp; }
    else S.rhythm=prev;
    _emit('state');
  }, 4000+Math.random()*2000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROCEDURES
// ─────────────────────────────────────────────────────────────────────────────
var DRUG_PROC = {
  intubation: function(dose,wt,mode){
    S.etco2On=true;
    if(S.etco2<5) S.etco2=28;
    if(S._paralyzed){ S.rr=S.rr_set||P.baseline.rr; }
    else S.rr=S.rr_set||P.baseline.rr;
    _emit('state');
  },
  defibrillation: function(dose){ /* handled by rhythm logic in monitor */ },
  cardioversion:  function(dose){ /* handled by rhythm logic in monitor */ },
  cpr: function(active){
    if(active){
      _activeEffects.push({id:++_effectId,drug:'cpr_effect',
        peak:{sbp:55,dbp:20,etco2:14},elapsed:0,onset:5,duration:999999,offset:10});
    } else {
      _activeEffects = _activeEffects.filter(function(e){ return e.drug!=='cpr_effect'; });
    }
  },
  needle_decomp: function(dose,wt,mode){
    if(S.ventPath==='pneumothorax'){
      _activeEffects.push({id:++_effectId,drug:'decomp',
        peak:{spo2:18, sbp:30, hr:-28},elapsed:0,onset:10,duration:999999,offset:60});
      S.compliance=48; S.resistance=6; _emit('vent');
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  BRONCHODILATION
// ─────────────────────────────────────────────────────────────────────────────
var _pathReturnTimer = null;

function _applyBronchodilation(relief){
  var base = {compliance:50, resistance:5};
  S.compliance = Math.round(S.compliance + (base.compliance - S.compliance)*relief);
  S.resistance  = Math.round(S.resistance  - (S.resistance  - base.resistance )*relief);
  _emit('vent');
}

function _schedulePathReturn(secs){
  if(_pathReturnTimer) clearTimeout(_pathReturnTimer);
  _pathReturnTimer = setTimeout(function(){
    if(S.ventPath==='bronchospasm'){
      S.resistance = Math.min(35, S.resistance+12);
      S.compliance = Math.max(38, S.compliance-8);
      _emit('vent'); _emit('state');
    }
  }, secs*1000);
}

function applyBronchospasmPhysiology(stage){
  // EtCO2 rises (CO2 retention), SpO2 drops with time constant, BP drops if severe
  if(stage===1){
    _activeEffects.push({id:++_effectId, drug:'bronchospasm_effect',
      peak:{etco2:13, hr:26}, elapsed:0, onset:30, duration:999999, offset:60});
    setTimeout(function(){
      if(S.ventPath==='bronchospasm'){
        _activeEffects.push({id:++_effectId, drug:'bronchospasm_spo2',
          peak:{spo2:-8}, elapsed:0, onset:20, duration:999999, offset:60});
      }
    }, 30000);
  } else {
    _activeEffects.push({id:++_effectId, drug:'bronchospasm_effect',
      peak:{etco2:27, hr:43, sbp:-22, dbp:-14}, elapsed:0, onset:20, duration:999999, offset:60});
    setTimeout(function(){
      if(S.ventPath==='bronchospasm'){
        _activeEffects.push({id:++_effectId, drug:'bronchospasm_spo2',
          peak:{spo2:-18}, elapsed:0, onset:15, duration:999999, offset:60});
      }
    }, 20000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  VENTMODE CHANGE
// ─────────────────────────────────────────────────────────────────────────────
function applyVentModeChange(prev, next){
  if(!S._paralyzed) return;
  if(next==='Manual' && prev!=='Manual'){
    _activeEffects.push({id:++_effectId,drug:'manual_apnea',
      peak:{rr:-S.rr,etco2:-S.etco2},elapsed:0,onset:5,duration:999999,offset:10});
  } else if(next!=='Manual' && prev==='Manual'){
    _activeEffects = _activeEffects.filter(function(e){ return e.drug!=='manual_apnea'; });
    _activeEffects.push({id:++_effectId,drug:'vent_takeover',
      peak:{rr:S.rr_set||P.baseline.rr, etco2:Math.max(28,S.etco2)},
      elapsed:0,onset:8,duration:999999,offset:30});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  HYPOXIA ENGINE
// ─────────────────────────────────────────────────────────────────────────────
var _lastSpo2=98, _spo2DropRate=0, _hypoxiaTimer=0;
var _preoxygenated=false;

function _hypoxiaStep(dt){
  var spo2=S.spo2, isPeds=P.mode==='peds';
  var age=P.age||(isPeds?DEFAULT_PEDS_AGE:35);
  var rawDrop=(_lastSpo2-spo2)/Math.max(dt,0.016);
  _spo2DropRate=_spo2DropRate*0.9+rawDrop*0.1;
  _lastSpo2=spo2;
  if(spo2>=94 && _spo2DropRate<0.5) return;

  var speedFactor=isPeds ? Math.max(0.6,Math.min(2.5,10/Math.max(1,age))) : 1.0;
  if(_preoxygenated) speedFactor*=(isPeds?0.65:0.35);

  if(isPeds){
    if(spo2<80){
      _hypoxiaTimer+=dt*speedFactor;
      var depth=Math.max(0,(80-spo2)/80);
      var slope=Math.min(1,_spo2DropRate/3.0);
      var combined=Math.min(1,depth*0.7+slope*0.3);
      var bhr=P.baseline.hr||120;
      var hrT=Math.round(bhr-combined*(bhr-20));
      // Remove any existing hypoxia HR effect and replace
      _activeEffects=_activeEffects.filter(function(e){return e.drug!=='hypoxia_brady_peds';});
      _activeEffects.push({id:++_effectId,drug:'hypoxia_brady_peds',
        peak:{hr:hrT-S.hr}, elapsed:0, onset:2*speedFactor, duration:999999, offset:30});
      if(spo2<60){
        var bpFrac=Math.max(0,(spo2-20)/40);
        _activeEffects=_activeEffects.filter(function(e){return e.drug!=='hypoxia_bp_peds';});
        _activeEffects.push({id:++_effectId,drug:'hypoxia_bp_peds',
          peak:{sbp:-(P.baseline.sbp*(1-bpFrac*0.6)), dbp:-(P.baseline.dbp*(1-bpFrac*0.5))},
          elapsed:0, onset:3, duration:999999, offset:30});
      }
      if(S.hr<60 && spo2<60 && _hypoxiaTimer>15){
        S.rhythm='PEA'; S.hr=0; S.sbp=0; S.dbp=0; _hypoxiaTimer=0; _emit('state');
      }
    } else {
      _hypoxiaTimer=Math.max(0,_hypoxiaTimer-dt);
      _activeEffects=_activeEffects.filter(function(e){
        return e.drug!=='hypoxia_brady_peds'&&e.drug!=='hypoxia_bp_peds';
      });
    }
  } else {
    // Adult
    _activeEffects=_activeEffects.filter(function(e){return e.drug!=='hypoxia_adult';});
    if(spo2<85 && spo2>=70){
      var d=(85-spo2)*1.5;
      _activeEffects.push({id:++_effectId,drug:'hypoxia_adult',
        peak:{hr:Math.round(d)}, elapsed:0, onset:10, duration:999999, offset:30});
    } else if(spo2<70 && spo2>=50){
      _activeEffects.push({id:++_effectId,drug:'hypoxia_adult',
        peak:{hr:35}, elapsed:0, onset:8, duration:999999, offset:30});
    } else if(spo2<50){
      var bradyT=Math.max(30,(P.baseline.hr||72)-Math.round((50-spo2)*1.2));
      _activeEffects.push({id:++_effectId,drug:'hypoxia_adult',
        peak:{hr:bradyT-S.hr, sbp:-(P.baseline.sbp*0.3), dbp:-(P.baseline.dbp*0.3)},
        elapsed:0, onset:6, duration:999999, offset:30});
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STEP — main simulation loop, called every animation frame
// ─────────────────────────────────────────────────────────────────────────────
var _emitThrottle=0;

function step(dt){
  // 1. Advance all active effect timers
  _activeEffects.forEach(function(e){ e.elapsed+=dt; });

  // 2. Remove fully expired effects
  _activeEffects=_activeEffects.filter(function(e){
    return e.elapsed < e.onset + e.duration + e.offset;
  });

  // 3. Step infusions (ramp up to steady state)
  Object.keys(_infusions).forEach(function(name){
    var inf=_infusions[name];
    inf.elapsed=(inf.elapsed||0)+dt;
    var drug=DRUGS[inf.drug];
    if(!drug||!drug.peak) return;
    // Remove previous infusion effect and re-add with current ramp
    _activeEffects=_activeEffects.filter(function(e){ return e.drug!==inf.drug+'_inf'; });
    var ramp=Math.min(1.0,inf.elapsed/(inf.rampTime||60));
    var fullPeak=drug.peak(inf.dose,inf.weight||P.weight,P.mode);
    var currentPeak={};
    Object.keys(fullPeak).forEach(function(k){currentPeak[k]=fullPeak[k]*ramp;});
    // Register as permanent active effect (duration=999999 = runs until stopped)
    _activeEffects.push({
      id:++_effectId, drug:inf.drug+'_inf',
      peak:currentPeak, elapsed:0, onset:0, duration:999999, offset:30
    });
  });

  // 4. Sum all active effects and apply to baseline
  var sum={hr:0,sbp:0,dbp:0,spo2:0,rr:0,etco2:0};
  _activeEffects.forEach(function(e){
    var curve=effectCurve(e.elapsed, e.onset, e.duration, e.offset);
    Object.keys(e.peak).forEach(function(k){
      if(sum[k]!==undefined) sum[k]+=(e.peak[k]||0)*curve;
    });
  });

  // 5. Apply summed effects to baseline
  var bl=P.baseline;
  var noCirc=(S.rhythm==='VFib'||S.rhythm==='Asystole'||S.rhythm==='PEA');
  if(!noCirc){
    S.hr   = _clamp('hr',   Math.round((bl.hr  ||72)  + sum.hr));
    S.sbp  = _clamp('sbp',  Math.round((bl.sbp ||112) + sum.sbp));
    S.dbp  = _clamp('dbp',  Math.round((bl.dbp ||70)  + sum.dbp));
    S.spo2 = _clamp('spo2', Math.round((bl.spo2||98)  + sum.spo2));
    S.etco2= _clamp('etco2',Math.round((bl.etco2||35) + sum.etco2));
    // RR: only update if not on mechanical vent (vent sets its own RR)
    if(S.ventMode==='Manual' || S.ventMode==='PSV'){
      S.rr = _clamp('rr', Math.round((bl.rr||14) + sum.rr));
    }
  }

  // 6. Run hypoxia engine
  _hypoxiaStep(dt);

  // 7. EtCO2 ROSC recovery
  var perfusing=!noCirc;
  if(perfusing && S.sbp>=50 && S.rr>0 && S.etco2<5 && sum.etco2>-5){
    S.etco2=Math.min(35,S.etco2+0.5*dt);
  }

  // 8. Emit state
  _emitThrottle+=dt;
  if(_emitThrottle>=0.25){ _emitThrottle=0; _emit('state'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CLAMP
// ─────────────────────────────────────────────────────────────────────────────
var CLAMPS={hr:[0,300],sbp:[0,280],dbp:[0,180],spo2:[0,100],rr:[0,60],etco2:[0,80]};
function _clamp(k,v){ var c=CLAMPS[k]; return c?Math.max(c[0],Math.min(c[1],v)):v; }
function clamp(){
  Object.keys(CLAMPS).forEach(function(k){
    if(S[k]!=null) S[k]=_clamp(k,S[k]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────────────────────────────────────────
var _listeners={};
function on(ev,fn){ _listeners[ev]=_listeners[ev]||[]; _listeners[ev].push(fn); }
function off(ev,fn){ if(_listeners[ev]) _listeners[ev]=_listeners[ev].filter(function(f){return f!==fn;}); }
function _emit(ev){ (_listeners[ev]||[]).forEach(function(fn){ try{fn(S,P);}catch(e){console.error(e);} }); }

// ─────────────────────────────────────────────────────────────────────────────
//  DRUG CATALOG (for UI)
// ─────────────────────────────────────────────────────────────────────────────
var CATALOG = {
  vasopressors:[
    {key:'epinephrine_push',     label:'Epinephrine',         sub:'Push-dose pressor',  showDose:false},
    {key:'epinephrine_code',     label:'Epinephrine',         sub:'Code dose 1mg',      showDose:false},
    {key:'epinephrine',          label:'Epinephrine',         sub:'Infusion',           showDose:false,infusion:true},
    {key:'phenylephrine',        label:'Phenylephrine',       sub:'IV push',            showDose:false},
    {key:'phenylephrine_infusion',label:'Phenylephrine',      sub:'Infusion',           showDose:false,infusion:true},
    {key:'norepinephrine',       label:'Norepinephrine',      sub:'Infusion',           showDose:false,infusion:true},
    {key:'norepinephrine_bolus', label:'Norepinephrine',      sub:'IV bolus',           showDose:false},
    {key:'vasopressin_bolus',    label:'Vasopressin',         sub:'IV bolus',           showDose:false},
    {key:'vasopressin',          label:'Vasopressin',         sub:'Infusion',           showDose:false,infusion:true},
    {key:'ephedrine',            label:'Ephedrine',           sub:'IV push',            showDose:false},
    {key:'dopamine',             label:'Dopamine',            sub:'Infusion',           showDose:false,infusion:true},
  ],
  induction:[
    {key:'propofol',             label:'Propofol',            sub:'Induction',          showDose:false},
    {key:'ketamine',             label:'Ketamine',            sub:'Induction',          showDose:false},
    {key:'etomidate',            label:'Etomidate',           sub:'Induction',          showDose:false},
    {key:'midazolam',            label:'Midazolam',           sub:'Sedation',           showDose:false},
    {key:'dexmedetomidine_bolus',label:'Dexmedetomidine',     sub:'Bolus',              showDose:false},
    {key:'dexmedetomidine',      label:'Dexmedetomidine',     sub:'Infusion',           showDose:false,infusion:true},
  ],
  opioids:[
    {key:'fentanyl',             label:'Fentanyl',            sub:'IV push',            showDose:false},
    {key:'morphine',             label:'Morphine',            sub:'IV push',            showDose:false},
    {key:'remifentanil',         label:'Remifentanil',        sub:'Infusion',           showDose:false,infusion:true},
    {key:'naloxone',             label:'Naloxone',            sub:'Reversal',           showDose:false},
  ],
  nmb:[
    {key:'succinylcholine',      label:'Succinylcholine',     sub:'Depolarizing',       showDose:false},
    {key:'rocuronium',           label:'Rocuronium',          sub:'Non-depolarizing',   showDose:false},
    {key:'vecuronium',           label:'Vecuronium',          sub:'Non-depolarizing',   showDose:false},
    {key:'sugammadex',           label:'Sugammadex',          sub:'Reversal',           showDose:false},
    {key:'neostigmine',          label:'Neostigmine',         sub:'Reversal',           showDose:false},
  ],
  cardiac:[
    {key:'atropine',             label:'Atropine',            sub:'Chronotrope',        showDose:false},
    {key:'glycopyrrolate',       label:'Glycopyrrolate',      sub:'Chronotrope',        showDose:false},
    {key:'adenosine',            label:'Adenosine',           sub:'SVT',                showDose:false},
    {key:'amiodarone_arrest',    label:'Amiodarone',          sub:'Arrest (300mg push)',showDose:false},
    {key:'amiodarone_infusion',  label:'Amiodarone',          sub:'Perfusing (150mg)',  showDose:false},
    {key:'lidocaine',            label:'Lidocaine',           sub:'Antiarrhythmic',     showDose:false},
    {key:'magnesium',            label:'Magnesium',           sub:'TdP/Bronchospasm',   showDose:false},
    {key:'calcium_chloride',     label:'Calcium Chloride',    sub:'Resuscitation',      showDose:false},
    {key:'sodium_bicarb',        label:'Sodium Bicarb',       sub:'Resuscitation',      showDose:false},
  ],
  fluids:[
    {key:'fluid_bolus',          label:'Fluid Bolus',         sub:'NS/LR',              showDose:false},
    {key:'blood',                label:'pRBC',                sub:'Blood product',      showDose:false},
    {key:'albuterol',            label:'Albuterol',           sub:'Inhaled',            showDose:false},
    {key:'diphenhydramine',      label:'Diphenhydramine',     sub:'Antihistamine',      showDose:false},
    {key:'methylprednisolone',   label:'Methylprednisolone',  sub:'Steroid',            showDose:false},
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
global.MedSimCore = {
  S:S, P:P,
  give:give,
  startInfusion:startInfusion,
  stopInfusion:stopInfusion,
  step:step,
  clamp:clamp,
  effectCurve:effectCurve,
  setPatient:setPatient,
  setPatientAge:setPatientAge,
  getMode:function(){return P.mode;},
  getWeight:function(){return P.weight;},
  ageNorms:ageNorms,
  applyVentModeChange:applyVentModeChange,
  applyBronchospasmPhysiology:applyBronchospasmPhysiology,
  setPreoxygenated:function(v){_preoxygenated=v;},
  trSet:function(){}, // stub — no longer used but kept for backward compat
  trClear:function(){_activeEffects=[];},
  on:on, off:off,
  CATALOG:CATALOG,
  DRUGS:DRUGS,
  version:'2.0'
};

})(typeof window!=='undefined'?window:global);
