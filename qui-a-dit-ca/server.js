// KIADISSA — party game multijoueur entre potes
// Serveur Node.js sans aucune dépendance : http + Server-Sent Events.
// Lancer : node server.js   (puis ouvrir http://localhost:3000)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { packs: PACKS, gages: GAGES } = require("./questions");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_PLAYERS = 12;
const MAX_SPECTATORS = 20;
const MIN_PLAYERS = 3;
const MAX_TEXT = 280;
const MAX_STATEMENT = 140;
const DONE_PAUSE = 1500; // petite pause quand tout le monde a répondu
const MAX_PHOTO = 60000; // taille max d'une photo (dataURL)

const TYPES = ["anecdote", "menteur", "qui", "ouinon", "tuprefs", "phrase", "jamais", "connais"];
const ORDER = ["anecdote", "qui", "tuprefs", "ouinon", "menteur", "jamais", "phrase", "connais"];
const REACTIONS = ["😂", "💀", "🔥", "👀", "😱", "🤡", "❤️", "👏"];

const DEFAULT_SETTINGS = {
  rounds: { anecdote: 1, menteur: 1, qui: 2, ouinon: 2, tuprefs: 1, phrase: 1, jamais: 1, connais: 1 },
  writeTime: 90,
  guessTime: 25,
  voteTime: 25,
  packs: ["normal"],
  gages: true,
  custom: { anecdote: [], qui: [], ouinon: [], tuprefs: [], phrase: [], jamais: [] },
};

const AVATARS = ["🦊", "🐸", "🐼", "🐙", "🦄", "🐲", "👽", "🤖", "👻", "🐵", "🦁", "🐧", "🍕", "🌵", "💀", "🤡", "🐱", "🐶", "🦖", "🐝"];
const COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#748ffc", "#da77f2", "#f783ac", "#adb5bd"];

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- utilitaires ----------
const rid = () => crypto.randomBytes(9).toString("base64url");
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const cleanText = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);

function newRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do code = Array.from({ length: 4 }, () => pick(letters)).join("");
  while (rooms.has(code));
  return code;
}

function parsePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m || dataUrl.length > MAX_PHOTO) return null;
  return { type: "image/" + m[1], buf: Buffer.from(m[2], "base64") };
}

function makePlayer(b) {
  return {
    id: rid(),
    name: cleanText(b.name, 16) || "Joueur",
    avatar: AVATARS.includes(b.avatar) ? b.avatar : pick(AVATARS),
    color: COLORS.includes(b.color) ? b.color : pick(COLORS),
    photo: parsePhoto(b.photo),
    photoV: Date.now().toString(36),
    score: 0,
    stats: {},
    jokerUsed: false,
    reacts: [],
    clients: new Set(),
    joinedAt: Date.now(),
  };
}

const connected = (room) => [...room.players.values()].filter((p) => p.clients.size > 0);
const stat = (p, key, n = 1) => p && (p.stats[key] = (p.stats[key] || 0) + n);
const addScore = (room, pid, n) => {
  const p = room.players.get(pid);
  if (!p) return;
  p.score += n;
  room.r.points[pid] = (room.r.points[pid] || 0) + n;
};
const nameOf = (room, pid) => room.players.get(pid)?.name || "un joueur parti";

// ---------- choix des questions ----------
const poolKey = (type) => (type === "connais" ? "tuprefs" : type);

function pickQuestions(room, type, count) {
  if (type === "menteur") return Array.from({ length: count }, () => ({ q: "2 vérités, 1 mensonge", hot: false }));
  const key = poolKey(type);
  const selected = room.settings.packs.filter((p) => PACKS[p]);
  const hotOnly = selected.length > 0 && selected.every((p) => PACKS[p].hot);
  let custom = (room.settings.custom[key] || []).map((q) => ({ q, hot: hotOnly }));
  if (key === "tuprefs") custom = custom.map((x) => ({ ...x, q: x.q.split("|").map((s) => s.trim()) })).filter((x) => x.q.length >= 2 && x.q[0] && x.q[1]);
  let base = [];
  for (const p of selected) base.push(...(PACKS[p][key] || []).map((q) => ({ q, hot: !!PACKS[p].hot })));
  if (!base.length) base = PACKS.normal[key].map((q) => ({ q, hot: false }));
  const k = (x) => key + ":" + JSON.stringify(x.q);
  let fresh = base.filter((x) => !room.used.has(k(x)));
  if (fresh.length < count) {
    base.forEach((x) => room.used.delete(k(x)));
    fresh = base;
  }
  const out = [...shuffle(custom).filter((x) => !room.used.has(k(x))), ...shuffle(fresh)].slice(0, count);
  out.forEach((x) => room.used.add(k(x)));
  return out;
}

function buildRounds(room) {
  const lists = {};
  for (const t of TYPES) lists[t] = pickQuestions(room, t, room.settings.rounds[t] || 0);
  const rounds = [];
  let added = true;
  while (added) {
    added = false;
    for (const t of ORDER) {
      if (lists[t].length) {
        const { q, hot } = lists[t].shift();
        const round = { type: t, hot };
        if (t === "tuprefs" || t === "connais") round.opts = q;
        else round.question = q;
        rounds.push(round);
        added = true;
      }
    }
  }
  return rounds;
}

// ---------- machine à états ----------
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function setPhase(room, phase, seconds, onEnd) {
  clearTimer(room);
  room.phase = phase;
  room.phaseId = rid();
  room.deadline = seconds ? Date.now() + seconds * 1000 : null;
  room.duration = seconds || 0;
  if (seconds && onEnd) {
    const id = room.phaseId;
    room.timer = setTimeout(() => room.phaseId === id && onEnd(room), seconds * 1000);
  }
  broadcast(room);
}

function startGame(room) {
  room.rounds = buildRounds(room);
  if (!room.rounds.length) return;
  for (const p of room.players.values()) {
    p.score = 0;
    p.stats = {};
    p.jokerUsed = false;
  }
  room.history = [];
  room.recap = [];
  room.gage = null;
  room.connaisDone = new Set();
  room.roundIndex = -1;
  nextRound(room);
}

function nextRound(room) {
  room.roundIndex++;
  if (room.roundIndex >= room.rounds.length) return endGame(room);
  const round = room.rounds[room.roundIndex];
  const s = room.settings;
  room.r = { ...round, subs: new Map(), items: [], idx: 0, votes: new Map(), preds: new Map(), points: {}, reveal: null };

  switch (round.type) {
    case "anecdote":
    case "phrase":
      return setPhase(room, "write", s.writeTime, endWrite);
    case "menteur":
      room.r.question = "2 vérités, 1 mensonge";
      return setPhase(room, "write", Math.round(s.writeTime * 1.5), endWrite);
    case "tuprefs":
      room.r.question = "Tu préfères…";
      return setPhase(room, "vote", s.voteTime, endVote);
    case "connais": {
      const cands = connected(room).filter((p) => !room.connaisDone.has(p.id));
      const target = pick(cands.length ? cands : connected(room));
      if (!target) return nextRound(room);
      room.connaisDone.add(target.id);
      room.r.target = target.id;
      room.r.question = `Qui connaît le mieux ${target.name} ?`;
      return setPhase(room, "vote", s.voteTime, endVote);
    }
    default:
      return setPhase(room, "vote", s.voteTime, endVote);
  }
}

// --- fin de la phase d'écriture ---
function endWrite(room) {
  const r = room.r;
  const subs = [...r.subs.entries()].filter(([pid]) => room.players.has(pid));
  if (r.type === "phrase") {
    r.items = shuffle(subs.map(([pid, text]) => ({ id: rid(), author: pid, text })));
    if (r.items.length < 2) return finishRound(room);
    return setPhase(room, "vote", room.settings.voteTime + 10, endVote);
  }
  r.items = shuffle(
    subs.map(([pid, sub]) => {
      const item = { id: rid(), author: pid, votes: new Map() };
      if (r.type === "anecdote") item.text = sub;
      else {
        // menteur : on mélange l'ordre des 3 phrases
        const order = shuffle([0, 1, 2]);
        item.statements = order.map((i) => sub.s[i]);
        item.lie = order.indexOf(sub.lie);
      }
      return item;
    })
  );
  if (!r.items.length) return finishRound(room);
  r.idx = 0;
  setPhase(room, "guess", room.settings.guessTime, endGuess);
}

function endGuess(room) {
  const r = room.r;
  r.idx++;
  if (r.idx < r.items.length) return setPhase(room, "guess", room.settings.guessTime, endGuess);
  finishRound(room);
}

function endVote(room) {
  finishRound(room);
}

// --- calcul des résultats d'une manche ---
function finishRound(room) {
  const r = room.r;
  const P = (id) => room.players.get(id);
  let rv = {};

  switch (r.type) {
    case "anecdote":
    case "menteur": {
      rv.items = r.items.map((it) => {
        const votes = [];
        for (const [voter, v] of it.votes) {
          const ok = r.type === "anecdote" ? v.t === it.author : v.t === it.lie;
          if (ok) {
            addScore(room, voter, v.dbl ? 2 : 1);
            stat(P(voter), "found");
          } else {
            if (v.dbl) addScore(room, voter, -1);
            addScore(room, it.author, 1);
            stat(P(it.author), "fooled");
          }
          votes.push({ voter, target: v.t, dbl: !!v.dbl, ok });
        }
        if (r.type === "anecdote") room.recap.push(`📝 « ${it.text} » — ${nameOf(room, it.author)}`);
        else room.recap.push(`🤥 ${nameOf(room, it.author)} : le mensonge était « ${it.statements[it.lie]} »`);
        return { author: it.author, text: it.text, statements: it.statements, lie: it.lie, votes };
      });
      break;
    }
    case "phrase": {
      const tally = {};
      for (const [voter, itemId] of r.votes) (tally[itemId] ||= []).push(voter);
      rv.items = r.items
        .map((it) => ({ author: it.author, text: it.text, voters: tally[it.id] || [] }))
        .sort((a, b) => b.voters.length - a.voters.length);
      for (const it of rv.items) {
        if (it.voters.length) {
          addScore(room, it.author, it.voters.length);
          stat(P(it.author), "funny", it.voters.length);
        }
      }
      if (rv.items[0]?.voters.length) room.recap.push(`😂 « ${r.question} » ${rv.items[0].text} — ${nameOf(room, rv.items[0].author)}`);
      break;
    }
    case "qui": {
      const tally = {};
      for (const [voter, target] of r.votes) (tally[target] ||= []).push(voter);
      rv.tally = tally;
      const max = Math.max(0, ...Object.values(tally).map((v) => v.length));
      const winners = Object.keys(tally).filter((k) => tally[k].length === max && max > 0);
      for (const [target, voters] of Object.entries(tally)) stat(P(target), "balance", voters.length);
      room.history.push({ question: r.question, winners });
      if (winners.length) room.recap.push(`👉 ${r.question} ${winners.map((w) => nameOf(room, w)).join(", ")}`);
      break;
    }
    case "ouinon": {
      let oui = 0, non = 0;
      for (const [, t] of r.votes) t === "oui" ? oui++ : non++;
      rv.counts = { oui, non };
      rv.preds = [];
      for (const [pid, n] of r.preds) {
        const diff = Math.abs(n - oui);
        const pts = diff === 0 ? 2 : diff === 1 ? 1 : 0;
        if (pts) addScore(room, pid, pts);
        if (diff === 0) stat(P(pid), "voyant");
        rv.preds.push({ pid, n, pts });
      }
      room.recap.push(`✅ ${r.question} → ${oui} oui / ${non} non`);
      break;
    }
    case "tuprefs": {
      rv.choices = { 0: [], 1: [] };
      for (const [pid, c] of r.votes) rv.choices[c].push(pid);
      room.recap.push(`🤔 ${r.opts[0]} (${rv.choices[0].length}) VS ${r.opts[1]} (${rv.choices[1].length})`);
      break;
    }
    case "jamais": {
      rv.did = [];
      rv.never = [];
      for (const [pid, c] of r.votes) {
        if (c === "did") {
          rv.did.push(pid);
          stat(P(pid), "jamais");
        } else rv.never.push(pid);
      }
      room.recap.push(`🍺 ${r.question} → déjà fait : ${rv.did.map((id) => nameOf(room, id)).join(", ") || "personne"}`);
      break;
    }
    case "connais": {
      const answer = r.votes.get(r.target);
      rv.answer = answer ?? null;
      rv.guesses = [];
      for (const [pid, c] of r.votes) {
        if (pid === r.target) continue;
        const ok = answer != null && c === answer;
        if (ok) {
          addScore(room, pid, 1);
          stat(P(pid), "connais");
        }
        rv.guesses.push({ pid, choice: c, ok });
      }
      if (answer != null) room.recap.push(`🧠 ${nameOf(room, r.target)} préfère : ${r.opts[answer]}`);
      break;
    }
  }
  rv.points = r.points;
  r.reveal = rv;
  setPhase(room, "reveal");
}

// --- fin de partie ---
const TITLES = [
  { key: "found", emoji: "🕵️", title: "Le détective" },
  { key: "fooled", emoji: "🤥", title: "Le plus gros menteur" },
  { key: "balance", emoji: "🎯", title: "Le plus balancé" },
  { key: "funny", emoji: "😂", title: "Le plus drôle" },
  { key: "jamais", emoji: "🍺", title: "Le plus expérimenté" },
  { key: "voyant", emoji: "🔮", title: "Le voyant" },
  { key: "connais", emoji: "🧠", title: "Connaît tout le monde par cœur" },
];

function endGame(room) {
  const players = [...room.players.values()];
  const titles = [];
  for (const t of TITLES) {
    const max = Math.max(0, ...players.map((p) => p.stats[t.key] || 0));
    if (max > 0) titles.push({ ...t, ids: players.filter((p) => (p.stats[t.key] || 0) === max).map((p) => p.id), value: max });
  }
  room.endTitles = titles;
  room.gage = null;
  if (room.settings.gages && players.length >= 2) {
    const min = Math.min(...players.map((p) => p.score));
    const loser = pick(players.filter((p) => p.score === min));
    const hot = room.settings.packs.includes("hot");
    room.gage = { pid: loser.id, text: pick(hot && Math.random() < 0.6 ? GAGES.hot : GAGES.normal) };
  }
  setPhase(room, "end");
}

// --- tout le monde a répondu ? ---
function expected(room) {
  const ids = connected(room).map((p) => p.id);
  if (room.phase === "guess") {
    const it = room.r.items[room.r.idx];
    return ids.filter((id) => id !== it.author);
  }
  return ids;
}
function acted(room) {
  if (room.phase === "write") return room.r.subs;
  if (room.phase === "guess") return room.r.items[room.r.idx].votes;
  return room.r.votes;
}
function checkAllDone(room) {
  if (!["write", "guess", "vote"].includes(room.phase)) return;
  const exp = expected(room);
  if (!exp.length) return;
  const a = acted(room);
  if (!exp.every((id) => a.has(id))) return;
  const phase = room.phase;
  const fn = phase === "write" ? endWrite : phase === "guess" ? endGuess : endVote;
  clearTimer(room);
  const id = rid();
  room.phaseId = id;
  room.deadline = Date.now() + DONE_PAUSE;
  room.duration = DONE_PAUSE / 1000;
  broadcast(room);
  room.timer = setTimeout(() => room.phaseId === id && fn(room), DONE_PAUSE);
}

// ---------- actions des joueurs ----------
function handleAction(room, player, body) {
  const isHost = room.hostId === player.id;
  const r = room.r;

  switch (body.type) {
    case "settings": {
      if (!isHost || room.phase !== "lobby") return "Seul l'hôte peut modifier les réglages.";
      const s = body.settings || {};
      const cur = room.settings;
      const lines = (txt) => String(txt || "").split("\n").map((l) => cleanText(l, 200)).filter(Boolean).slice(0, 50);
      const rounds = {};
      for (const t of TYPES) rounds[t] = clampInt(s.rounds?.[t], 0, 10, cur.rounds[t]);
      const packs = Array.isArray(s.packs) ? s.packs.filter((p) => PACKS[p]) : cur.packs;
      const custom = {};
      for (const k of Object.keys(DEFAULT_SETTINGS.custom)) custom[k] = s.custom ? lines(s.custom[k]) : cur.custom[k];
      room.settings = {
        rounds,
        writeTime: clampInt(s.writeTime, 20, 300, cur.writeTime),
        guessTime: clampInt(s.guessTime, 10, 120, cur.guessTime),
        voteTime: clampInt(s.voteTime, 10, 120, cur.voteTime),
        packs: packs.length ? packs : ["normal"],
        gages: typeof s.gages === "boolean" ? s.gages : cur.gages,
        custom,
      };
      broadcast(room);
      return null;
    }
    case "start": {
      if (!isHost) return "Seul l'hôte peut lancer la partie.";
      if (room.phase !== "lobby" && room.phase !== "end") return "Partie déjà en cours.";
      if (connected(room).length < MIN_PLAYERS) return `Il faut au moins ${MIN_PLAYERS} joueurs connectés.`;
      if (!TYPES.some((t) => room.settings.rounds[t] > 0)) return "Ajoute au moins une manche.";
      startGame(room);
      return null;
    }
    case "lobby": {
      if (!isHost || room.phase !== "end") return null;
      setPhase(room, "lobby");
      return null;
    }
    case "submit": {
      if (room.phase !== "write") return null;
      if (r.type === "menteur") {
        const st = Array.isArray(body.statements) ? body.statements.slice(0, 3).map((x) => cleanText(x, MAX_STATEMENT)) : [];
        const lie = clampInt(body.lie, 0, 2, -1);
        if (st.length !== 3 || st.some((x) => !x)) return "Écris tes 3 phrases.";
        if (lie < 0) return "Choisis laquelle est le mensonge.";
        r.subs.set(player.id, { s: st, lie });
      } else {
        const text = cleanText(body.text, MAX_TEXT);
        if (!text) return "Ta réponse est vide.";
        r.subs.set(player.id, text);
      }
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "guess": {
      if (room.phase !== "guess") return null;
      const it = r.items[r.idx];
      if (!it || it.id !== body.itemId) return null;
      if (it.author === player.id) return "C'est la tienne, chut 🤫";
      let t;
      if (r.type === "anecdote") {
        if (!room.players.has(body.target)) return null;
        t = body.target;
      } else {
        t = clampInt(body.target, 0, 2, -1);
        if (t < 0) return null;
      }
      it.votes.set(player.id, { t, dbl: !!body.dbl });
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "vote": {
      if (room.phase !== "vote" || !r) return null;
      const t = body.target;
      switch (r.type) {
        case "qui":
          if (!room.players.has(t)) return null;
          break;
        case "ouinon":
          if (t !== "oui" && t !== "non") return null;
          break;
        case "tuprefs":
        case "connais":
          if (t !== 0 && t !== 1) return null;
          break;
        case "jamais":
          if (t !== "did" && t !== "never") return null;
          break;
        case "phrase": {
          const it = r.items.find((x) => x.id === t);
          if (!it) return null;
          if (it.author === player.id) return "Tu ne peux pas voter pour ta propre réponse 😏";
          break;
        }
        default:
          return null;
      }
      r.votes.set(player.id, t);
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "predict": {
      if (room.phase !== "vote" || r.type !== "ouinon") return null;
      r.preds.set(player.id, clampInt(body.n, 0, MAX_PLAYERS, 0));
      broadcast(room);
      return null;
    }
    case "next": {
      if (!isHost) return null;
      if (room.phase === "reveal") nextRound(room);
      return null;
    }
    case "skip": {
      if (!isHost) return null;
      if (room.phase === "write") endWrite(room);
      else if (room.phase === "guess") endGuess(room);
      else if (room.phase === "vote") endVote(room);
      return null;
    }
    case "kick": {
      if (!isHost || body.target === player.id) return null;
      const target = room.players.get(body.target);
      if (!target) return null;
      for (const res of target.clients) {
        sendEvent(res, { kicked: true });
        res.end();
      }
      room.players.delete(target.id);
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "joker": {
      if (room.phase !== "reveal" && room.phase !== "end") return "Le joker s'utilise pendant les révélations.";
      if (player.jokerUsed) return "Tu as déjà utilisé ton joker 🃏";
      if (!room.players.has(body.target) || body.target === player.id) return null;
      player.jokerUsed = true;
      emitAll(room, { type: "joker", from: player.id, target: body.target });
      broadcast(room);
      return null;
    }
    default:
      return "Action inconnue.";
  }
}

// réactions emoji : joueurs et spectateurs
function handleReact(room, viewer, emoji) {
  if (!REACTIONS.includes(emoji)) return;
  const now = Date.now();
  viewer.reacts = (viewer.reacts || []).filter((t) => now - t < 2000);
  if (viewer.reacts.length >= 6) return;
  viewer.reacts.push(now);
  emitAll(room, { type: "react", emoji, from: viewer.id });
}

// ---------- vue envoyée à chaque joueur ----------
function publicPlayer(room, p) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    photo: p.photo ? `/avatar/${room.code}/${p.id}?v=${p.photoV}` : null,
    score: p.score,
    connected: p.clients.size > 0,
    jokerUsed: p.jokerUsed,
  };
}

function viewFor(room, viewer, spectator = false) {
  const r = room.r;
  const me = viewer.id;
  const v = {
    code: room.code,
    me,
    spectator,
    hostId: room.hostId,
    players: [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => publicPlayer(room, p)),
    spectators: [...room.spectators.values()].filter((s) => s.clients.size).map((s) => ({ id: s.id, name: s.name })),
    phase: room.phase,
    settings: room.settings,
    packsInfo: Object.fromEntries(Object.entries(PACKS).map(([k, p]) => [k, { label: p.label, emoji: p.emoji, hot: !!p.hot }])),
    deadline: room.deadline,
    duration: room.duration || 0,
    now: Date.now(),
    roundNum: room.roundIndex + 1,
    totalRounds: room.rounds?.length || 0,
    round: r && room.phase !== "lobby" && room.phase !== "end" ? { type: r.type, question: r.question, opts: r.opts, hot: !!r.hot, target: r.target } : null,
    minPlayers: MIN_PLAYERS,
    maxText: MAX_TEXT,
    maxStatement: MAX_STATEMENT,
    reactions: REACTIONS,
  };

  switch (room.phase) {
    case "write":
      v.done = [...r.subs.keys()];
      v.mySub = r.subs.get(me) || null;
      break;
    case "guess": {
      const it = r.items[r.idx];
      v.item = { id: it.id, index: r.idx + 1, total: r.items.length };
      if (r.type === "anecdote") v.item.text = it.text;
      else {
        v.item.author = it.author;
        v.item.statements = it.statements;
      }
      v.isMine = it.author === me;
      const mv = it.votes.get(me);
      v.myVote = mv ? mv.t : null;
      v.myDbl = mv ? mv.dbl : false;
      v.done = [...it.votes.keys()];
      v.expected = expected(room).length;
      break;
    }
    case "vote":
      v.myVote = r.votes.has(me) ? r.votes.get(me) : null;
      v.done = [...r.votes.keys()];
      v.expected = expected(room).length;
      if (r.type === "phrase") {
        v.answers = r.items.map((it) => ({ id: it.id, text: it.text, mine: it.author === me }));
      }
      if (r.type === "ouinon") v.myPred = r.preds.has(me) ? r.preds.get(me) : null;
      break;
    case "reveal":
      v.reveal = r.reveal;
      break;
    case "end":
      v.titles = room.endTitles;
      v.quiTitles = {};
      for (const h of room.history || []) for (const w of h.winners) (v.quiTitles[w] ||= []).push(h.question);
      v.gage = room.gage;
      v.recap = room.recap;
      break;
  }
  return v;
}

// ---------- SSE ----------
function sendEvent(res, data, event) {
  try {
    res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

function viewers(room) {
  return [...[...room.players.values()].map((p) => [p, false]), ...[...room.spectators.values()].map((s) => [s, true])];
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const [vw, spec] of viewers(room)) {
    if (!vw.clients.size) continue;
    const view = viewFor(room, vw, spec);
    for (const res of vw.clients) sendEvent(res, view);
  }
}

function emitAll(room, data) {
  for (const [vw] of viewers(room)) for (const res of vw.clients) sendEvent(res, data, "fx");
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.clients.size) return;
  const next = connected(room).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (next) room.hostId = next.id;
}

// ---------- HTTP ----------
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 20000) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? "/index.html" : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
  fs.readFile(full, (err, buf) => {
    if (err) {
      // toutes les URLs inconnues (ex: /ABCD) renvoient le jeu
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => {
        if (e2) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(idx);
      });
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

function findViewer(room, id) {
  if (!room) return null;
  if (room.players.has(id)) return { v: room.players.get(id), spec: false };
  if (room.spectators.has(id)) return { v: room.spectators.get(id), spec: true };
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/create") {
    const b = await readBody(req, 80000);
    const code = newRoomCode();
    const host = makePlayer(b);
    rooms.set(code, {
      code,
      hostId: host.id,
      players: new Map([[host.id, host]]),
      spectators: new Map(),
      phase: "lobby",
      settings: structuredClone(DEFAULT_SETTINGS),
      used: new Set(),
      roundIndex: -1,
      rounds: [],
      r: null,
      lastActive: Date.now(),
    });
    return json(res, 200, { code, pid: host.id });
  }

  if (req.method === "POST" && p === "/api/join") {
    const b = await readBody(req, 80000);
    const room = rooms.get(String(b.code || "").toUpperCase().trim());
    if (!room) return json(res, 404, { error: "Cette salle n'existe pas." });
    const name = cleanText(b.name, 16);
    if (b.spectate) {
      if (room.spectators.size >= MAX_SPECTATORS) return json(res, 409, { error: "Trop de spectateurs." });
      const s = { id: rid(), name: name || "Spectateur", clients: new Set(), reacts: [] };
      room.spectators.set(s.id, s);
      return json(res, 200, { code: room.code, pid: s.id, spectator: true });
    }
    if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: "La salle est pleine (tu peux rejoindre en spectateur)." });
    if ([...room.players.values()].some((pl) => pl.name.toLowerCase() === name.toLowerCase()))
      return json(res, 409, { error: "Ce pseudo est déjà pris dans la salle." });
    const player = makePlayer(b);
    room.players.set(player.id, player);
    broadcast(room);
    return json(res, 200, { code: room.code, pid: player.id });
  }

  if (req.method === "POST" && p === "/api/action") {
    const b = await readBody(req);
    const room = rooms.get(String(b.code || "").toUpperCase());
    const found = findViewer(room, b.pid);
    if (!found) return json(res, 404, { error: "Session expirée." });
    if (b.type === "react") {
      handleReact(room, found.v, b.emoji);
      return json(res, 200, { ok: true });
    }
    if (found.spec) return json(res, 403, { error: "Les spectateurs ne peuvent pas jouer 👀" });
    const err = handleAction(room, found.v, b);
    return json(res, err ? 400 : 200, err ? { error: err } : { ok: true });
  }

  if (req.method === "GET" && p.startsWith("/avatar/")) {
    const [, , code, pid] = p.split("/");
    const pl = rooms.get(code)?.players.get(pid);
    if (!pl?.photo) return json(res, 404, { error: "no photo" });
    res.writeHead(200, { "Content-Type": pl.photo.type, "Cache-Control": "public, max-age=86400" });
    return res.end(pl.photo.buf);
  }

  if (req.method === "GET" && p === "/events") {
    const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
    const found = findViewer(room, url.searchParams.get("pid"));
    if (!found) return json(res, 404, { error: "Session expirée." });
    const vw = found.v;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    vw.clients.add(res);
    ensureHost(room);
    broadcast(room);
    req.on("close", () => {
      vw.clients.delete(res);
      broadcast(room);
      // si l'hôte part, on attend un peu avant de passer le rôle à quelqu'un d'autre
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        ensureHost(room);
        broadcast(room);
        checkAllDone(room);
      }, 8000);
    });
    return;
  }

  if (req.method === "GET" && p === "/api/check") {
    const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
    const ok = !!findViewer(room, url.searchParams.get("pid"));
    return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === "GET" && p === "/health") return json(res, 200, { ok: true, rooms: rooms.size });

  if (req.method === "GET") return serveStatic(req, res, p);
  json(res, 405, { error: "method not allowed" });
});

// Heartbeat (garde les connexions ouvertes derrière les proxys) + ménage des salles vides
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [vw] of viewers(room))
      for (const res of vw.clients) {
        try {
          res.write(": ping\n\n");
        } catch {}
      }
    const anyone = viewers(room).some(([vw]) => vw.clients.size);
    if (!anyone && now - room.lastActive > 30 * 60 * 1000) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 15000);

server.listen(PORT, () => console.log(`🎉 KIADISSA -> http://localhost:${PORT}`));
