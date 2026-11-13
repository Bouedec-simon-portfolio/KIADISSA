# 🎉 Qui a dit ça ?

Party game multijoueur en ligne entre potes (3 à 12 joueurs), inspiré des soirées TeamSpeak de Gotaga.
Chaque joueur rejoint depuis son navigateur (PC ou téléphone) avec un **code de salle**, sans compte ni installation.

## Les 3 types de manches

| Manche | Déroulé | Ce qui est révélé |
|---|---|---|
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

1. Crée un dépôt GitHub (ex. `qui-a-dit-ca`) et envoies-y le contenu de ce dossier :
   ```bash
   git init
   git add .
   git commit -m "Qui a dit ça ?"
   git branch -M main
   git remote add origin https://github.com/<ton-pseudo>/qui-a-dit-ca.git
   git push -u origin main
   ```
2. Va sur https://render.com et connecte-toi avec GitHub.
3. Clique sur **New → Web Service** et choisis ton dépôt.
4. Réglages :
   - **Runtime** : Node
   - **Build Command** : *(laisse vide)* ou `echo ok`
   - **Start Command** : `node server.js`
   - **Instance type** : Free
5. Clique sur **Deploy**. Au bout d'une minute environ, tu as une URL du genre `https://qui-a-dit-ca.onrender.com` à envoyer à tes potes.

> ℹ️ Avec l'offre gratuite, le serveur s'endort après environ 15 min sans visite. La première ouverture prend alors 30 à 60 secondes : ouvre le site un peu avant de jouer.
> Les parties sont gardées en mémoire, donc un redémarrage du serveur efface les salles en cours.

Le jeu marche aussi chez n'importe quel hébergeur Node (Railway, Fly.io, un VPS…). Il lit le port dans la variable `PORT`.

---

## ✏️ Modifier les questions

Tout est dans **`questions.js`** : trois listes (`anecdote`, `qui`, `ouinon`). Ajoute ou supprime des lignes, puis redéploie.
Tu peux aussi ajouter des questions juste pour une partie, depuis le salon (« Ajouter vos propres questions »).

## 🗂 Structure

```
server.js        → serveur + logique du jeu (salles, phases, timers, votes)
questions.js     → banque de questions
public/index.html → toute l'interface (HTML/CSS/JS vanilla)
```

Côté technique, le serveur garde l'état de chaque salle. Les joueurs envoient leurs actions en `POST /api/action` et reçoivent l'état en temps réel par **Server-Sent Events** (`GET /events`).
Chaque joueur reçoit une vue filtrée : les auteurs des anecdotes et les votes oui/non ne sont jamais envoyés avant la révélation, donc impossible de tricher en fouillant le code de la page.
