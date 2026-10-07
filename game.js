(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ================= text normalisation =================
  // Ethiopic letters sit in rows of 8 (one row per consonant). Several rows sound
  // identical in Amharic (ሀ/ሐ/ኀ/ኸ, ሰ/ሠ, አ/ዐ, ጸ/ፀ), so fold them together, and fold
  // labialised extension rows into their base consonant.
  const ROW_MAP = { 2: 0, 16: 0, 17: 0, 23: 0, 4: 6, 26: 20, 40: 39, 9: 8, 10: 8, 22: 21, 34: 33 };
  const isEth = (cp) => cp >= 0x1200 && cp <= 0x137f;

  function ethChar(cp) {
    if (cp >= 0x1360) return ''; // Ethiopic punctuation and numerals
    const off = cp - 0x1200;
    let row = off >> 3, ord = off & 7;
    if (row in ROW_MAP) row = ROW_MAP[row];
    if ((row === 0 || row === 20) && ord === 3) ord = 0; // ሃ→ሀ, ኣ→አ (same sound)
    return String.fromCharCode(0x1200 + row * 8 + ord);
  }

  function normalize(text) {
    const s = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (isEth(cp)) out += ethChar(cp);
      else if (ch >= 'a' && ch <= 'z') out += ch;
      else if (/[\s\-_/]/.test(ch)) out += ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  const keyOf = (s) => normalize(s).replace(/ /g, '');

  // The "letter" of a word: its first Latin letter, or the base form of its Ethiopic consonant row.
  function letterOf(key) {
    if (!key) return '';
    const cp = key.codePointAt(0);
    if (isEth(cp)) return String.fromCharCode(0x1200 + ((cp - 0x1200) >> 3) * 8);
    return key[0];
  }
  const familyRow = (L) => {
    const b = L.codePointAt(0);
    return Array.from({ length: 7 }, (_, i) => String.fromCharCode(b + i)).join(' ');
  };
  const showLetter = (L) => (isEth(L.codePointAt(0)) ? L : L.toUpperCase());

  // ================= dictionaries =================
  const splitList = (raw) => raw.split(/[,\n፣]+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

  function buildDict(builtIn, mine) {
    const entries = [], byKey = new Map();
    const add = (group, isMine) => {
      const names = group.split('|').map((s) => s.trim()).filter(Boolean);
      const keys = names.map(keyOf).filter(Boolean);
      if (!keys.length || byKey.has(keys[0])) return; // skip duplicates
      const entry = { id: entries.length, name: names[0], names, keys, mine: isMine };
      entries.push(entry);
      keys.forEach((k) => { if (!byKey.has(k)) byKey.set(k, entry); });
    };
    builtIn.forEach((g) => add(g, false));
    mine.forEach((g) => add(g, true));
    return { entries, byKey };
  }

  // ---- the player's own words and topics, kept in this browser ----
  // { extra: { [builtInTopicId]: { en: [...], am: [...] } }, topics: [{ id, name, words: { en: [...], am: [...] } }] }
  const WORDS_KEY = 'fidel-duel-words';
  let custom = { extra: {}, topics: [] };
  try {
    const c = JSON.parse(localStorage.getItem(WORDS_KEY) || 'null');
    if (c && typeof c === 'object') custom = { extra: c.extra || {}, topics: Array.isArray(c.topics) ? c.topics : [] };
  } catch {}
  const saveCustom = () => { try { localStorage.setItem(WORDS_KEY, JSON.stringify(custom)); return true; } catch { return false; } };

  const allTopics = () => [...window.TOPICS, ...custom.topics];
  const customTopic = (id) => custom.topics.find((t) => t.id === id);
  const tName = (t, lang) => (t.name != null ? t.name || 'Untitled topic' : t[lang]);

  function userWords(id, lang) {
    const ct = customTopic(id);
    if (ct) return ct.words[lang] || [];
    return (custom.extra[id] && custom.extra[id][lang]) || [];
  }
  function setUserWords(id, lang, list) {
    const ct = customTopic(id);
    if (ct) ct.words[lang] = list;
    else (custom.extra[id] = custom.extra[id] || {})[lang] = list;
    dictCache.delete(`${id}/${lang}`);
    return saveCustom();
  }

  const dictCache = new Map();
  function getDict(id, lang) {
    const k = `${id}/${lang}`;
    if (!dictCache.has(k)) {
      const t = window.TOPICS.find((x) => x.id === id);
      dictCache.set(k, buildDict(t ? splitList(t.words[lang]) : [], userWords(id, lang)));
    }
    return dictCache.get(k);
  }

  // Adds comma-separated words; skips ones the topic already has. Returns counts for the message.
  function addWords(id, lang, raw) {
    const d = getDict(id, lang);
    const list = [...userWords(id, lang)];
    const seen = new Set();
    let added = 0, dup = 0;
    for (const g of splitList(raw)) {
      const keys = g.split('|').map(keyOf).filter(Boolean);
      if (!keys.length) continue;
      if (keys.some((k) => d.byKey.has(k) || seen.has(k))) { dup++; continue; }
      keys.forEach((k) => seen.add(k));
      list.push(g);
      added++;
    }
    const saved = added ? setUserWords(id, lang, list) : true;
    return { added, dup, saved };
  }

  function lookup(dict, key) {
    if (dict.byKey.has(key)) return { entry: dict.byKey.get(key), key };
    if (/^[a-z]+$/.test(key)) { // English plurals: "tigers", "cherries", "peaches"
      const tries = [];
      if (key.endsWith('ies')) tries.push(key.slice(0, -3) + 'y');
      if (key.endsWith('es')) tries.push(key.slice(0, -2));
      if (key.endsWith('s')) tries.push(key.slice(0, -1));
      for (const t of tries) if (dict.byKey.has(t)) return { entry: dict.byKey.get(t), key: t };
    }
    return null;
  }

  // ================= settings & state =================
  const settings = {
    lang: 'en', topic: 'animals', baseTime: 15, lives: 3,
    mic: true, voice: true, sound: true, names: ['Player 1', 'Player 2'],
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('fidel-duel') || '{}')); } catch {}
  const saveSettings = () => { try { localStorage.setItem('fidel-duel', JSON.stringify(settings)); } catch {} };

  let S = null;       // live game state
  let token = 0;      // bumps on every turn change so stale async callbacks bail out
  let dict = null;

  const topicOf = (id) => allTopics().find((t) => t.id === id);
  if (!topicOf(settings.topic)) settings.topic = 'animals';
  const topicName = () => tName(topicOf(settings.topic), settings.lang);
  const turnSeconds = () => Math.max(6, settings.baseTime - (S.round - 1));
  const opp = () => S.players[1 - S.cur];

  // ================= audio =================
  let ac = null;
  function tone(freq, dur, type = 'sine', vol = 0.12, when = 0) {
    if (!settings.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime + when, o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch {}
  }
  const sfx = {
    click: () => tone(820 + Math.random() * 200, 0.03, 'square', 0.03),
    land: () => { tone(660, 0.12, 'triangle', 0.12); tone(990, 0.2, 'triangle', 0.1, 0.07); },
    good: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.13, i * 0.07)),
    nope: () => tone(260, 0.14, 'square', 0.05),
    bad: () => { tone(190, 0.35, 'sawtooth', 0.09); tone(140, 0.45, 'sawtooth', 0.08, 0.1); },
    tick: () => tone(1250, 0.05, 'sine', 0.08),
    win: () => [392, 523, 659, 784, 659, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.13, i * 0.12)),
  };

  // ================= announcer =================
  function announce(text) {
    return new Promise((resolve) => {
      if (!settings.voice || settings.lang !== 'en' || !('speechSynthesis' in window)) return resolve();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05; u.lang = 'en-US';
        u.onend = finish; u.onerror = finish;
        speechSynthesis.speak(u);
        setTimeout(finish, 3500); // Chrome sometimes never fires onend
      } catch { finish(); }
    });
  }

  // ================= speech recognition =================
  let rec = null, netFails = 0, micBlockedMsg = '';
  // Voice runs on-device (works offline) when the browser has a language pack for it,
  // otherwise through the browser's online speech service.
  const voice = { local: false, state: 'unknown' };
  const srLang = () => (settings.lang === 'am' ? 'am-ET' : 'en-US');
  const micUsable = () => SR && settings.mic && !micBlockedMsg && (voice.local || navigator.onLine);
  const offlineNote = () => (SR && settings.mic && !micBlockedMsg && !micUsable()
    ? 'You\'re offline and this language has no offline voice pack, so type your answers.' : '');

  function newRecognizer() {
    const r = new SR();
    r.lang = srLang();
    if (voice.local) r.processLocally = true;
    return r;
  }

  async function checkVoice() {
    const el = $('#voiceStatus'), btn = $('#voicePackBtn');
    const lang = srLang();
    const set = (kind, text) => { el.className = `voice-status ${kind}`; el.textContent = text; };
    btn.hidden = true;
    voice.local = false;
    if (!SR) {
      $('#micTestBtn').disabled = true;
      return set('bad', 'This browser can\'t recognise speech. Use Chrome or Edge, or type your answers.');
    }
    let st = 'unsupported';
    if (typeof SR.available === 'function') {
      try { st = await SR.available({ langs: [lang], processLocally: true }); } catch { st = 'unsupported'; }
    }
    if (lang !== srLang()) return; // language changed while we were checking
    voice.state = st;
    const name = settings.lang === 'am' ? 'Amharic' : 'English';
    if (st === 'available') {
      voice.local = true;
      set('ok', `${name} voice runs on this device and works offline.`);
    } else if (st === 'downloadable') {
      btn.hidden = false;
      btn.disabled = false;
      btn.textContent = `Download offline ${name} voice`;
      set('warn', `${name} voice uses the internet right now. Download the voice pack once to play by voice offline.`);
    } else if (st === 'downloading') {
      set('warn', `Downloading the offline ${name} voice pack…`);
      setTimeout(checkVoice, 4000);
    } else {
      set(navigator.onLine ? 'warn' : 'bad', navigator.onLine
        ? `${name} voice needs an internet connection in this browser. Offline, you can type your answers.`
        : `You're offline and this browser has no offline ${name} voice. Type your answers this time.`);
    }
  }

  async function installVoicePack() {
    const btn = $('#voicePackBtn');
    btn.disabled = true;
    btn.textContent = 'Downloading…';
    let ok = false;
    try { ok = await SR.install({ langs: [srLang()], processLocally: true }); } catch {}
    if (!ok) {
      btn.disabled = false;
      btn.textContent = 'Download failed. Try again';
      return;
    }
    checkVoice();
  }

  function startRecognition() {
    if (!micUsable() || rec || !S || S.phase !== 'turn') return;
    const r = newRecognizer();
    rec = r;
    r.interimResults = true;
    r.maxAlternatives = 5;
    r.continuous = false;
    r.onstart = () => setMic(true);
    r.onresult = (e) => {
      netFails = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) handleAnswer(Array.from(res).map((a) => a.transcript));
        else interim += res[0].transcript;
      }
      if (interim) showHeard(interim, true);
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        blockMic('Microphone access was blocked. Allow it in the address bar, or type your answers.');
      } else if (voice.local && (e.error === 'language-not-supported' || e.error === 'service-not-allowed')) {
        voice.local = false; // on-device pack failed; fall back to the online service
      } else if (e.error === 'language-not-supported') {
        blockMic('This browser can\'t recognise this language by voice. Type your answers instead.');
      } else if (e.error === 'network' && ++netFails >= 3) {
        blockMic('The speech service is unreachable (it needs internet). Type your answers instead.');
      }
    };
    r.onend = () => {
      if (rec === r) rec = null;
      setMic(false);
      if (S && S.phase === 'turn' && micUsable()) setTimeout(startRecognition, 150);
    };
    try { r.start(); } catch { rec = null; }
  }
  function stopRecognition() {
    if (!rec) return;
    const r = rec; rec = null;
    try { r.abort(); } catch {}
    setMic(false);
  }
  function blockMic(msg) {
    micBlockedMsg = msg;
    stopRecognition();
    feedback('warn', msg);
    $('#typeInput').focus();
  }

  // ================= setup screen =================
  const hasEth = (str) => /[ሀ-፿]/.test(str);

  function renderTopics() {
    const box = $('#topics');
    box.innerHTML = '';
    for (const t of allTopics()) {
      const d = getDict(t.id, settings.lang);
      const mine = d.entries.filter((e) => e.mine).length;
      const isCustom = t.name != null;
      const name = tName(t, settings.lang);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'topic';
      b.setAttribute('aria-pressed', String(t.id === settings.topic));
      b.innerHTML = '<span class="tname"></span><span class="tmeta"></span>';
      b.querySelector('.tname').textContent = name;
      b.querySelector('.tname').classList.toggle('am', hasEth(name));
      let meta;
      if (isCustom) meta = `Your topic · ${d.entries.length} ${d.entries.length === 1 ? 'word' : 'words'}`;
      else {
        const sample = d.entries.filter((_, i) => i % Math.ceil(d.entries.length / 4) === 3).slice(0, 3).map((e) => e.name);
        meta = `${d.entries.length} words${mine ? ` (${mine} yours)` : ''} · ${sample.join(', ')}`;
      }
      b.querySelector('.tmeta').textContent = meta;
      if (isCustom) b.classList.add('custom');
      b.onclick = () => { settings.topic = t.id; saveSettings(); renderTopics(); };
      box.appendChild(b);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'topic new';
    add.innerHTML = '<span class="tname">+ New topic</span><span class="tmeta">Make your own category</span>';
    add.onclick = newTopic;
    box.appendChild(add);

    const t = topicOf(settings.topic);
    const mineHere = userWords(t.id, settings.lang).length;
    $('#mineSummary').textContent = t.name != null
      ? `“${tName(t, settings.lang)}” is your topic.`
      : mineHere ? `You've added ${mineHere} ${mineHere === 1 ? 'word' : 'words'} to ${tName(t, settings.lang)}.`
        : `Missing a word? Add your own to ${tName(t, settings.lang)}.`;
    $('#startMsg').textContent = '';
  }

  // ================= word editor =================
  const ed = { id: null, lang: 'en', confirmDelete: false };

  function newTopic() {
    const id = `my-${Date.now().toString(36)}`;
    custom.topics.push({ id, name: '', words: { en: [], am: [] } });
    saveCustom();
    settings.topic = id; saveSettings();
    openEditor(id, true);
  }

  function openEditor(id = settings.topic, focusName = false) {
    ed.id = id; ed.lang = settings.lang; ed.confirmDelete = false;
    const isCustom = !!customTopic(id);
    $('#edNameRow').hidden = !isCustom;
    $('#edDelete').hidden = !isCustom;
    $('#edDelete').textContent = 'Delete topic';
    $('#edMsg').textContent = '';
    $('#edMsg').className = 'ed-msg';
    $('#edInput').value = '';
    if (isCustom) $('#edName').value = customTopic(id).name;
    renderEditor();
    $('#wordsOv').hidden = false;
    (focusName ? $('#edName') : $('#edInput')).focus();
  }

  function closeEditor() {
    if ($('#wordsOv').hidden) return;
    const ct = customTopic(ed.id);
    if (ct && !ct.name.trim()) { ct.name = 'My topic'; saveCustom(); }
    $('#wordsOv').hidden = true;
    renderTopics();
  }

  function renderEditor() {
    const t = topicOf(ed.id);
    const d = getDict(ed.id, ed.lang);
    const mine = userWords(ed.id, ed.lang);
    const name = tName(t, ed.lang);
    $('#edTitle').textContent = name;
    $('#edTitle').classList.toggle('am', hasEth(name));
    $('#edLangSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === ed.lang)));
    const langName = ed.lang === 'am' ? 'Amharic' : 'English';
    const builtIn = d.entries.length - d.entries.filter((e) => e.mine).length;
    $('#edCount').textContent = customTopic(ed.id)
      ? `${mine.length} ${langName} ${mine.length === 1 ? 'word' : 'words'}.${mine.length < 3 ? ' Add at least 3 to play.' : ''}`
      : `${builtIn} built-in ${langName} words, plus ${mine.length} of yours.`;
    $('#edInput').placeholder = customTopic(ed.id) ? 'Type words to add' : ed.lang === 'am' ? 'ለምሳሌ: ሚዳቆ, ቆቅ' : 'e.g. Okapi, Mandrill';
    $('#edInput').lang = ed.lang;
    const ul = $('#edList');
    ul.innerHTML = '';
    if (!mine.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `No ${langName} words of yours yet.`;
      ul.appendChild(li);
    }
    [...mine].reverse().forEach((w) => {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><button type="button" class="x">×</button>';
      li.querySelector('span').textContent = w.replace(/\|/g, ' / ');
      if (hasEth(w)) li.classList.add('am');
      const x = li.querySelector('.x');
      x.setAttribute('aria-label', `Remove ${w}`);
      x.onclick = () => {
        setUserWords(ed.id, ed.lang, userWords(ed.id, ed.lang).filter((v) => v !== w));
        edMsg('', `Removed “${w.split('|')[0]}”.`);
        renderEditor();
      };
      ul.appendChild(li);
    });
  }

  function edMsg(kind, text) {
    $('#edMsg').className = `ed-msg ${kind}`;
    $('#edMsg').textContent = text;
  }

  function initEditor() {
    $('#editWordsBtn').onclick = () => openEditor();
    $('#edClose').onclick = closeEditor;
    $('#wordsOv').addEventListener('click', (e) => { if (e.target.id === 'wordsOv') closeEditor(); });
    $('#edLangSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      ed.lang = b.dataset.v; edMsg('', ''); renderEditor();
    });
    $('#edName').addEventListener('input', (e) => {
      const ct = customTopic(ed.id);
      if (!ct) return;
      ct.name = e.target.value.slice(0, 28);
      saveCustom();
      $('#edTitle').textContent = tName(ct, ed.lang);
    });
    $('#edForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = $('#edInput').value;
      if (!raw.trim()) return;
      const r = addWords(ed.id, ed.lang, raw);
      if (!r.saved) return edMsg('bad', 'Couldn\'t save. This browser is blocking local storage (private window?).');
      const parts = [];
      if (r.added) parts.push(`Added ${r.added} ${r.added === 1 ? 'word' : 'words'}.`);
      if (r.dup) parts.push(`${r.dup} ${r.dup === 1 ? 'was' : 'were'} already in the list.`);
      edMsg(r.added ? 'good' : 'warn', parts.join(' ') || 'Nothing to add.');
      if (r.added) $('#edInput').value = '';
      renderEditor();
    });
    $('#edDelete').onclick = () => {
      if (!ed.confirmDelete) {
        ed.confirmDelete = true;
        $('#edDelete').textContent = 'Tap again to delete';
        return;
      }
      custom.topics = custom.topics.filter((t) => t.id !== ed.id);
      dictCache.delete(`${ed.id}/en`); dictCache.delete(`${ed.id}/am`);
      saveCustom();
      settings.topic = 'animals'; saveSettings();
      $('#wordsOv').hidden = true;
      renderTopics();
    };
    $('#exportBtn').onclick = exportWords;
    $('#importFile').onchange = importWords;
  }

  function exportWords() {
    const blob = new Blob([JSON.stringify({ app: 'fidel-duel', version: 1, ...custom }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fidel-duel-my-words.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    edMsg('good', 'Saved a backup file of all your words.');
  }

  async function importWords(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return edMsg('bad', 'That file isn\'t a Fidel Duel backup.'); }
    if (!data || typeof data !== 'object' || (!data.extra && !data.topics)) return edMsg('bad', 'That file isn\'t a Fidel Duel backup.');
    let words = 0, topics = 0;
    const merge = (id, lang, list) => {
      if (!Array.isArray(list) || !list.length) return;
      words += addWords(id, lang, list.filter((w) => typeof w === 'string').join(',')).added;
    };
    for (const [id, langs] of Object.entries(data.extra || {})) {
      if (!window.TOPICS.some((t) => t.id === id) || !langs) continue;
      merge(id, 'en', langs.en); merge(id, 'am', langs.am);
    }
    for (const t of Array.isArray(data.topics) ? data.topics : []) {
      if (!t || typeof t.id !== 'string') continue;
      if (!customTopic(t.id)) {
        custom.topics.push({ id: t.id, name: String(t.name || 'My topic').slice(0, 28), words: { en: [], am: [] } });
        topics++;
      }
      merge(t.id, 'en', t.words && t.words.en); merge(t.id, 'am', t.words && t.words.am);
    }
    saveCustom();
    edMsg('good', `Restored ${words} ${words === 1 ? 'word' : 'words'}${topics ? ` and ${topics} ${topics === 1 ? 'topic' : 'topics'}` : ''}.`);
    renderEditor();
  }

  function bindSeg(id, key, cast = (v) => v) {
    const seg = $(id);
    const sync = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(cast(b.dataset.v) === settings[key])));
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = cast(b.dataset.v); saveSettings(); sync();
      if (key === 'lang') { renderTopics(); checkVoice(); }
    });
    sync();
  }

  function initSetup() {
    $('#name1').value = settings.names[0];
    $('#name2').value = settings.names[1];
    bindSeg('#langSeg', 'lang');
    bindSeg('#timeSeg', 'baseTime', Number);
    bindSeg('#livesSeg', 'lives', Number);
    for (const [id, key] of [['#optMic', 'mic'], ['#optVoice', 'voice'], ['#optSound', 'sound']]) {
      $(id).checked = settings[key];
      $(id).onchange = (e) => { settings[key] = e.target.checked; saveSettings(); };
    }
    renderTopics();
    checkVoice();
    $('#micTestBtn').onclick = micTest;
    $('#voicePackBtn').onclick = installVoicePack;
    $('#startBtn').onclick = startGame;
    initEditor();
  }

  function micTest() {
    const out = $('#micTestOut');
    const r = newRecognizer();
    r.interimResults = true;
    out.textContent = settings.lang === 'am' ? 'Listening… say an Amharic word.' : 'Listening… say a word.';
    r.onresult = (e) => {
      const res = e.results[e.results.length - 1];
      out.textContent = `Heard: “${res[0].transcript}”${res.isFinal ? '. Recognition works.' : ''}`;
    };
    r.onerror = (e) => {
      out.textContent = {
        'not-allowed': 'Microphone access was blocked. Allow it from the icon in the address bar.',
        'no-speech': 'Didn\'t hear anything. Try again a bit louder.',
        'network': voice.local ? 'The offline voice pack didn\'t respond. Try again.' : 'Couldn\'t reach the speech service. Check your internet connection, or download the offline voice pack.',
        'language-not-supported': 'This browser can\'t recognise that language by voice.',
      }[e.error] || `Microphone error: ${e.error}`;
    };
    try { r.start(); } catch {}
  }

  // ================= game flow =================
  function startGame() {
    if (getDict(settings.topic, settings.lang).entries.length < 3) {
      $('#startMsg').textContent = `“${topicName()}” needs at least 3 ${settings.lang === 'am' ? 'Amharic' : 'English'} words before you can play. Use Edit words to add some.`;
      return;
    }
    settings.names = [$('#name1').value.trim() || 'Player 1', $('#name2').value.trim() || 'Player 2'];
    saveSettings();
    dict = getDict(settings.topic, settings.lang);
    micBlockedMsg = SR ? '' : 'Voice recognition isn\'t available in this browser, so type your answers.';
    netFails = 0;
    S = {
      players: settings.names.map((name) => ({ name, score: 0, lives: settings.lives, streak: 0, bestStreak: 0, words: 0 })),
      cur: 0, round: 1, letter: '', lastLetter: '', used: new Set(), usedFree: new Set(),
      phase: 'spin', timeLeft: 0, total: 0, timer: null, lastTick: 0, history: [],
    };
    $('#setup').hidden = true;
    $('#game').hidden = false;
    $('#overOv').hidden = true;
    $('#topicLabel').textContent = topicName();
    $('#topicLabel').className = 'chip' + (settings.lang === 'am' ? ' am' : '');
    $('#letter').classList.toggle('am', settings.lang === 'am');
    renderBoard(); renderTrail();
    window.scrollTo({ top: 0 });
    // Prime audio + speech engine within the click gesture
    tone(1, 0.01, 'sine', 0.0001);
    startTurn();
  }

  function availableLetters() {
    const m = new Map();
    for (const e of dict.entries) {
      if (S.used.has(e.id)) continue;
      new Set(e.keys.map(letterOf)).forEach((l) => m.set(l, (m.get(l) || 0) + 1));
    }
    return m;
  }
  function pickLetter(avail) {
    let c = [...avail].filter(([, n]) => n >= 2).map(([l]) => l);
    if (!c.length) c = [...avail.keys()];
    if (c.length > 1) c = c.filter((l) => l !== S.lastLetter);
    return c[Math.floor(Math.random() * c.length)];
  }

  function startTurn() {
    const my = ++token;
    const avail = availableLetters();
    if (!avail.size) return endGame('words');
    const L = pickLetter(avail);
    S.letter = L; S.lastLetter = L; S.phase = 'spin';
    const P = S.players[S.cur];
    document.documentElement.style.setProperty('--pc', `var(--p${S.cur + 1})`);
    renderBoard();
    $('#roundLabel').textContent = `Round ${S.round} · ${turnSeconds()}s`;
    $('#turnLine').textContent = `${P.name}'s turn`;
    $('#family').textContent = '';
    $('#secs').textContent = '';
    $('.ring-wrap').classList.remove('danger');
    $('#judge').hidden = true;
    $('#typeInput').value = '';
    setRing(1);
    showHeard('');
    feedback('warn', micBlockedMsg || offlineNote());
    setMicLabel('Drawing a letter…');

    // slot-machine spin through letters, slowing down
    const pool = [...avail.keys()];
    const el = $('#letter');
    el.classList.add('spin'); el.classList.remove('land');
    let i = 0;
    const steps = 14;
    const spinStep = () => {
      if (my !== token) return;
      if (i < steps) {
        el.textContent = showLetter(pool[Math.floor(Math.random() * pool.length)]);
        sfx.click();
        i++;
        setTimeout(spinStep, 30 + i * i * 0.9);
      } else {
        el.textContent = showLetter(L);
        el.classList.remove('spin'); void el.offsetWidth; el.classList.add('land');
        sfx.land();
        if (settings.lang === 'am') $('#family').textContent = familyRow(L);
        announce(`${P.name}. ${L.toUpperCase()}.`).then(() => { if (my === token) beginListening(); });
      }
    };
    spinStep();
  }

  function beginListening() {
    S.phase = 'turn';
    S.total = turnSeconds() * 1000;
    S.timeLeft = S.total;
    setMicLabel(micUsable() ? 'Listening…' : 'Type your word below');
    if (!micUsable()) $('#typeInput').focus();
    runTimer();
    startRecognition();
  }

  function runTimer() {
    clearInterval(S.timer);
    S.lastTick = performance.now();
    let lastSec = Math.ceil(S.timeLeft / 1000);
    S.timer = setInterval(() => {
      const now = performance.now();
      S.timeLeft -= now - S.lastTick;
      S.lastTick = now;
      const sec = Math.max(0, Math.ceil(S.timeLeft / 1000));
      if (sec !== lastSec) { lastSec = sec; if (sec <= 3 && sec > 0) sfx.tick(); }
      setRing(Math.max(0, S.timeLeft / S.total));
      $('#secs').textContent = `${sec}s`;
      $('.ring-wrap').classList.toggle('danger', sec <= 3);
      if (S.timeLeft <= 0) fail('timeout');
    }, 80);
  }
  const stopTimer = () => clearInterval(S && S.timer);

  // ---------- answer checking ----------
  function evaluate(alts) {
    const L = S.letter;
    const rank = { ok: 3, used: 2, wrong: 1 };
    let best = null;
    for (const alt of alts) {
      const toks = normalize(alt).split(' ').filter(Boolean);
      for (let n = Math.min(4, toks.length); n >= 1; n--) {
        for (let i = 0; i + n <= toks.length; i++) {
          const key = toks.slice(i, i + n).join('');
          const hit = lookup(dict, key);
          if (!hit) continue;
          const status = letterOf(hit.key) !== L ? 'wrong' : S.used.has(hit.entry.id) ? 'used' : 'ok';
          const cand = { status, entry: hit.entry, said: hit.entry.names[hit.entry.keys.indexOf(hit.key)] || hit.entry.name };
          if (status === 'ok') return cand;
          if (!best || rank[status] > rank[best.status]) best = cand;
        }
      }
    }
    if (best) return best;
    const heard = (alts[0] || '').trim();
    const toks = normalize(heard).split(' ').filter(Boolean);
    if (S.usedFree.has(toks.join(''))) return { status: 'used', said: heard };
    const startsRight = toks.length > 0 && toks.length <= 4 && letterOf(toks[0]) === L;
    return { status: startsRight ? 'unknown' : 'miss', heard };
  }

  function handleAnswer(alts) {
    if (!S || S.phase !== 'turn') return;
    alts = alts.map((a) => a.trim()).filter(Boolean);
    if (!alts.length) return;
    showHeard(alts[0]);
    const r = evaluate(alts);
    const Ls = showLetter(S.letter);
    switch (r.status) {
      case 'ok': return succeed(r.said, r.entry.id, false);
      case 'used': sfx.nope(); return feedback('bad', `“${r.said}” was already played. Try another.`);
      case 'wrong': sfx.nope(); return feedback('bad', `“${r.said}” doesn't start with ${Ls}.`);
      case 'unknown': return openJudge(r.heard);
      default: sfx.nope(); return feedback('warn', `No ${topicName()} match starting with ${Ls}. Keep going!`);
    }
  }

  function openJudge(word) {
    S.phase = 'judge';
    S.pending = word;
    stopTimer(); stopRecognition();
    const o = opp();
    $('#judgeText').innerHTML = '';
    $('#judgeText').append(
      `“`, Object.assign(document.createElement('b'), { textContent: word }),
      `” isn't in the word list. ${o.name}, does it count for ${topicName()}?`,
    );
    $('#rememberWord').checked = true;
    $('#judge').hidden = false;
    feedback('warn', 'Clock paused for the ruling.');
    setMicLabel('Waiting for a ruling');
    $('#acceptBtn').focus();
  }
  function closeJudge(accepted) {
    if (!S || S.phase !== 'judge') return;
    $('#judge').hidden = true;
    if (accepted) {
      S.usedFree.add(keyOf(S.pending));
      // Saved for future games; this game keeps its own word list so nothing shifts mid-play.
      if ($('#rememberWord').checked) addWords(settings.topic, settings.lang, S.pending.replace(/[,|]/g, ' '));
      succeed(S.pending, null, true);
    } else {
      S.phase = 'turn';
      sfx.nope();
      feedback('bad', `${opp().name} rejected it. Keep trying!`);
      setMicLabel(micUsable() ? 'Listening…' : 'Type your word below');
      runTimer();
      startRecognition();
    }
  }

  function succeed(word, id, judged) {
    token++;
    S.phase = 'result';
    stopTimer(); stopRecognition();
    if (id != null) S.used.add(id);
    const P = S.players[S.cur];
    P.streak++; P.bestStreak = Math.max(P.bestStreak, P.streak); P.words++;
    const secs = Math.max(0, Math.ceil(S.timeLeft / 1000));
    const bonus = P.streak > 1 ? (P.streak - 1) * 25 : 0;
    const pts = (judged ? 60 : 100 + secs * 10) + bonus;
    P.score += pts;
    S.history.push({ p: S.cur, word, letter: S.letter, ok: true });
    sfx.good();
    flash('good');
    const am = settings.lang === 'am' ? ' am' : '';
    $('#feedback').className = 'feedback good';
    $('#feedback').innerHTML = `<span class="big${am}"></span>+${pts} points${bonus ? ` · streak ×${P.streak}` : ''}${judged ? ' · accepted by opponent' : ''}`;
    $('#feedback .big').textContent = word;
    setMicLabel('Correct!');
    renderBoard(); renderTrail();
    const my = token;
    setTimeout(() => { if (my === token) nextTurn(); }, 1600);
  }

  function fail(reason) {
    token++;
    S.phase = 'result';
    stopTimer(); stopRecognition();
    $('#judge').hidden = true;
    const P = S.players[S.cur];
    P.lives--; P.streak = 0;
    S.history.push({ p: S.cur, word: '—', letter: S.letter, ok: false });
    sfx.bad();
    flash('bad');
    const card = $(`#pc${S.cur}`);
    card.classList.remove('hit'); void card.offsetWidth; card.classList.add('hit');
    setRing(0);
    $('#secs').textContent = '';
    const L = S.letter;
    const ideas = dict.entries
      .filter((e) => !S.used.has(e.id))
      .map((e) => e.names.find((_, i) => letterOf(e.keys[i]) === L))
      .filter(Boolean)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    const head = reason === 'pass' ? `${P.name} passed.` : 'Time\'s up!';
    feedback('bad', `${head} ${P.lives > 0 ? `${P.lives} ${P.lives === 1 ? 'life' : 'lives'} left.` : 'No lives left.'}${ideas.length ? ` You could have said: ${ideas.join(', ')}.` : ''}`);
    setMicLabel('Missed');
    renderBoard(); renderTrail();
    const my = token;
    setTimeout(() => { if (my === token) (P.lives <= 0 ? endGame('lives') : nextTurn()); }, 2800);
  }

  function nextTurn() {
    S.cur = 1 - S.cur;
    if (S.cur === 0) S.round++;
    startTurn();
  }

  // ---------- pause ----------
  function pause() {
    if (!S || S.phase !== 'turn') return;
    S.phase = 'paused';
    stopTimer(); stopRecognition();
    $('#pauseOv').hidden = false;
    $('#resumeBtn').focus();
  }
  function resume() {
    if (!S || S.phase !== 'paused') return;
    $('#pauseOv').hidden = true;
    S.phase = 'turn';
    runTimer();
    startRecognition();
  }
  function quitToSetup() {
    token++;
    if (S) { stopTimer(); stopRecognition(); S.phase = 'over'; }
    try { speechSynthesis.cancel(); } catch {}
    $('#pauseOv').hidden = true;
    $('#overOv').hidden = true;
    $('#game').hidden = true;
    $('#setup').hidden = false;
    document.documentElement.style.setProperty('--pc', 'var(--p1)');
  }

  // ---------- end ----------
  function endGame(reason) {
    token++;
    S.phase = 'over';
    stopTimer(); stopRecognition();
    const [a, b] = S.players;
    let w;
    if (a.lives !== b.lives) w = a.lives > b.lives ? 0 : 1;
    else if (a.score !== b.score) w = a.score > b.score ? 0 : 1;
    else w = -1;
    document.documentElement.style.setProperty('--pc', w < 0 ? 'var(--cream)' : `var(--p${w + 1})`);
    $('#overReason').textContent = reason === 'words'
      ? `Every ${topicName().toLowerCase()} word has been played`
      : `${S.players[S.cur].name} ran out of lives in round ${S.round}`;
    $('#winnerText').textContent = w < 0 ? 'It\'s a draw!' : `${S.players[w].name} wins!`;
    $('#finalStats').innerHTML = '';
    S.players.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = `p${i + 1}`;
      d.innerHTML = '<div class="fn"></div><div class="fs"></div><div class="fx"></div>';
      d.querySelector('.fn').textContent = p.name;
      d.querySelector('.fs').textContent = p.score;
      d.querySelector('.fx').textContent = `${p.words} words · best streak ${p.bestStreak} · ${Math.max(0, p.lives)} lives left`;
      $('#finalStats').appendChild(d);
    });
    $('#overOv').hidden = false;
    sfx.win();
    if (w >= 0) confetti(getComputedStyle(document.documentElement).getPropertyValue(`--p${w + 1}`).trim());
    $('#rematchBtn').focus();
  }

  // ================= rendering helpers =================
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.2 4.3 2.4h2c.7-1.2 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';

  function renderBoard() {
    S.players.forEach((p, i) => {
      const c = $(`#pc${i}`);
      c.classList.toggle('active', i === S.cur && S.phase !== 'over');
      c.querySelector('.pname').textContent = p.name;
      c.querySelector('.pscore').textContent = p.score;
      c.querySelector('.plives').innerHTML = Array.from({ length: settings.lives }, (_, k) =>
        HEART.replace('<svg', `<svg class="${k < p.lives ? '' : 'lost'}"`)).join('');
      c.querySelector('.plives').setAttribute('aria-label', `${p.lives} lives`);
      c.querySelector('.pstreak').textContent = p.streak > 1 ? `Streak ×${p.streak}` : '';
    });
  }
  function renderTrail() {
    const ol = $('#trail');
    ol.innerHTML = '';
    if (!S.history.length) {
      ol.innerHTML = '<li class="trail-empty" style="border:0;padding:0">Nothing yet. The first word is coming up.</li>';
      return;
    }
    [...S.history].reverse().forEach((h) => {
      const li = document.createElement('li');
      li.className = `p${h.p + 1}${h.ok ? '' : ' miss'}`;
      li.innerHTML = '<b></b><span class="w"></span>';
      li.querySelector('b').textContent = showLetter(h.letter);
      li.querySelector('.w').textContent = h.ok ? h.word : 'missed';
      if (settings.lang === 'am') li.classList.add('am');
      ol.appendChild(li);
    });
  }
  const setRing = (f) => { $('#ringFg').style.strokeDashoffset = String(628.32 * (1 - f)); };
  const setMic = (on) => { $('#listen').classList.toggle('on', on); };
  const setMicLabel = (t) => { $('#micState').textContent = t; };
  function showHeard(t, interim = false) {
    const h = $('#heard');
    h.textContent = t ? (interim ? `${t}…` : `“${t}”`) : '';
    h.classList.toggle('interim', interim);
  }
  function feedback(kind, text) {
    const f = $('#feedback');
    f.className = `feedback ${kind}`;
    f.textContent = text;
  }
  function flash(kind) {
    const s = $('#stage');
    s.classList.remove('flash-good', 'flash-bad'); void s.offsetWidth;
    s.classList.add(`flash-${kind}`);
  }

  function confetti(color) {
    const cv = $('#confetti'), ctx = cv.getContext('2d');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    cv.width = innerWidth; cv.height = innerHeight;
    const css = getComputedStyle(document.documentElement);
    const colors = [color, css.getPropertyValue('--tilet-green'), css.getPropertyValue('--tilet-red'), css.getPropertyValue('--cream')].map((c) => c.trim());
    const bits = Array.from({ length: 160 }, () => ({
      x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.6,
      vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3, s: 5 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    (function frame(t) {
      if ($('#overOv').hidden || t - t0 > 6000) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
      ctx.clearRect(0, 0, cv.width, cv.height);
      for (const b of bits) {
        b.x += b.vx; b.y += b.vy; b.r += b.vr; b.vy += 0.03;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r);
        ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    })(t0);
  }

  // ================= wiring =================
  $('#typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#typeInput').value.trim();
    if (!v || !S || S.phase !== 'turn') return;
    $('#typeInput').value = '';
    handleAnswer([v]);
  });
  $('#passBtn').onclick = () => { if (S && S.phase === 'turn') fail('pass'); };
  $('#pauseBtn').onclick = pause;
  $('#resumeBtn').onclick = resume;
  $('#quitBtn').onclick = quitToSetup;
  $('#acceptBtn').onclick = () => closeJudge(true);
  $('#rejectBtn').onclick = () => closeJudge(false);
  $('#rematchBtn').onclick = startGame;
  $('#setupBtn').onclick = quitToSetup;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#wordsOv').hidden) return closeEditor();
    if (e.key === 'Escape') { if (S && S.phase === 'turn') pause(); else if (S && S.phase === 'paused') resume(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  function updateNet() {
    $('#netChip').hidden = navigator.onLine;
    if (!$('#setup').hidden) checkVoice();
    if (S && S.phase === 'turn') {
      if (micUsable()) { startRecognition(); setMicLabel('Listening…'); }
      else { stopRecognition(); setMicLabel('Type your word below'); }
    }
  }
  addEventListener('online', updateNet);
  addEventListener('offline', updateNet);
  $('#netChip').hidden = navigator.onLine;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { $('#cacheNote').textContent = 'Saved for offline play'; })
      .catch(() => {});
  }
  let installEvt = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
  addEventListener('appinstalled', () => { $('#installBtn').hidden = true; });
  $('#installBtn').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    $('#installBtn').hidden = true;
  };

  initSetup();
  // exposed for quick console testing
  window.__fidel = { normalize, keyOf, letterOf, getDict };
})();
