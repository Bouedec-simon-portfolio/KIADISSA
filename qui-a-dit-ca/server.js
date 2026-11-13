// KIADISSA — party game multijoueur (anecdotes, "qui est le plus…", oui/non)
// Serveur Node.js sans aucune dépendance : http + Server-Sent Events.
// Lancer : node server.js   (puis ouvrir http://localhost:3000)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QUESTIONS = require("./questions");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const MAX_ANECDOTE = 280;
const REVEAL_PAUSE = 1500; // petite pause quand tout le monde a répondu

const DEFAULT_SETTINGS = {
  anecdoteRounds: 2,
  quiRounds: 3,
  ouinonRounds: 3,
  writeTime: 90,
  guessTime: 25,
  voteTime: 25,
  mode: "normal", // "normal" | "hot" | "mix"
  custom: { anecdote: [], qui: [], ouinon: [] },
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
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const cleanText = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);

function newRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makePlayer(name, avatar, color) {
  return {
    id: rid(),
    name: cleanText(name, 16) || "Joueur",
    avatar: AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)],
    color: COLORS.includes(color) ? color : COLORS[Math.floor(Math.random() * COLORS.length)],
    score: 0,
    clients: new Set(),
    joinedAt: Date.now(),
  };
}

const connected = (room) => [...room.players.values()].filter((p) => p.clients.size > 0);

// ---------- construction de la partie ----------
function pickQuestions(type, count, room) {
  const mode = room.settings.mode;
  const custom = shuffle(room.settings.custom[type] || []).map((q) => ({ q, hot: mode === "hot" }));
  let base = [];
  if (mode !== "hot") base.push(...QUESTIONS[type].map((q) => ({ q, hot: false })));
  if (mode !== "normal") base.push(...QUESTIONS.hot[type].map((q) => ({ q, hot: true })));
  let fresh = base.filter((x) => !room.usedQuestions.has(x.q));
  // banque épuisée : on recommence à zéro
  if (fresh.length < count) {
    base.forEach((x) => room.usedQuestions.delete(x.q));
    fresh = base;
  }
  const picked = [...custom, ...shuffle(fresh)].slice(0, count);
  picked.forEach((x) => room.usedQuestions.add(x.q));
  return picked;
}

function buildRounds(room) {
  const s = room.settings;
  const lists = {
    anecdote: pickQuestions("anecdote", s.anecdoteRounds, room),
    qui: pickQuestions("qui", s.quiRounds, room),
    ouinon: pickQuestions("ouinon", s.ouinonRounds, room),
  };
  // On alterne les types : anecdote, qui, ouinon, anecdote, ...
  const rounds = [];
  const order = ["anecdote", "qui", "ouinon"];
  let added = true;
  while (added) {
    added = false;
    for (const t of order) {
      if (lists[t].length) {
        const { q, hot } = lists[t].shift();
        rounds.push({ type: t, question: q, hot });
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
  room.deadline = seconds ? Date.now() + seconds * 1000 : null;
  room.duration = seconds || 0;
  if (seconds && onEnd) room.timer = setTimeout(() => onEnd(room), seconds * 1000);
  broadcast(room);
}

function startGame(room) {
  room.rounds = buildRounds(room);
  if (!room.rounds.length) return;
  for (const p of room.players.values()) p.score = 0;
  room.history = [];
  room.roundIndex = -1;
  nextRound(room);
}

function nextRound(room) {
  room.roundIndex++;
  if (room.roundIndex >= room.rounds.length) {
    setPhase(room, "end");
    return;
  }
  const round = room.rounds[room.roundIndex];
  room.votes = new Map();
  room.anecdotes = [];
  room.guessIndex = 0;
  room.roundPoints = new Map();
  if (round.type === "anecdote") {
    room.submissions = new Map();
    setPhase(room, "write", room.settings.writeTime, endWrite);
  } else {
    setPhase(room, "vote", room.settings.voteTime, endVote);
  }
}

// --- anecdotes ---
function endWrite(room) {
  if (room.phase !== "write") return;
  room.anecdotes = shuffle(
    [...room.submissions.entries()]
      .filter(([pid, text]) => text && room.players.has(pid))
      .map(([pid, text]) => ({ id: rid(), author: pid, text, votes: new Map() }))
  );
  if (room.anecdotes.length === 0) {
    room.history.push({ type: "anecdote", question: currentRound(room).question, empty: true });
    setPhase(room, "anecReveal");
    return;
  }
  room.guessIndex = 0;
  setPhase(room, "guess", room.settings.guessTime, endGuess);
}

function endGuess(room) {
  if (room.phase !== "guess") return;
  room.guessIndex++;
  if (room.guessIndex < room.anecdotes.length) {
    setPhase(room, "guess", room.settings.guessTime, endGuess);
    return;
  }
  // Résultats : +1 par bonne réponse, +1 à l'auteur pour chaque joueur trompé
  for (const a of room.anecdotes) {
    for (const [voter, target] of a.votes) {
      const v = room.players.get(voter);
      if (target === a.author) {
        if (v) v.score += 1;
        room.roundPoints.set(voter, (room.roundPoints.get(voter) || 0) + 1);
      } else {
        const author = room.players.get(a.author);
        if (author) author.score += 1;
        room.roundPoints.set(a.author, (room.roundPoints.get(a.author) || 0) + 1);
      }
    }
  }
  setPhase(room, "anecReveal");
}

// --- votes (qui / ouinon) ---
function endVote(room) {
  if (room.phase !== "vote") return;
  const round = currentRound(room);
  if (round.type === "qui") {
    const tally = {};
    for (const [, target] of room.votes) tally[target] = (tally[target] || 0) + 1;
    let best = 0;
    for (const n of Object.values(tally)) best = Math.max(best, n);
    const winners = Object.keys(tally).filter((k) => tally[k] === best && best > 0);
    room.history.push({ type: "qui", question: round.question, winners });
  }
  setPhase(room, "voteReveal");
}

function currentRound(room) {
  return room.rounds[room.roundIndex];
}

function checkAllDone(room) {
  const active = connected(room).map((p) => p.id);
  if (!active.length) return;
  let done = false;
  if (room.phase === "write") done = active.every((id) => room.submissions.has(id));
  else if (room.phase === "guess") {
    const a = room.anecdotes[room.guessIndex];
    done = active.filter((id) => id !== a.author).every((id) => a.votes.has(id));
  } else if (room.phase === "vote") done = active.every((id) => room.votes.has(id));
  if (done) {
    const phase = room.phase;
    const marker = `${room.roundIndex}:${room.guessIndex}:${phase}`;
    clearTimer(room);
    room.deadline = Date.now() + REVEAL_PAUSE;
    room.duration = REVEAL_PAUSE / 1000;
    broadcast(room);
    room.timer = setTimeout(() => {
      if (`${room.roundIndex}:${room.guessIndex}:${room.phase}` !== marker) return;
      if (phase === "write") endWrite(room);
      else if (phase === "guess") endGuess(room);
      else endVote(room);
    }, REVEAL_PAUSE);
  }
}

// ---------- actions des joueurs ----------
function handleAction(room, player, body) {
  const isHost = room.hostId === player.id;
  const round = room.rounds?.[room.roundIndex];

  switch (body.type) {
    case "settings": {
      if (!isHost || room.phase !== "lobby") return "Seul l'hôte peut modifier les réglages.";
      const s = body.settings || {};
      const splitLines = (txt) =>
        String(txt || "")
          .split("\n")
          .map((l) => cleanText(l, 200))
          .filter(Boolean)
          .slice(0, 50);
      room.settings = {
        anecdoteRounds: clampInt(s.anecdoteRounds, 0, 10, room.settings.anecdoteRounds),
        quiRounds: clampInt(s.quiRounds, 0, 15, room.settings.quiRounds),
        ouinonRounds: clampInt(s.ouinonRounds, 0, 15, room.settings.ouinonRounds),
        writeTime: clampInt(s.writeTime, 20, 300, room.settings.writeTime),
        guessTime: clampInt(s.guessTime, 10, 120, room.settings.guessTime),
        voteTime: clampInt(s.voteTime, 10, 120, room.settings.voteTime),
        mode: ["normal", "hot", "mix"].includes(s.mode) ? s.mode : room.settings.mode,
        custom: s.custom
          ? { anecdote: splitLines(s.custom.anecdote), qui: splitLines(s.custom.qui), ouinon: splitLines(s.custom.ouinon) }
          : room.settings.custom,
      };
      broadcast(room);
      return null;
    }
    case "start": {
      if (!isHost) return "Seul l'hôte peut lancer la partie.";
      if (room.phase !== "lobby" && room.phase !== "end") return "Partie déjà en cours.";
      if (connected(room).length < MIN_PLAYERS) return `Il faut au moins ${MIN_PLAYERS} joueurs connectés.`;
      const s = room.settings;
      if (s.anecdoteRounds + s.quiRounds + s.ouinonRounds === 0) return "Ajoute au moins une manche.";
      startGame(room);
      return null;
    }
    case "lobby": {
      if (!isHost || room.phase !== "end") return null;
      clearTimer(room);
      room.phase = "lobby";
      room.deadline = null;
      room.duration = 0;
      broadcast(room);
      return null;
    }
    case "submit": {
      if (room.phase !== "write") return null;
      const text = cleanText(body.text, MAX_ANECDOTE);
      if (!text) return "Ton anecdote est vide.";
      room.submissions.set(player.id, text);
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "guess": {
      if (room.phase !== "guess") return null;
      const a = room.anecdotes[room.guessIndex];
      if (!a || a.id !== body.anecdoteId) return null;
      if (a.author === player.id) return "C'est ton anecdote, chut 🤫";
      if (!room.players.has(body.target)) return null;
      a.votes.set(player.id, body.target);
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "vote": {
      if (room.phase !== "vote" || !round) return null;
      if (round.type === "qui") {
        if (!room.players.has(body.target)) return null;
        room.votes.set(player.id, body.target);
      } else {
        if (body.target !== "oui" && body.target !== "non") return null;
        room.votes.set(player.id, body.target);
      }
      broadcast(room);
      checkAllDone(room);
      return null;
    }
    case "next": {
      if (!isHost) return null;
      if (room.phase === "anecReveal" || room.phase === "voteReveal") nextRound(room);
      return null;
    }
    case "skip": {
      // l'hôte peut couper le timer en cours
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
    default:
      return "Action inconnue.";
  }
}

// ---------- vue envoyée à chaque joueur ----------
function publicPlayer(p) {
  return { id: p.id, name: p.name, avatar: p.avatar, color: p.color, score: p.score, connected: p.clients.size > 0 };
}

function viewFor(room, me) {
  const round = room.rounds?.[room.roundIndex];
  const v = {
    code: room.code,
    me: me.id,
    hostId: room.hostId,
    players: [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(publicPlayer),
    phase: room.phase,
    settings: room.settings,
    deadline: room.deadline,
    duration: room.duration || 0,
    now: Date.now(),
    roundNum: room.roundIndex + 1,
    totalRounds: room.rounds?.length || 0,
    round: round ? { type: round.type, question: round.question, hot: !!round.hot } : null,
    minPlayers: MIN_PLAYERS,
    maxAnecdote: MAX_ANECDOTE,
  };

  switch (room.phase) {
    case "write":
      v.done = [...room.submissions.keys()];
      v.myText = room.submissions.get(me.id) || "";
      break;
    case "guess": {
      const a = room.anecdotes[room.guessIndex];
      v.anecdote = { id: a.id, text: a.text, index: room.guessIndex + 1, total: room.anecdotes.length };
      v.isMine = a.author === me.id;
      v.myVote = a.votes.get(me.id) || null;
      v.done = [...a.votes.keys()];
      v.waitingFor = connected(room).map((p) => p.id).filter((id) => id !== a.author);
      break;
    }
    case "anecReveal":
      v.anecdotes = room.anecdotes.map((a) => ({
        text: a.text,
        author: a.author,
        votes: [...a.votes.entries()].map(([voter, target]) => ({ voter, target })),
      }));
      v.roundPoints = Object.fromEntries(room.roundPoints);
      break;
    case "vote":
      v.myVote = room.votes.get(me.id) || null;
      v.done = [...room.votes.keys()];
      break;
    case "voteReveal":
      if (round.type === "qui") {
        const tally = {};
        for (const [voter, target] of room.votes) (tally[target] ||= []).push(voter);
        v.tally = tally; // qui a voté pour qui : visible
      } else {
        let oui = 0, non = 0;
        for (const [, t] of room.votes) t === "oui" ? oui++ : non++;
        v.counts = { oui, non }; // anonyme : seulement les totaux
      }
      break;
    case "end": {
      // Titres de fin : qui a été le plus désigné dans les "qui est le plus…"
      const titles = {};
      for (const h of room.history || []) {
        if (h.type !== "qui") continue;
        for (const w of h.winners) (titles[w] ||= []).push(h.question);
      }
      v.titles = titles;
      break;
    }
  }
  return v;
}

// ---------- SSE ----------
function sendEvent(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (!p.clients.size) continue;
    const view = viewFor(room, p);
    for (const res of p.clients) sendEvent(res, view);
  }
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

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20000) req.destroy();
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
  let file = pathname === "/" ? "/index.html" : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "forbidden" });
  fs.readFile(full, (err, buf) => {
    if (err) {
      // toutes les URLs inconnues (ex: /ABCD) renvoient le jeu
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, idx) => {
        if (e2) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/create") {
    const b = await readBody(req);
    const code = newRoomCode();
    const host = makePlayer(b.name, b.avatar, b.color);
    const room = {
      code,
      hostId: host.id,
      players: new Map([[host.id, host]]),
      phase: "lobby",
      settings: structuredClone(DEFAULT_SETTINGS),
      usedQuestions: new Set(),
      roundIndex: -1,
      rounds: [],
      lastActive: Date.now(),
    };
    rooms.set(code, room);
    return json(res, 200, { code, pid: host.id });
  }

  if (req.method === "POST" && p === "/api/join") {
    const b = await readBody(req);
    const room = rooms.get(String(b.code || "").toUpperCase().trim());
    if (!room) return json(res, 404, { error: "Cette salle n'existe pas." });
    if (room.phase !== "lobby") return json(res, 409, { error: "La partie a déjà commencé, attends la fin !" });
    if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: "La salle est pleine." });
    const name = cleanText(b.name, 16);
    if ([...room.players.values()].some((pl) => pl.name.toLowerCase() === name.toLowerCase()))
      return json(res, 409, { error: "Ce pseudo est déjà pris dans la salle." });
    const player = makePlayer(name, b.avatar, b.color);
    room.players.set(player.id, player);
    broadcast(room);
    return json(res, 200, { code: room.code, pid: player.id });
  }

  if (req.method === "POST" && p === "/api/action") {
    const b = await readBody(req);
    const room = rooms.get(String(b.code || "").toUpperCase());
    const player = room?.players.get(b.pid);
    if (!room || !player) return json(res, 404, { error: "Session expirée." });
    const err = handleAction(room, player, b);
    return json(res, err ? 400 : 200, err ? { error: err } : { ok: true });
  }

  if (req.method === "GET" && p === "/events") {
    const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
    const player = room?.players.get(url.searchParams.get("pid"));
    if (!room || !player) return json(res, 404, { error: "Session expirée." });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    player.clients.add(res);
    ensureHost(room);
    broadcast(room);
    req.on("close", () => {
      player.clients.delete(res);
      // si l'hôte part, on attend un peu avant de passer le rôle à quelqu'un d'autre
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        ensureHost(room);
        broadcast(room);
        checkAllDone(room);
      }, 8000);
      broadcast(room);
    });
    return;
  }

  if (req.method === "GET" && p === "/api/check") {
    const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
    const ok = !!room?.players.get(url.searchParams.get("pid"));
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
    for (const pl of room.players.values()) for (const res of pl.clients) {
      try { res.write(": ping\n\n"); } catch {}
    }
    if (connected(room).length === 0 && now - room.lastActive > 30 * 60 * 1000) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 15000);

server.listen(PORT, () => console.log(`🎉 KIADISSA -> http://localhost:${PORT}`));
