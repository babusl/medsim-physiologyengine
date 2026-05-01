// ═══════════════════════════════════════════════════════════════════════════════
//  medsim-physiologyengine.js  —  MedSim Physiologic Engine + Drug Library
//  Version: 1.1
//  All drug effects, onset/peak/offset curves, and physiologic state model
//  live here. Monitor, vent, and controllers load this file and call into it.
//
//  ARCHITECTURE:
//    - MedSimCore.S        : live physiologic state (HR, BP, SpO2, etc.)
//    - MedSimCore.P        : patient parameters (age, weight, mode)
//    - MedSimCore.give()   : give a drug or intervention
//    - MedSimCore.step(dt) : advance simulation by dt seconds (call each frame)
//    - MedSimCore.on()     : event callbacks (state changed, alarm, etc.)
//
//  TO UPDATE DRUG PHYSIOLOGY:
//    Edit this file only. Upload to babusl.github.io/medsimcore/medsim-physiologyengine.js
//    All tools reload it automatically. No other files need updating.
// ═══════════════════════════════════════════════════════════════════════════════

(function(global){
'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  PATIENT PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════
var P = {
  mode:    'adult',    // 'adult' | 'peds'
  weight:  70,         // kg — used for weight-based dosing
  age:     35,         // years
  // Baseline vitals (set when patient mode changes or scenario loads)
  baseline: { hr:72, sbp:120, dbp:80, spo2:98, rr:14, etco2:35 }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  PHYSIOLOGIC STATE
// ═══════════════════════════════════════════════════════════════════════════════
var S = {
  // ── Hemodynamics ──
  hr:72, sbp:120, dbp:80, spo2:98, rr:14, etco2:35, temp:37.0,
  // ── Rhythm ──
  rhythm:'NSR',
  // ── Derived / display ──
  map: function(){ return Math.round(S.dbp + (S.sbp-S.dbp)/3); },
  // ── Vent ──
  ventMode:'VCV', rr_set:14, tv:450, peep:5, ps:10, fio2:50,
  ie:2.0, pipLimit:40, apl:30,
  compliance:50, resistance:5, ventPath:'normal',
  flowRate:40, riseTime:25, triggerSens:-2,
  // ── Physiology flags ──
  etco2On:    true,
  artLine:    false,
  _paralyzed: false,
  _nmbSavedRR:14,
  // ── Internal physiologic variables (Level 2 model) ──
  _svr:     1200,   // systemic vascular resistance (dyne·s/cm5) — normal 800-1200
  _co:      5.0,    // cardiac output (L/min) — normal 4-8
  _preload: 1.0,    // relative preload (1.0 = normal)
  _inotropy:1.0,    // relative contractility (1.0 = normal)
  // ── Active drug effects (multiple can stack) ──
  _effects: [],     // [{id, key, delta, timeLeft, duration, onset, peak}]
  _infusions:{}     // {drugName: {dose, effect}}
};

// ═══════════════════════════════════════════════════════════════════════════════
//  TRANSITION SYSTEM (smooth value changes over time)
// ═══════════════════════════════════════════════════════════════════════════════
var TR = {};   // {key: {target, rate}}

// Rates = units per second. IV push peaks in ~8-10s, infusion over ~90s.
var RATES = {
  iv:       {hr:8.0, sbp:8.0, dbp:6.0, spo2:2.5, etco2:2.5, rr:2.0}, // peak ~5-8s (IV push)
  push:     {hr:2.5, sbp:3.5, dbp:2.8, spo2:1.2, etco2:1.5, rr:1.0}, // peak ~15-20s (IM/slower)
  infusion: {hr:0.35,sbp:0.55,dbp:0.40,spo2:0.25,etco2:0.25,rr:0.18},// ~60-90s
  fluid:    {hr:0.25,sbp:0.40,dbp:0.30,spo2:0.20,etco2:0.20,rr:0.15},// 3-5 min
  path:     {hr:0.9, sbp:0.9, dbp:0.7, spo2:0.5, etco2:0.5, rr:0.4},
  laryngo:  {hr:0.9, sbp:0.9, dbp:0.7, spo2:2.0, etco2:0.5, rr:0.4},
  laryngo2: {hr:2.5, sbp:2.0, dbp:1.2, spo2:0.4, etco2:0.3, rr:0.2},
  slow:     {hr:0.2, sbp:0.3, dbp:0.25,spo2:0.15,etco2:0.15,rr:0.12} // morphine
};

function trSet(targets, mode){
  var rates = RATES[mode] || RATES.iv;
  Object.keys(targets).forEach(function(k){
    TR[k] = {target:targets[k], rate:rates[k]||1.0};
  });
}

function trClear(){ TR = {}; }

// ═══════════════════════════════════════════════════════════════════════════════
//  DRUG LIBRARY
//  Each drug defines:
//    mode:     'iv' | 'push' | 'infusion' | 'fluid' | 'slow'
//    onset:    seconds before any effect visible (arm-brain circ time)
//    nmb:      true = neuromuscular blockade
//    effects:  function(dose, weight, patientMode) → {hr, sbp, dbp, spo2, rr, etco2}
//              Returns DELTAS from current state (+ or -)
//    offset:   function(dose) → seconds until effect wears off
//    notes:    clinical notes (not used in logic)
// ═══════════════════════════════════════════════════════════════════════════════
var DRUGS = {

  // ─────────────────────────────────────────────────────────────────────────────
  //  VASOPRESSORS
  // ─────────────────────────────────────────────────────────────────────────────

  phenylephrine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Pure α1: SVR ↑ → MAP ↑
      // Reflex brady is PROPORTIONAL to BP rise — same rate, fully linked
      // Adults: significant reflex brady. Peds: minimal.
      var bpRise = Math.min(40, dose * 0.22);   // 100mcg → ~22 mmHg SBP, ceiling 40
      var hrDrop = mode==='peds'
        ? Math.round(bpRise * 0.08)   // peds: minimal reflex
        : Math.round(bpRise * 0.55);  // adults: 55% of BP rise reflected in HR drop
      // Both BP and HR use same 'iv' rate so they move together
      return { sbp: bpRise, dbp: Math.round(bpRise*0.55), hr: -hrDrop };
    },
    offset: function(dose){ return 300; } // ~5 min
  },

  norepinephrine_bolus: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // α1 >> β1: SVR ↑↑, MAP ↑↑, slight HR ↑ (less than epi, more than phenyl)
      var bpRise = Math.min(45, dose * 0.25);
      return { sbp: bpRise, dbp: Math.round(bpRise*0.65), hr: Math.round(bpRise*0.08) };
    },
    offset: function(){ return 240; }
  },

  norepinephrine: {  // infusion
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // dose in mcg/kg/min
      // 0.05 = mild, 0.1 = moderate, 0.3+ = high
      var intensity = Math.min(1.0, dose / 0.15);
      var bpRise = Math.round(intensity * 38);
      return { sbp: bpRise, dbp: Math.round(bpRise*0.65), hr: Math.round(bpRise*0.06) };
    }
  },

  epinephrine_push: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // dose in mcg. α1+β1+β2. "Rocket fuel."
      // 10mcg: HR ↑ 20-30, SBP ↑ 25-35
      // 50mcg: HR ↑ 45-60 (low 100s from baseline 70s), SBP ↑ 50-70
      // 100mcg+: HR into 120-140s, SBP ↑ 70-90
      var intensity = Math.min(1.0, dose / 50);
      return {
        hr:  Math.round(20 + intensity * 55),   // 20 at 10mcg → 75 at 50mcg
        sbp: Math.round(25 + intensity * 55),
        dbp: Math.round(10 + intensity * 22)
      };
    },
    offset: function(dose){ return 180; } // ~3 min
  },

  epinephrine_code: {  // 1mg IV push, cardiac arrest
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Massive α1+β1 — in arrest context drives coronary perfusion pressure
      // If ROSC: HR shoots up, BP surges
      return { sbp:55, dbp:28, hr:45 };
    },
    offset: function(){ return 240; }
  },

  epinephrine: {  // infusion, mcg/kg/min
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // Low dose (0.01-0.05): β dominant — HR ↑, CO ↑, SVR mildly ↓ or neutral
      // High dose (0.1-0.5):  α dominant — SVR ↑↑, BP ↑↑, HR ↑↑
      var intensity = Math.min(1.0, dose / 0.2);
      return {
        hr:  Math.round(12 + intensity * 35),
        sbp: Math.round(10 + intensity * 55),
        dbp: Math.round(4  + intensity * 20)
      };
    }
  },

  vasopressin_bolus: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Peds: 0.01-0.03 U/kg IV. Adults: 0.5-2 U IV
      // V1: direct vasoconstriction. BP ↑↑, HR unchanged (no baroreceptor reflex)
      // dose in units (or U/kg for peds)
      var intensity = mode==='peds'
        ? Math.min(1.0, dose / 0.02)   // 0.02 U/kg = full effect
        : Math.min(1.0, dose / 1.0);   // 1U = moderate, 2U = full
      return {
        sbp: Math.round(25 + intensity * 20),
        dbp: Math.round(12 + intensity * 10),
        hr:  0  // vasopressin does not change HR
      };
    },
    offset: function(){ return 600; } // ~10 min
  },

  vasopressin: {  // infusion, units/hr or mU/kg/hr for peds
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // Peds: 12-30 mU/kg/hr. Adults: 1.2-2.4 U/hr
      var intensity = mode==='peds'
        ? Math.min(1.0, dose / 20)   // 20 mU/kg/hr = full
        : Math.min(1.0, dose / 2.0); // 2 U/hr = full
      return { sbp: Math.round(intensity * 28), dbp: Math.round(intensity * 12), hr: 0 };
    }
  },

  ephedrine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // "Weak epi" — more HR bump than norepi or phenyl
      // 10mg adult dose: HR ↑ 10-18, BP ↑ 12-20
      var intensity = Math.min(1.0, dose / 10);
      return {
        hr:  Math.round(intensity * 16),
        sbp: Math.round(intensity * 18),
        dbp: Math.round(intensity * 8)
      };
    },
    offset: function(){ return 600; } // ~10 min
  },

  dopamine: {  // infusion, mcg/kg/min. Min dose 5.
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // 5-10: β1 — HR ↑, CO ↑
      // 10-20: α1 — SVR ↑, BP ↑↑
      var beta  = Math.min(1.0, Math.max(0, (dose-5)/5));   // 0 at 5, 1.0 at 10
      var alpha = Math.min(1.0, Math.max(0, (dose-10)/10)); // 0 at 10, 1.0 at 20
      return {
        hr:  Math.round(beta*18 + alpha*10),
        sbp: Math.round(beta*8  + alpha*30),
        dbp: Math.round(beta*3  + alpha*14)
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  INDUCTION AGENTS
  // ─────────────────────────────────────────────────────────────────────────────

  propofol: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Vasodilation + mild negative inotropy → BP ↓↓
      // HR: inconsistent, no reliable change — model as 0
      // Dose dependent: 2mg/kg standard, 5mg/kg large
      var intensity = Math.min(1.0, dose / (weight * 2.0));
      var bpDrop = Math.round(25 + intensity * 20); // 25-45 mmHg SBP drop
      return { sbp: -bpDrop, dbp: -Math.round(bpDrop*0.55), hr: 0, rr: -14 };
      // rr: -14 causes apnea (rr → 0 from 14 baseline)
    },
    offset: function(dose){ return 300; }
  },

  ketamine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Sympathomimetic but mild — not like a pressor
      // HR ↑ mild, BP ↑ mild
      var intensity = Math.min(1.0, dose / (weight * 2.0));
      return {
        hr:  Math.round(8  + intensity * 10),
        sbp: Math.round(10 + intensity * 12),
        dbp: Math.round(4  + intensity * 5)
      };
    },
    offset: function(dose){ return 600; }
  },

  etomidate: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Hemodynamically neutral. Apnea.
      return { hr:0, sbp:0, dbp:0, rr:-14 };
    },
    offset: function(){ return 300; }
  },

  midazolam: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // No hemodynamic effect. Mild respiratory depression.
      var rrDrop = mode==='peds' ? -4 : -3;
      return { hr:0, sbp:0, dbp:0, rr: rrDrop };
    },
    offset: function(){ return 1200; } // 20 min
  },

  dexmedetomidine_bolus: {
    mode: 'push',
    effects: function(dose, weight, mode){
      // Large bolus: transient HTN then reflex brady
      // Model: BP ↑ first (vasoconstriction), then HR ↓
      // Simplified to net effect: HR ↓, BP mildly ↓ or neutral
      return { hr: -14, sbp: -8, dbp: -5 };
    },
    offset: function(){ return 600; }
  },

  dexmedetomidine: {  // infusion, mcg/kg/hr
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // 0.2-1.5 mcg/kg/hr
      var intensity = Math.min(1.0, dose / 1.0);
      return {
        hr:  -Math.round(intensity * 18),
        sbp: -Math.round(intensity * 14),
        dbp: -Math.round(intensity * 8)
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  OPIOIDS
  // ─────────────────────────────────────────────────────────────────────────────

  fentanyl: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Adults: 50-250mcg (50mcg increments)
      // Peds: 1-2 mcg/kg
      // Mild bradycardia (vagal), mild BP ↓, RR ↓ dose dependent
      var mcgPerKg = dose / weight;
      var intensity = Math.min(1.0, mcgPerKg / 3.0);
      return {
        hr:  -Math.round(4 + intensity * 8),
        sbp: -Math.round(3 + intensity * 10),
        dbp: -Math.round(2 + intensity * 5),
        rr:  -Math.round(2 + intensity * 8)
      };
    },
    offset: function(dose){ return 1800; } // 30 min
  },

  morphine: {
    mode: 'slow',  // slower onset — few minutes, peak 10-15 min
    effects: function(dose, weight, mode){
      // Histamine → vasodilation → BP ↓, HR ↑ mild
      // RR ↓
      var mcgPerKg = (dose*1000) / weight; // dose in mg
      var intensity = Math.min(1.0, dose / 10);
      return {
        hr:  Math.round(3 + intensity * 5),
        sbp: -Math.round(4 + intensity * 12),
        dbp: -Math.round(2 + intensity * 6),
        rr:  -Math.round(2 + intensity * 6)
      };
    },
    offset: function(){ return 3600; } // 60 min
  },

  remifentanil: {  // infusion, mcg/kg/min
    mode: 'infusion',
    effects: function(dose, weight, mode){
      // 0.03-0.4 mcg/kg/min
      var intensity = Math.min(1.0, dose / 0.2);
      return {
        hr:  -Math.round(intensity * 16),
        sbp: -Math.round(intensity * 18),
        dbp: -Math.round(intensity * 10),
        rr:  -Math.round(intensity * 10)
      };
    }
  },

  naloxone: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Opioid reversal — restore RR, HR, BP toward normal
      // Model as positive correction
      return { rr: 12, hr: 5, sbp: 8, dbp: 4 };
    },
    offset: function(){ return 1200; }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  NEUROMUSCULAR BLOCKADE
  // ─────────────────────────────────────────────────────────────────────────────

  succinylcholine: {
    mode: 'iv',
    nmb: true,
    onsetSeconds: 25, // 20-30s
    effects: function(dose, weight, mode){
      // Brady only in babies with large doses — not modeled for adults/older peds
      // Apnea is handled separately via NMB flag
      var hrDelta = 0;
      if(mode==='peds' && weight < 8 && dose/weight > 2.5){
        hrDelta = -10; // infant bradycardia, large dose
      }
      return { hr: hrDelta };
    },
    offset: function(dose){ return 480; } // ~8 min depolarizing
  },

  rocuronium: {
    mode: 'iv',
    nmb: true,
    onsetSeconds: function(dose, weight){
      var mgPerKg = dose / weight;
      return mgPerKg >= 1.0 ? 35 : 120; // RSI: 30-40s; standard 0.6: ~2 min
    },
    effects: function(dose, weight, mode){
      return { hr: 0 }; // hemodynamically neutral
    },
    offset: function(dose, weight){
      var mgPerKg = dose / weight;
      return mgPerKg >= 1.0 ? 3600 : 1800; // RSI dose longer duration
    }
  },

  vecuronium: {
    mode: 'iv',
    nmb: true,
    onsetSeconds: 120, // few minutes
    effects: function(dose, weight, mode){
      return { hr: 0 }; // hemodynamically neutral
    },
    offset: function(){ return 1800; }
  },

  sugammadex: {
    mode: 'iv',
    nmbReversal: true,
    // Doses: 2mg/kg moderate, 4mg/kg deep, 16mg/kg immediate RSI reversal
    onsetSeconds: 45, // 30-60s
    effects: function(dose, weight, mode){
      // Rare bradycardia — model as very mild
      return { hr: -2 };
    },
    offset: function(){ return 3600; }
  },

  neostigmine: {
    mode: 'push',
    nmbReversal: true,
    onsetSeconds: 60,
    effects: function(dose, weight, mode){
      // Must be given with glycopyrrolate/atropine to prevent bradycardia
      return { hr: -5 };
    },
    offset: function(){ return 3600; }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  CHRONOTROPES / ANTICHOLINERGICS
  // ─────────────────────────────────────────────────────────────────────────────

  atropine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // Peds: 0.02mg/kg. Adults: 0.5mg standard.
      // HR ↑, mild BP ↑ from increased CO
      // Very low doses: paradoxical brady — don't model (too rare/complex)
      var mgPerKg = dose / weight;
      var intensity = mode==='peds'
        ? Math.min(1.0, mgPerKg / 0.02)
        : Math.min(1.0, dose / 0.5);
      return {
        hr:  Math.round(15 + intensity * 25), // 15-40 bpm ↑
        sbp: Math.round(3  + intensity * 8),
        dbp: Math.round(1  + intensity * 4)
      };
    },
    offset: function(){ return 1200; }
  },

  glycopyrrolate: {
    mode: 'push',  // slower than atropine
    effects: function(dose, weight, mode){
      var intensity = Math.min(1.0, dose / 0.2);
      return {
        hr:  Math.round(8 + intensity * 15),
        sbp: Math.round(2 + intensity * 5),
        dbp: Math.round(1 + intensity * 2)
      };
    },
    offset: function(){ return 1800; }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ANTIARRHYTHMICS
  // ─────────────────────────────────────────────────────────────────────────────

  adenosine: {
    mode: 'iv',
    adenosine: true, // special flag — causes transient asystole
    effects: function(dose, weight, mode){
      return {}; // effect handled specially in give()
    }
  },

  amiodarone_arrest: {  // 300mg IV push in arrest
    mode: 'iv',
    effects: function(dose, weight, mode){
      return { hr: -8 }; // minimal hemodynamic in arrest context
    }
  },

  amiodarone_infusion: {  // 150mg over 10 min, perfusing rhythm
    mode: 'push',
    effects: function(dose, weight, mode){
      // HR ↓ gradual, BP ↓ mild (vehicle effect)
      return { hr: -12, sbp: -8, dbp: -4 };
    },
    offset: function(){ return 7200; }
  },

  lidocaine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // 1-2mg/kg. No hemodynamic changes at therapeutic doses.
      return {};
    },
    offset: function(){ return 900; }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  FLUIDS
  // ─────────────────────────────────────────────────────────────────────────────

  fluid_bolus: {
    mode: 'fluid',
    effects: function(dose, weight, mode){
      // dose in mL. Peds: 10-20 mL/kg. Adults: 500-1000mL.
      // Effect depends on volume status (preload state).
      // If tachycardic from hypovolemia: HR ↓ as preload improves.
      // Max fluid effect — additional fluid doesn't keep helping.
      var normalDose = mode==='peds' ? weight*15 : 500;
      var intensity = Math.min(1.0, dose / normalDose);
      // Preload-dependent effect
      var preloadBonus = Math.max(0, 1.2 - S._preload); // more effect if depleted
      var effectScale = Math.min(1.5, intensity * (1.0 + preloadBonus));
      // Update preload
      S._preload = Math.min(1.4, S._preload + intensity * 0.2);
      var hrDrop = S.hr > 100 ? -Math.round(effectScale * 14) : -Math.round(effectScale * 4);
      return {
        hr:  hrDrop,
        sbp: Math.round(effectScale * 12),
        dbp: Math.round(effectScale * 6),
        etco2: Math.round(effectScale * 3)
      };
    }
  },

  blood: {
    mode: 'fluid',
    effects: function(dose, weight, mode){
      // Units of pRBC. Improves O2 carrying capacity + preload.
      var intensity = Math.min(1.0, dose / 2.0);
      S._preload = Math.min(1.4, S._preload + intensity * 0.25);
      return {
        hr:  -Math.round(intensity * 12),
        sbp: Math.round(intensity * 14),
        dbp: Math.round(intensity * 7),
        spo2:Math.round(intensity * 4)
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  AIRWAY / BRONCHODILATORS
  // ─────────────────────────────────────────────────────────────────────────────

  albuterol: {
    mode: 'iv', // same fast transition — enters lungs quickly when inhaled
    effects: function(dose, weight, mode){
      // β2: bronchodilation (handled via ventPath change), β1 spillover: HR ↑ mild
      return {
        hr: 8,
        // Vent mechanics improved — set compliance/resistance directly
        _vent: { resistance: Math.max(5, S.resistance - 15), compliance: Math.min(50, S.compliance + 8) }
      };
    },
    offset: function(){ return 1200; } // 20 min, then possible bronchospasm return
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ELECTROLYTES / RESUSCITATION
  // ─────────────────────────────────────────────────────────────────────────────

  calcium_chloride: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // 1g IV. Positive inotropy. Used for hyperkalemia, Ca-channel OD.
      return { hr: 5, sbp: 10, dbp: 5 };
    },
    offset: function(){ return 1200; }
  },

  sodium_bicarb: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // 1 mEq/kg. Minimal hemodynamic effect.
      return { hr: 2 };
    },
    offset: function(){ return 900; }
  },

  magnesium: {
    mode: 'push',
    effects: function(dose, weight, mode){
      // 2g IV. For TdP. Mild vasodilation, mild HR ↓.
      return { hr: -4, sbp: -5, dbp: -3 };
    },
    offset: function(){ return 1800; }
  },

  diphenhydramine: {
    mode: 'iv',
    effects: function(dose, weight, mode){
      // H1 blocker. Mild sedation, minimal hemodynamic.
      return { hr: 3, sbp: -3, dbp: -2 };
    },
    offset: function(){ return 3600; }
  },

  methylprednisolone: {
    mode: 'push',
    effects: function(dose, weight, mode){
      // Steroid. No acute hemodynamic effect. Prevents biphasic reaction.
      return {};
    },
    offset: function(){ return 14400; }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  PROCEDURES (non-drug interventions)
  // ─────────────────────────────────────────────────────────────────────────────

  intubation: {
    mode: 'iv',
    procedure: true,
    effects: function(dose, weight, mode){
      // Confirm ETT → EtCO2 ON, RR follows vent set rate
      var out = { etco2: S.etco2 < 20 ? 28 : S.etco2 };
      if(S._paralyzed){ out.rr = S.rr_set || 12; }
      else { out.rr = S.rr_set || 12; }
      return out;
    }
  },

  defibrillation: {
    procedure: true,
    effects: function(dose, weight, mode){
      // 200J. Converts VFib → NSR (probabilistic). Handled in rhythm logic.
      return {};
    }
  },

  cardioversion: {
    procedure: true,
    effects: function(dose, weight, mode){
      // Synchronized. Converts VTach/SVT/AFib → NSR.
      return {};
    }
  },

  cpr: {
    procedure: true,
    effects: function(active){
      if(active){
        return { sbp: 55, dbp: 20, etco2: 14 }; // CPR perfusion pressure
      }
      return { sbp: 0, dbp: 0, etco2: 0 };
    }
  },

  needle_decompression: {
    procedure: true,
    effects: function(dose, weight, mode){
      // Tension PTX relief — rapid improvement
      if(S.ventPath==='pneumothorax'){
        return {
          spo2: Math.min(98, S.spo2 + 18),
          sbp:  Math.min(120, S.sbp + 30),
          hr:   Math.max(75, S.hr - 28),
          _vent:{ compliance: 48, resistance: 6 }
        };
      }
      return {};
    }
  }

};

// ═══════════════════════════════════════════════════════════════════════════════
//  NMB LOGIC — called when any NMB drug is given
// ═══════════════════════════════════════════════════════════════════════════════
function applyNMB(drugKey, dose, weight){
  S._paralyzed = true;
  S._nmbSavedRR = S.rr_set || 14;
  if(S.ventMode === 'Manual'){
    // Not on vent — apnea, EtCO2 disappears
    trSet({ rr:0, etco2:0 }, 'iv');
  }
  // If on vent — machine breathes, rr_set unchanged, EtCO2 maintained
  // Succinylcholine infant brady
  var drug = DRUGS[drugKey];
  if(drug && drug.effects){
    var hemoDelta = drug.effects(dose, weight, P.mode);
    if(hemoDelta.hr){ trSet({hr: Math.max(30, S.hr + hemoDelta.hr)}, 'iv'); }
  }
}

function applyNMBReversal(){
  S._paralyzed = false;
  if(S.ventMode === 'Manual'){
    // Restore spontaneous breathing
    trSet({ rr: S._nmbSavedRR || 12 }, 'iv');
    if(S.etco2 < 5) trSet({ etco2: 32 }, 'iv');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADENOSINE SPECIAL LOGIC
// ═══════════════════════════════════════════════════════════════════════════════
function applyAdenosine(dose){
  // Transient asystole 3-6 seconds then rhythm check
  var wasRhythm = S.rhythm;
  S.rhythm = 'Asystole';
  S.hr = 0; S.sbp = 0; S.dbp = 0;
  _emit('state');
  setTimeout(function(){
    // If SVT — convert to NSR
    if(wasRhythm === 'SVT'){
      S.rhythm = 'NSR';
      S.hr = 78;
      trSet({ sbp:112, dbp:70 }, 'iv');
    } else {
      S.rhythm = wasRhythm; // didn't convert — return to same rhythm
      S.hr = S.hr || 72;
    }
    _emit('state');
  }, 4000 + Math.random()*2000);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VENTMODE CHANGE LOGIC
// ═══════════════════════════════════════════════════════════════════════════════
function applyVentModeChange(prevMode, newMode){
  if(!S._paralyzed) return;
  if(newMode === 'Manual' && prevMode !== 'Manual'){
    // Switched to manual while paralyzed — no one squeezing bag
    trSet({ rr:0, etco2:0 }, 'iv');
  } else if(newMode !== 'Manual' && prevMode === 'Manual'){
    // Switched from manual to vent while paralyzed — machine takes over
    trSet({ rr: S.rr_set||12, etco2: Math.max(S.etco2||0, 28) }, 'iv');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INFUSION MANAGER
//  Handles ongoing infusion effects — drug keeps working until stopped
// ═══════════════════════════════════════════════════════════════════════════════
var _infusions = {};   // {name: {drug, dose, weight, target}}
var _infusionRamp = {}; // ramp up timer per infusion

function startInfusion(name, drugKey, dose, weight){
  var drug = DRUGS[drugKey];
  if(!drug || drug.mode !== 'infusion') return;
  _infusions[name] = { drugKey:drugKey, dose:dose, weight:weight||P.weight };
  _infusionRamp[name] = 0; // seconds since started
}

function stopInfusion(name){
  delete _infusions[name];
  delete _infusionRamp[name];
}

function stepInfusions(dt){
  Object.keys(_infusions).forEach(function(name){
    var inf = _infusions[name];
    _infusionRamp[name] = (_infusionRamp[name]||0) + dt;
    var ramp = Math.min(1.0, _infusionRamp[name] / 60); // full effect at 60s
    var drug = DRUGS[inf.drugKey];
    if(!drug) return;
    var delta = drug.effects(inf.dose, inf.weight||P.weight, P.mode);
    // Apply as continuous gentle pull toward target
    Object.keys(delta).forEach(function(k){
      if(k.startsWith('_')) return;
      var target = (P.baseline[k]||S[k]) + delta[k] * ramp;
      if(!TR[k] || Math.abs(TR[k].target - target) > 1){
        TR[k] = { target: Math.round(target), rate: RATES.infusion[k]||0.3 };
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN give() FUNCTION — called when any drug or intervention is given
// ═══════════════════════════════════════════════════════════════════════════════
function give(drugKey, dose, opts){
  opts = opts || {};
  var weight = opts.weight || P.weight;
  var drug = DRUGS[drugKey];
  if(!drug){ console.warn('medsimcore: unknown drug', drugKey); return; }

  // NMB drugs
  if(drug.nmb){ applyNMB(drugKey, dose, weight); return; }

  // NMB reversal
  if(drug.nmbReversal){ applyNMBReversal(); return; }

  // Adenosine special
  if(drug.adenosine){ applyAdenosine(dose); return; }

  // Procedures
  if(drug.procedure){
    var delta = drug.effects(dose, weight, P.mode);
    _applyDelta(delta, 'iv');
    return;
  }

  // Standard drugs
  var delta = drug.effects(dose, weight, P.mode);
  var mode = drug.mode || 'iv';

  // Vent mechanics change
  if(delta._vent){
    Object.assign(S, delta._vent);
    delete delta._vent;
    _emit('vent');
  }

  // Build absolute targets from current state + delta
  var targets = {};
  Object.keys(delta).forEach(function(k){
    if(k.startsWith('_')) return;
    var current = S[k] || 0;
    targets[k] = clampKey(k, current + delta[k]);
  });

  trSet(targets, mode);
  _emit('state');
}

function _applyDelta(delta, mode){
  var targets = {};
  Object.keys(delta).forEach(function(k){
    if(k.startsWith('_')) return;
    targets[k] = clampKey(k, (S[k]||0) + delta[k]);
  });
  trSet(targets, mode);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLAMPING
// ═══════════════════════════════════════════════════════════════════════════════
var CLAMPS = {
  hr:    [0,   300],
  sbp:   [0,   280],
  dbp:   [0,   180],
  spo2:  [0,   100],
  rr:    [0,    60],
  etco2: [0,    80],
  temp:  [30,   42]
};

function clampKey(k, v){
  var c = CLAMPS[k];
  if(!c) return v;
  return Math.max(c[0], Math.min(c[1], v));
}

function clamp(){
  Object.keys(CLAMPS).forEach(function(k){
    if(S[k]!=null) S[k] = clampKey(k, S[k]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP — called every animation frame (dt = seconds since last call)
// ═══════════════════════════════════════════════════════════════════════════════
var _trThrottle = 0;
var _laryngoPhase = 0;

function step(dt){
  // Advance transitions
  var changed = false;
  Object.keys(TR).forEach(function(k){
    var t = TR[k];
    var diff = t.target - S[k];
    var stepAmt = t.rate * dt;
    if(Math.abs(diff) <= stepAmt){ S[k] = t.target; delete TR[k]; }
    else { S[k] += Math.sign(diff) * stepAmt; }
    changed = true;
  });

  // Laryngospasm physiology
  if(_laryngoPhase >= 1 && S.spo2 < 70){
    var t = Math.min(1, Math.max(0, (70 - S.spo2) / 40));
    var isPeds = P.mode === 'peds';
    // Peds: HR drops fast. Adults: HR drops slower.
    var hrFloor = isPeds ? 20 : 40;
    var hrRoof  = isPeds ? 95 : 90;
    TR['hr']  = { target: Math.round(hrRoof - (hrRoof-hrFloor)*t),  rate: isPeds ? 3.5 : 2.5 };
    TR['sbp'] = { target: Math.round(110   - (110-35)*t),           rate: RATES.laryngo2.sbp };
    TR['dbp'] = { target: Math.round(70    - (70-12)*t),            rate: RATES.laryngo2.dbp };
    changed = true;
  }

  // EtCO2 recovery after ROSC
  var perfusing = !(S.rhythm==='VFib'||S.rhythm==='Asystole'||S.rhythm==='PEA');
  if(perfusing && S.sbp>=50 && S.rr>0 && S.etco2<5 && !TR['etco2']){
    TR['etco2'] = { target: P.baseline.etco2||35, rate: RATES.iv.etco2 * 2.5 };
    changed = true;
  }

  // Step infusions
  stepInfusions(dt);

  if(changed){ clamp(); }

  // Throttle state emit
  _trThrottle += dt;
  if(_trThrottle >= 0.5 && changed){
    _trThrottle = 0;
    _emit('state');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PATIENT MODE TOGGLE (adult ↔ peds)
// ═══════════════════════════════════════════════════════════════════════════════
function setPatient(opts){
  opts = opts || {};
  P.mode   = opts.mode   || P.mode;
  P.weight = opts.weight || P.weight;
  P.age    = opts.age    || P.age;
  if(opts.baseline) P.baseline = Object.assign({}, P.baseline, opts.baseline);
  _emit('patient');
}

function getMode(){ return P.mode; }
function getWeight(){ return P.weight; }

// ═══════════════════════════════════════════════════════════════════════════════
//  LARYNGOSPASM CONTROL
// ═══════════════════════════════════════════════════════════════════════════════
function setLaryngoPhase(phase){ _laryngoPhase = phase; }

// ═══════════════════════════════════════════════════════════════════════════════
//  EVENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
var _listeners = {};
function on(event, fn){ _listeners[event] = _listeners[event]||[]; _listeners[event].push(fn); }
function off(event, fn){ if(_listeners[event]) _listeners[event]=_listeners[event].filter(function(f){return f!==fn;}); }
function _emit(event){ (_listeners[event]||[]).forEach(function(fn){ try{fn(S,P);}catch(e){} }); }

// ═══════════════════════════════════════════════════════════════════════════════
//  DRUG CATALOG — for UI display (doses, names, categories)
//  NOTE: Dosing display intentionally omitted until reviewed clinically.
//        Set showDose:true when ready to display.
// ═══════════════════════════════════════════════════════════════════════════════
var CATALOG = {
  vasopressors: [
    {key:'epinephrine_push',    label:'Epinephrine',       sub:'Push-dose pressor', showDose:false},
    {key:'epinephrine_code',    label:'Epinephrine',       sub:'Code dose 1mg',     showDose:false},
    {key:'epinephrine',         label:'Epinephrine',       sub:'Infusion',          showDose:false, infusion:true},
    {key:'phenylephrine',       label:'Phenylephrine',     sub:'IV push',           showDose:false},
    {key:'norepinephrine',      label:'Norepinephrine',    sub:'Infusion',          showDose:false, infusion:true},
    {key:'vasopressin_bolus',   label:'Vasopressin',       sub:'IV bolus',          showDose:false},
    {key:'vasopressin',         label:'Vasopressin',       sub:'Infusion',          showDose:false, infusion:true},
    {key:'ephedrine',           label:'Ephedrine',         sub:'IV push',           showDose:false},
    {key:'dopamine',            label:'Dopamine',          sub:'Infusion',          showDose:false, infusion:true},
  ],
  induction: [
    {key:'propofol',            label:'Propofol',          sub:'Induction',         showDose:false},
    {key:'ketamine',            label:'Ketamine',          sub:'Induction',         showDose:false},
    {key:'etomidate',           label:'Etomidate',         sub:'Induction',         showDose:false},
    {key:'midazolam',           label:'Midazolam',         sub:'Sedation',          showDose:false},
    {key:'dexmedetomidine_bolus',label:'Dexmedetomidine',  sub:'Bolus',             showDose:false},
    {key:'dexmedetomidine',     label:'Dexmedetomidine',   sub:'Infusion',          showDose:false, infusion:true},
  ],
  opioids: [
    {key:'fentanyl',            label:'Fentanyl',          sub:'IV push',           showDose:false},
    {key:'morphine',            label:'Morphine',          sub:'IV push',           showDose:false},
    {key:'remifentanil',        label:'Remifentanil',      sub:'Infusion',          showDose:false, infusion:true},
    {key:'naloxone',            label:'Naloxone',          sub:'Reversal',          showDose:false},
  ],
  nmb: [
    {key:'succinylcholine',     label:'Succinylcholine',   sub:'Depolarizing',      showDose:false},
    {key:'rocuronium',          label:'Rocuronium',        sub:'Non-depolarizing',  showDose:false},
    {key:'vecuronium',          label:'Vecuronium',        sub:'Non-depolarizing',  showDose:false},
    {key:'sugammadex',          label:'Sugammadex',        sub:'Reversal',          showDose:false},
    {key:'neostigmine',         label:'Neostigmine',       sub:'Reversal',          showDose:false},
  ],
  cardiac: [
    {key:'atropine',            label:'Atropine',          sub:'Chronotrope',       showDose:false},
    {key:'glycopyrrolate',      label:'Glycopyrrolate',    sub:'Chronotrope',       showDose:false},
    {key:'adenosine',           label:'Adenosine',         sub:'SVT',               showDose:false},
    {key:'amiodarone_arrest',   label:'Amiodarone',        sub:'Arrest (300mg push)',showDose:false},
    {key:'amiodarone_infusion', label:'Amiodarone',        sub:'Perfusing (150mg)', showDose:false},
    {key:'lidocaine',           label:'Lidocaine',         sub:'Antiarrhythmic',    showDose:false},
    {key:'magnesium',           label:'Magnesium',         sub:'TdP/Bronchospasm',  showDose:false},
    {key:'calcium_chloride',    label:'Calcium Chloride',  sub:'Resuscitation',     showDose:false},
    {key:'sodium_bicarb',       label:'Sodium Bicarb',     sub:'Resuscitation',     showDose:false},
  ],
  fluids: [
    {key:'fluid_bolus',         label:'Fluid Bolus',       sub:'NS/LR',             showDose:false},
    {key:'blood',               label:'pRBC',              sub:'Blood product',     showDose:false},
    {key:'albuterol',           label:'Albuterol',         sub:'Inhaled',           showDose:false},
    {key:'diphenhydramine',     label:'Diphenhydramine',   sub:'Antihistamine',     showDose:false},
    {key:'methylprednisolone',  label:'Methylprednisolone',sub:'Steroid',           showDose:false},
  ]
};

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════
global.MedSimCore = {
  // State
  S: S,
  P: P,
  // Drug administration
  give:             give,
  startInfusion:    startInfusion,
  stopInfusion:     stopInfusion,
  // Simulation loop
  step:             step,
  trSet:            trSet,
  trClear:          trClear,
  // Patient
  setPatient:       setPatient,
  getMode:          getMode,
  getWeight:        getWeight,
  // Physiology
  setLaryngoPhase:  setLaryngoPhase,
  applyVentModeChange: applyVentModeChange,
  clamp:            clamp,
  // Events
  on:               on,
  off:              off,
  // Catalog
  CATALOG:          CATALOG,
  DRUGS:            DRUGS,
  RATES:            RATES,
  // Version
  version:          '1.1'
};

})(typeof window !== 'undefined' ? window : global);
