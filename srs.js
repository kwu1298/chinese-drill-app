// SM-2 scheduling + queue building for the phone, ported line-for-line from
// drill.py. The Python file remains the reference implementation; the golden
// test asserts this port grades identically (`node test-srs.js`, vectors
// from gen-golden.py; CI runs both). If you change one, change both,
// regenerate the vectors, and re-run the test.
'use strict';

const SRS = {
  LEARNING_STEPS_MIN: [10, 30, 120],
  // First-sight-correct = already known: skip the ladder. See drill.py.
  KNOWN_MIN: 3 * 24 * 60,
  GRADUATED_MIN: 24 * 60,
  EASE_START: 2.5,
  EASE_FLOOR: 1.3,
  EASE_PENALTY: 0.2,
  MAX_INTERVAL_MIN: 180 * 24 * 60,
  // Lapses before a card counts as a leech. Nothing here reschedules it --
  // see drill.py -- it only changes what the screen says after a miss.
  LEECH_AT: 4,
  SESSION_CAP: 20,
  SIBLING_MIN_GAP: 6,
  NEW_PER_SESSION: 12,
  NEW_RESERVED: 6,
  MIN_SESSION: 5,
  ORDER_SLACK: 5,

  // Local-time ISO without milliseconds, matching Python's isoformat --
  // the two sides must produce comparable strings.
  iso(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  },

  entryFor(state, id) {
    return state[id] || { due: '1970-01-01T00:00:00', step: 0, interval_min: 0,
                          ease: SRS.EASE_START, reps: 0, lapses: 0 };
  },

  isLeech(entry) {
    return (entry && entry.lapses || 0) >= SRS.LEECH_AT;
  },

  // A card that has never been answered at all. Only a TRUE first sight: a
  // card missed while still unseen (reps 0, lapses up) is back to being
  // tested, not taught. Mirrors drill.py's build_payload/grade test exactly
  // -- the phone and the Mac must agree on which meeting is the first one,
  // or a card teaches on one device and tests on the other.
  firstSight(entry) {
    return entry.reps === 0 && (entry.lapses || 0) === 0;
  },

  // What the phone shows above the options as teaching, mirroring the
  // `teach` field drill.py's build_payload sends the Mac window: the card's
  // breakdown, on first sight only. On a review this is a test, and nothing
  // that states the answer may be on screen before the grade -- the same
  // rule that keeps a decompose review's ▶ hidden until the answer is in.
  // (Yes, on an exact-fit phonetic first sight this hands over the folded
  // reading, and a first-sight right still promotes to KNOWN_MIN. Accepted
  // on purpose -- see drill.py's build_payload comment.)
  teachFor(card, entry) {
    return SRS.firstSight(entry) ? (card.breakdown || '') : '';
  },

  // Every lesson key this card may offer, mirroring drill.py's payload
  // join: the stamped list when the word holds more than one explained
  // character (经理 offers 经's and 理's), else the single key. Any card
  // with keys offers them on every showing -- reviews included, because
  // right after a missed review is the most teachable moment a card has.
  // Existence of the clips is the caller's problem: the Mac checks the
  // disk, the phone checks the deploy manifest.
  lessonKeysFor(card) {
    return card.lessonKeys || (card.lessonKey ? [card.lessonKey] : []);
  },

  // Whether the ▶s may be on screen BEFORE the grade: only alongside the
  // teach line -- a first meeting is an explanation. Every other showing
  // earns its ▶s when the answer is committed (showAnswer reveals them,
  // the Mac's choose()/submit() do the same), because a lesson states the
  // answer and nothing that states the answer may precede the grade.
  lessonGate(card, entry) {
    return SRS.teachFor(card, entry) !== '';
  },

  grade(entry, correct, now) {
    const e = Object.assign({}, entry);
    let wait;
    if (correct) {
      const firstSight = e.reps === 0 && e.lapses === 0;
      e.reps += 1;
      if (firstSight) {
        wait = SRS.KNOWN_MIN;
        e.step = SRS.LEARNING_STEPS_MIN.length;
      } else if (e.step < SRS.LEARNING_STEPS_MIN.length) {
        wait = SRS.LEARNING_STEPS_MIN[e.step];
        e.step += 1;
      } else if (e.interval_min < SRS.GRADUATED_MIN) {
        wait = SRS.GRADUATED_MIN;
      } else {
        wait = Math.floor(e.interval_min * e.ease);
      }
      e.interval_min = Math.min(wait, SRS.MAX_INTERVAL_MIN);
    } else {
      e.lapses += 1;
      // no rounding: Python keeps the raw float and IEEE 754 doubles are
      // identical across the two languages, so the ports stay bit-equal
      e.ease = Math.max(SRS.EASE_FLOOR, e.ease - SRS.EASE_PENALTY);
      wait = SRS.LEARNING_STEPS_MIN[0];
      e.step = 1;
      e.interval_min = wait;
    }
    e.due = SRS.iso(new Date(now.getTime() + wait * 60000));
    return e;
  },

  // Reconcile one card's two histories. Must not depend on argument order.
  // Count then due date is not enough to decide: a card answered once on
  // each device, wrong here and right there, matches on both, because a
  // lapse and a first correct answer both schedule the first learning step.
  // Keep going and break conservatively -- more lapses, then lower ease,
  // then the shorter interval. See sync.py, which is the reference.
  mergeEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ca = a.reps + a.lapses, cb = b.reps + b.lapses;
    if (ca !== cb) return ca > cb ? a : b;
    if (a.due !== b.due) return a.due > b.due ? a : b;
    if (a.lapses !== b.lapses) return a.lapses > b.lapses ? a : b;
    if (a.ease !== b.ease) return a.ease < b.ease ? a : b;
    if (a.interval_min !== b.interval_min) {
      return a.interval_min < b.interval_min ? a : b;
    }
    return a;
  },

  // Sorted, matching sync.py: the result gets serialised and compared against
  // the remote copy, so an order that depends on which side was passed first
  // means a pointless write every time the two devices sync.
  mergeState(local, remote) {
    const out = {};
    const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])];
    keys.sort();
    for (const k of keys) out[k] = SRS.mergeEntry(local[k], remote[k]);
    return out;
  },

  // Stable text for a state object, whatever order its keys were built in.
  stringifyState(state) {
    const out = {};
    for (const k of Object.keys(state).sort()) out[k] = state[k];
    return JSON.stringify(out, null, 1);
  },

  baseOf(id) { return id.slice(0, id.lastIndexOf(':')); },

  // Hand port of pinyin.py's normalize(); that file is the reference and
  // test-pinyin.js replays its vectors through this. The diaeresis of ü is
  // kept while the four tone marks are dropped -- losing it would collide
  // 绿 (lǜ) with 路 (lù). See pinyin.py for why tones are folded away.
  TONE_MARKS: ['̄', '́', '̌', '̀'],
  normalizePinyin(text) {
    if (!text) return '';
    const tones = new Set(SRS.TONE_MARKS);
    let out = Array.from(String(text).toLowerCase().normalize('NFD'))
        .filter(ch => !tones.has(ch)).join('').normalize('NFC');
    for (const junk of [' ', '\t', "'", '’', '-', '·']) {
      out = out.split(junk).join('');
    }
    out = Array.from(out).filter(ch => '12345'.indexOf(ch) === -1).join('');
    return out.split('v').join('ü');
  },

  // True if `typed` is one of the readings this card accepts. The deck
  // stores accept[] already normalised, so only the input needs folding.
  checkTyped(card, typed) {
    const n = SRS.normalizePinyin(typed);
    return !!n && (card.accept || []).indexOf(n) !== -1;
  },

  isTyped(card) { return card.dir === 'hz2py'; },

  // Cards tagged deliver:"table" are a paradigm the grid and the matching
  // round teach as a system. They keep their schedule and their history --
  // they are just never handed out as isolated multiple-choice.
  drillable(cards) { return cards.filter(c => c.deliver !== 'table'); },

  // hz -> {py, en}, read back off the deck so a word can be shown with its
  // reading and meaning without every card carrying copies. The gloss rides
  // the py2hz prompt ("jīnglǐ — manager"): hz2en cards were retired for
  // vocab on 2026-08-03 (only 成语 keep them). Mirrors drill.py word_index.
  wordIndex(cards) {
    const out = {};
    for (const c of cards) {
      const hz = c.dir === 'py2hz' ? c.answer : c.prompt;
      const at = out[hz] || (out[hz] = {});
      if (c.dir === 'hz2py' && !at.py) at.py = c.answer;
      else if (c.dir === 'hz2en' && !at.en) at.en = c.answer;
      else if (c.dir === 'py2hz' && !at.en && c.prompt.includes(' — ')) {
        at.en = c.prompt.slice(c.prompt.indexOf(' — ') + 3);
      }
    }
    return out;
  },

  // folded reading -> [hz, ...]: every word a typed answer could have been.
  // Built from the accept lists, which the deck stores already normalised
  // -- the same strings grading compares against, so "what word did he
  // actually type" uses the same folding as "was it right". Sentence cards
  // are skipped: their prompt is a whole 课文 line, not a word.
  pinyinIndex(cards) {
    const out = {};
    for (const c of cards) {
      if (c.dir !== 'hz2py' || c.cat === 'sentences') continue;
      for (const a of (c.accept || [])) {
        const at = out[a] || (out[a] = []);
        if (at.indexOf(c.prompt) === -1) at.push(c.prompt);
      }
    }
    return out;
  },

  // The diagnosis behind a wrong typed answer: which REAL word he typed,
  // when it is one -- his misses are nearly always family members, and
  // 「you typed yǐjīng — that's 已经 (already)」 names the actual confusion
  // where 「wrong」 names nothing. Returns {hz, py, en} or null; null means
  // the caller degrades to the plain wrong/right line. A hit among the
  // card's own `near` list wins (the family IS the likely confusion);
  // the card's own word is never a diagnosis (that typed answer graded
  // correct and never reaches here).
  diagnose(card, typed, pyIdx, words) {
    const n = SRS.normalizePinyin(typed);
    if (!n || (card.accept || []).indexOf(n) !== -1) return null;
    const hits = pyIdx[n] || [];
    const mine = card.dir === 'py2hz' ? card.answer : card.prompt;
    const near = new Set(card.near || []);
    const pick = hits.find(h => near.has(h)) || hits.find(h => h !== mine);
    if (!pick) return null;
    const info = (words || {})[pick] || {};
    return { hz: pick, py: info.py || '', en: info.en || '' };
  },

  // "The tell": the one feature that separates this word from the family
  // it keeps losing to, derived -- never invented -- from the stamped
  // anatomy. Only when the confusables really share a character, exactly
  // one character of this word appears in none of them, and that
  // character's meaning-part has a gloss; anything less would be mush,
  // and mush is skipped rather than padded. Returns null, or the parts
  // the strip sets as 「the tell: 理 = king — only manager has it」:
  // {hz, py, semEn, who}. Parts, not a sentence, so the renderer can
  // keep the colour law (semEn is a meaning-part: celadon).
  tellFor(card, words) {
    const mine = card.dir === 'py2hz' ? card.answer : card.prompt;
    const fam = (card.near || [])
        .filter(n => [...n].some(ch => mine.includes(ch)));
    if (!fam.length) return null;
    const uniq = [...mine].filter(ch => !fam.some(n => n.includes(ch)));
    if (uniq.length !== 1) return null;
    const a = (card.anatomy || []).find(x => x.hz === uniq[0]);
    if (!a || !a.semEn) return null;
    const en = ((words || {})[mine] || {}).en || '';
    const who = en.split(';')[0].split(',')[0].trim() || mine;
    return { hz: a.hz, py: a.py || '', semEn: a.semEn, who: who };
  },

  // Mirrors drill.py's KICKERS -- the ways one item can be tested.
  KICKERS: {
    hz2py: 'TYPE THE READING',
    py2hz: 'CHOOSE THE CHARACTER',
    hz2en: 'CHOOSE THE MEANING',
    // The component curriculum (built in build-deck.py): ordinary
    // four-option cards everywhere except the never-seen ordering, where
    // an explainer goes before its uses. Mirrors drill.py's KICKERS.
    parts: 'PICK THE PART THAT CARRIES THE SOUND',
    radical: 'CHOOSE WHAT THIS RADICAL MARKS',
  },

  preferredDir(base, dirs) {
    const ordered = [...new Set(dirs)].sort();
    let s = 0;
    for (const ch of base) s += ch.codePointAt(0);
    return ordered[s % ordered.length];
  },

  dueCards(cards, state, now) {
    const nowIso = SRS.iso(now);
    const out = [];
    for (const c of SRS.drillable(cards)) {
      const e = SRS.entryFor(state, c.id);
      if (e.due <= nowIso) out.push([c, e]);
    }
    out.sort((x, y) => {
      const nx = x[1].reps === 0 ? 1 : 0, ny = y[1].reps === 0 ? 1 : 0;
      if (nx !== ny) return nx - ny;
      return x[1].due < y[1].due ? -1 : x[1].due > y[1].due ? 1 : 0;
    });
    return out;
  },

  // What meeting this card unlocks for cards behind it, or null. A radical's
  // intro card explains the radical; a decompose card explains a character.
  // Everything else is a consumer, not a producer. drill.py's _provides
  // returns tuples; strings ("radical:目", "char:睡") are the JS equivalent
  // of a hashable key.
  provides(card) {
    const item = card.id.split(':')[1];
    if (card.cat === 'intro') return 'radical:' + item;
    if (card.cat === 'decompose') return 'char:' + item;
    return null;
  },

  // The explainers this card would rather be introduced after. A decompose
  // card leans on its semantic radical (build-deck.py stamps it into `uses`);
  // a word leans on the decompose card of each character in it. Preferences
  // between never-seen cards, never gates: a word whose characters have no
  // decompose card -- half the deck, see drill.py's breakdown() -- is
  // introduced exactly as before.
  requires(card) {
    if (card.cat === 'intro') return [];
    if (card.cat === 'decompose') {
      return card.uses ? ['radical:' + card.uses] : [];
    }
    // The item part of the id is the word itself for vocab cards; 多音字
    // items carry the disambiguating word after an @, and sentence items are
    // synthetic tags with no hanzi at all, which yield nothing here.
    const item = card.id.split(':')[1].split('@')[0];
    return Array.from(item).filter(ch => ch >= '一' && ch <= '鿿')
                           .map(ch => 'char:' + ch);
  },

  // Never-seen cards, reordered so explanations come before their uses.
  // First meetings are explanations, so meet the pieces before the things
  // made of them: a radical's card before the decompose cards that hang off
  // it, a character's decompose card before the words containing it. Stable
  // otherwise -- a card keeps its queue position except that its explainers,
  // when they are also waiting to be introduced, are pulled in front of it.
  // An explainer that is missing or already met costs nothing, and the
  // NEW_PER_SESSION truncation downstream then tends to cut whole chains
  // rather than orphaning a word from its explanation.
  prereqSort(pairs) {
    const provider = {};
    pairs.forEach((pair, idx) => {
      const key = SRS.provides(pair[0]);
      if (key !== null && !(key in provider)) provider[key] = idx;
    });
    const out = [], emitted = new Array(pairs.length).fill(false);
    const emit = i => {
      if (emitted[i]) return;
      emitted[i] = true;      // marked before recursing, so a malformed
      for (const req of SRS.requires(pairs[i][0])) {  // cycle cannot hang
        const j = provider[req];
        if (j !== undefined) emit(j);
      }
      out.push(pairs[i]);
    };
    for (let i = 0; i < pairs.length; i++) emit(i);
    return out;
  },

  penalty(cand, out, gap) {
    const card = cand[0];
    let p = 0;
    const b = SRS.baseOf(card.id);
    const recent = out.slice(-gap);
    for (let i = 0; i < recent.length; i++) {
      const prev = recent[recent.length - 1 - i];
      if (SRS.baseOf(prev[0].id) === b) p += 100 * (gap - i);
    }
    if (out.length) {
      const last = out[out.length - 1][0];
      if (last.dir === card.dir) p += 4;
      if (last.cat === card.cat) p += 1;
      if ((last.lesson || '') === (card.lesson || '')) p += 1;
    }
    if (out.length >= 2 &&
        out[out.length - 1][0].dir === card.dir &&
        out[out.length - 2][0].dir === card.dir) p += 8;
    return p;
  },

  orderQueue(pairs, cap, gap, newCap) {
    cap = cap || SRS.SESSION_CAP;
    gap = gap || SRS.SIBLING_MIN_GAP;
    if (!pairs.length) return [];

    const arrange = tier => {
      const order = [], byBase = {};
      for (const [card, entry] of tier) {
        const b = SRS.baseOf(card.id);
        if (!byBase[b]) { byBase[b] = []; order.push(b); }
        byBase[b].push([card, entry]);
      }
      const primary = [], held = [], used = {};
      for (const b of order) {
        const options = byBase[b];
        let pick = options[0];
        if (options.length > 1) {
          const pref = SRS.preferredDir(b, options.map(ce => ce[0].dir));
          pick = options.slice().sort((x, y) =>
            ((used[x[0].dir] || 0) - (used[y[0].dir] || 0)) ||
            ((x[0].dir === pref ? 0 : 1) - (y[0].dir === pref ? 0 : 1)))[0];
        }
        primary.push(pick);
        used[pick[0].dir] = (used[pick[0].dir] || 0) + 1;
        for (const ce of options) if (ce !== pick) held.push(ce);
      }
      return [primary, held];
    };

    const [seenPrimary, seenHeld] = arrange(pairs.filter(p => p[1].reps > 0));
    let [newPrimary, newHeld] = arrange(pairs.filter(p => p[1].reps === 0));

    const reviewed = new Set(seenPrimary.map(p => SRS.baseOf(p[0].id)));
    newHeld = newHeld.concat(newPrimary.filter(p => reviewed.has(SRS.baseOf(p[0].id))));
    newPrimary = newPrimary.filter(p => !reviewed.has(SRS.baseOf(p[0].id)));

    // Explanations before their uses, applied before the NEW_PER_SESSION
    // cut below takes its slice: pulling a word's explainers in front of it
    // is what makes the limited intro slots come out as complete teaching
    // chains (radical, then anatomy, then the word) instead of words whose
    // explanation missed the cut.
    newPrimary = SRS.prereqSort(newPrimary);

    const limitNew = (newCap === undefined || newCap === null)
        ? SRS.NEW_PER_SESSION : newCap;
    let picked = seenPrimary.slice(0, cap);
    let room = Math.min(cap - picked.length, limitNew);
    if (newPrimary.length && room < Math.min(SRS.NEW_RESERVED, limitNew)) {
      picked = seenPrimary.slice(0, Math.max(0, cap - SRS.NEW_RESERVED));
      room = Math.min(cap - picked.length, limitNew);
    }
    if (room > 0) picked = picked.concat(newPrimary.slice(0, room));
    if (picked.length < SRS.MIN_SESSION) {
      for (const extra of [seenHeld, newHeld]) {
        if (picked.length < cap) {
          picked = picked.concat(extra.slice(0, cap - picked.length));
        }
      }
    }

    const out = [];
    for (const [isNew, tier] of [[false, picked.filter(p => p[1].reps > 0)],
                                 [true, picked.filter(p => p[1].reps === 0)]]) {
      const remaining = tier.slice();
      while (remaining.length) {
        let idxs = remaining.map((_, i) => i);
        if (isNew) {
          // The interleave shuffles for variety, which could put a word
          // ahead of the explainer prereqSort placed for it. So a
          // never-seen card whose explainer is also still waiting is not
          // a candidate yet. Intro cards require nothing, so the candidate
          // list cannot come up empty -- but a scheduler must not be able
          // to deadlock on its own deck, hence the guard.
          const waiting = new Set(remaining.map(p => SRS.provides(p[0])));
          waiting.delete(null);
          const ready = idxs.filter(i =>
              !SRS.requires(remaining[i][0]).some(r => waiting.has(r)));
          idxs = ready.length ? ready : idxs;
        }
        const scored = idxs.map(i => [SRS.penalty(remaining[i], out, gap), i]);
        const best = Math.min(...scored.map(s => s[0]));
        const near = scored.filter(s => s[0] <= best + SRS.ORDER_SLACK)
                           .map(s => s[1]);
        const pick = near[Math.floor(Math.random() * near.length)];
        out.push(remaining.splice(pick, 1)[0]);
      }
    }
    return out;
  },

  // newCap mirrors drill.py's new_cap: how many never-seen cards this one
  // sitting may introduce. The crank threads a shrinking budget through it so
  // half an hour of rounds cannot keep starting fresh at NEW_PER_SESSION.
  selectQueue(cards, state, mode, now, newCap) {
    now = now || new Date();
    cards = SRS.drillable(cards);
    if (mode === 'due') {
      return SRS.orderQueue(SRS.dueCards(cards, state, now),
                            undefined, undefined, newCap);
    }

    let pool;
    if (mode === 'vocab' || mode === 'sentences') {
      pool = cards.filter(c => c.cat === mode);
    } else if (SRS.KICKERS[mode]) {
      pool = cards.filter(c => c.dir === mode);
    } else if (mode === 'hardest') {
      pool = cards.slice().sort((a, b) => {
        const ea = SRS.entryFor(state, a.id), eb = SRS.entryFor(state, b.id);
        return (eb.lapses - ea.lapses) || (ea.ease - eb.ease);
      }).filter(c => SRS.entryFor(state, c.id).lapses > 0);
    } else if (mode === 'new') {
      pool = cards.filter(c => SRS.entryFor(state, c.id).reps === 0);
    } else if (mode === 'lesson') {
      const tags = [...new Set(cards.map(c => c.lesson).filter(Boolean))].sort();
      const latest = tags[tags.length - 1];
      pool = latest ? cards.filter(c => c.lesson === latest) : [];
    } else {
      pool = cards.slice();
    }

    if (mode !== 'hardest') {
      const dueIds = new Set(SRS.dueCards(cards, state, now).map(p => p[0].id));
      const head = pool.filter(c => dueIds.has(c.id));
      const tail = pool.filter(c => !dueIds.has(c.id));
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      pool = head.concat(tail);
    }
    // Pressing "New cards" is a deliberate choice, so the per-session drip
    // that protects the scheduled firings does not apply to it.
    if ((newCap === undefined || newCap === null) && mode === 'new') {
      newCap = SRS.SESSION_CAP;
    }
    return SRS.orderQueue(pool.map(c => [c, SRS.entryFor(state, c.id)]),
                          undefined, undefined, newCap);
  },
};

if (typeof module !== 'undefined') module.exports = SRS;
