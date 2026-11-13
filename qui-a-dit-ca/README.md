# 🎉 KIADISSA

Party game multijoueur en ligne entre potes (3 à 12 joueurs), inspiré des soirées TeamSpeak de Gotaga.
Chaque joueur rejoint depuis son navigateur (PC ou téléphone) avec un **code de salle**, sans compte ni installation.

## Les 8 types de manches

| Manche | Déroulé | Points |
|---|---|---|
| 📝 **Anecdote** | Un thème, chacun écrit une anecdote anonyme, on devine l'auteur. À la fin on voit qui a écrit quoi et qui a voté pour qui. | +1 par bonne réponse, +1 pour l'auteur par joueur trompé |
| 🤥 **Le menteur** | Chacun écrit 2 vérités et 1 mensonge sur lui, les autres trouvent le mensonge. | idem |
| 👉 **Qui est le plus…** | Vote pour un joueur, votes révélés. | — |
| ✅ **Oui / Non** | Vote anonyme (seul le total s'affiche) + 🔮 pronostic du nombre de « oui ». | Pronostic pile : +2, à 1 près : +1 |
| 🤔 **Tu préfères…** | Deux options, choix révélés. | — |
| 😂 **Complète la phrase** | Chacun écrit une réponse, on vote pour la plus drôle (pas la sienne). | +1 par vote reçu |
| 🍺 **Je n'ai jamais** | « Déjà fait » ou « Jamais », réponses révélées. | — |
| 🧠 **Qui me connaît ?** | Un joueur tiré au sort répond à un « Tu préfères », les autres devinent son choix. | +1 si juste |

## Bonus

- 🎲 **Double ou rien** sur les anecdotes et le menteur : bonne réponse +2, mauvaise −1.
- 🃏 **Joker** (1 par partie) : pendant les résultats, force quelqu'un à raconter l'histoire derrière sa réponse.
- 😂 **Réactions en direct** : emojis qui volent à l'écran (spectateurs compris).
- 🔊 **Sons** générés dans le navigateur (tic-tac des 5 dernières secondes, jingles), bouton pour couper.
- 📦 **Packs de questions** : Classique, Gaming, École / BTS, Soirée, 🔥 Hot 18+ (combinables).
- 🏷 **Titres de fin** : Le détective, Le plus gros menteur, Le plus balancé, Le plus drôle, Le plus expérimenté, Le voyant, Connaît tout le monde par cœur.
- 🎭 **Gage** automatique pour le dernier (désactivable).
- 📜 **Récap** de la partie à télécharger (classement, titres, meilleurs moments).
- 📷 **Photo de profil** au lieu d'un emoji.
- 👀 **Mode spectateur** (pour un stream ou un pote qui regarde).
- 🚪 **Rejoindre en cours de partie** : un retardataire entre directement.

L'hôte (👑) règle le nombre de manches de chaque type, les timers, les packs, et peut ajouter ses propres questions. Il peut aussi passer un timer ou retirer un joueur.
Si l'hôte se déconnecte, son rôle passe automatiquement à un autre joueur.

---|---|---|
| **Anecdote** | Un thème (« Une première fois »…), chacun écrit une anecdote (280 caractères max). Elles défilent une par une et on vote pour l'auteur. | À la fin : l'auteur de chaque anecdote et **qui a voté pour qui**. |
| **Qui est le plus…** | Tout le monde vote pour un joueur. | Nombre de votes de chacun et **qui a voté pour qui**. |
| **Oui / Non** | Question perso, on répond oui ou non. | **Seulement le total**, c'est anonyme. |

**Points** (manches anecdotes) : +1 par bonne réponse, et +1 pour l'auteur à chaque joueur qu'il a trompé.
À la fin, il y a un classement, avec les « titres » gagnés pendant les manches « qui est le plus… ».

L'hôte (👑) peut : régler le nombre de manches et les timers, ajouter ses propres questions, passer un timer, retirer un joueur, relancer une partie.
Si l'hôte se déconnecte, son rôle passe automatiquement à un autre joueur.

---

## ▶️ Tester sur ton PC

Il te faut juste [Node.js](https://nodejs.org) (version 18 ou plus). Le projet n'a **aucune dépendance**, donc pas besoin de `npm install`.

```bash
node server.js
```

Ouvre ensuite http://localhost:3000. Pour tester seul, ouvre plusieurs fenêtres de navigation privée, une par joueur.

---

## 🌍 Mettre en ligne gratuitement (Render)

1. Mets ce projet sur GitHub (ici : le dépôt `KIADISSA`, avec le jeu dans le dossier `qui-a-dit-ca/`).
2. Va sur https://render.com et connecte-toi avec GitHub.
3. Clique sur **New → Web Service** et choisis ton dépôt.
4. Réglages :
   - **Runtime** : Node
   - **Build Command** : *(laisse vide)* ou `echo ok`
   - **Root Directory** : `qui-a-dit-ca` (le dossier qui contient `server.js`)
   - **Start Command** : `node server.js`
   - **Instance type** : Free
5. Clique sur **Deploy**. Au bout d'une minute environ, tu as une URL du genre `https://kiadissa.onrender.com` à envoyer à tes potes.

> ℹ️ Avec l'offre gratuite, le serveur s'endort après environ 15 min sans visite. La première ouverture prend alors 30 à 60 secondes : ouvre le site un peu avant de jouer.
> Les parties sont gardées en mémoire, donc un redémarrage du serveur efface les salles en cours.

Le jeu marche aussi chez n'importe quel hébergeur Node (Railway, Fly.io, un VPS…). Il lit le port dans la variable `PORT`.

---

## ✏️ Modifier les questions

Tout est dans **`questions.js`**, rangé par packs (`normal`, `gaming`, `ecole`, `soiree`, `hot`). Chaque pack a des listes `anecdote`, `qui`, `ouinon`, `tuprefs` (paires `["A", "B"]`), `phrase` et `jamais`. Les gages sont à la fin du fichier. Ajoute ou supprime des lignes, puis redéploie.
Tu peux aussi ajouter des questions juste pour une partie, depuis le salon (« Ajouter vos propres questions »).

## 🗂 Structure

```
server.js        → serveur + logique du jeu (salles, phases, timers, votes)
questions.js     → banque de questions
public/index.html → toute l'interface (HTML/CSS/JS vanilla)
```

Côté technique, le serveur garde l'état de chaque salle. Les joueurs envoient leurs actions en `POST /api/action` et reçoivent l'état en temps réel par **Server-Sent Events** (`GET /events`).
Chaque joueur reçoit une vue filtrée : les auteurs des anecdotes, les mensonges et les votes anonymes ne sont jamais envoyés avant la révélation, donc impossible de tricher en fouillant le code de la page.
