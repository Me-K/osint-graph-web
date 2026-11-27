# Configuration

[Retour à la documentation](../README.md)

## Variables du backend

Le backend lit les variables d'environnement au démarrage. Les définir dans
le terminal qui lance le backend, ou avant `.\start.bat` pour qu'elles soient
transmises aux terminaux ouverts. Redémarrer le backend après un changement.
Un fichier `.env` seul n'est pas chargé par le code actuel.

| Variable | Valeur par défaut | Usage |
| --- | --- | --- |
| `NEO4J_URI` | `bolt://localhost:7687` | Adresse du serveur Neo4j. |
| `NEO4J_USER` | `neo4j` | Utilisateur Neo4j. |
| `NEO4J_PASSWORD` | `neo4j123` | Mot de passe de la connexion Neo4j locale fournie. |
| `APP_SECURITY_DB` | `backend/security.db` | Fichier SQLite ; par défaut à côté de `main.py`. |
| `APP_BOOTSTRAP_ADMIN_ID` | `admin` | Identifiant du compte créé à l'initialisation. |
| `APP_BOOTSTRAP_ADMIN_PASSWORD` | Généré si absent | Mot de passe utilisé uniquement à la création du compte. |
| `APP_BOOTSTRAP_ADMIN_NAME` | `Administrateur` | Nom affiché du compte initial. |
| `APP_DEFAULT_GRAPH_ID` | `default-main` | Identifiant du graphe initial. |
| `APP_DEFAULT_GRAPH_NAME` | `Graphe principal` | Nom utilisé à la création du graphe initial. |
| `APP_SESSION_TTL_HOURS` | `12` | Durée de validité d'une session, en heures. |
| `APP_LOGIN_MAX_FAILURES` | `5` | Nombre d'échecs avant verrouillage temporaire. |
| `APP_LOGIN_LOCK_MINUTES` | `15` | Durée du verrouillage, en minutes. |
| `APP_PASSWORD_MIN_LENGTH` | `10` | Longueur minimale des nouveaux mots de passe. |
| `APP_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origines du frontend autorisées, séparées par des virgules. |

Les chemins relatifs fournis dans `APP_SECURITY_DB` sont résolus depuis le
dossier de lancement du backend. Un chemin absolu évite cette dépendance.

## Compte initial

Avant le premier démarrage, définir l'identifiant et le nom souhaités :

```powershell
$env:APP_BOOTSTRAP_ADMIN_ID = "admin"
$env:APP_BOOTSTRAP_ADMIN_NAME = "Administrateur"
```

Il est aussi possible de fournir un mot de passe avec
`APP_BOOTSTRAP_ADMIN_PASSWORD`. Sans cette variable, le backend en génère un
et l'affiche dans sa console. Un mot de passe fourni doit respecter la
[politique décrite dans le guide utilisateur](UTILISATION.md#partager-les-accès).

Ces variables initialisent un compte absent ; elles ne réinitialisent pas
le mot de passe d'un compte existant. Le compte initial reçoit l'accès
administrateur au graphe par défaut.

## Adresses et origines du frontend

L'adresse de l'API est définie par `API_BASE` dans
[frontend/src/App.jsx](../frontend/src/App.jsx) :
`http://localhost:8000`. Elle ne dépend pas d'une variable Vite.

Pour utiliser une autre adresse, modifier cette constante et reconstruire
le frontend, puis adapter `APP_CORS_ORIGINS` à l'origine depuis laquelle
l'interface sera ouverte. L'origine comprend le protocole, le nom d'hôte
et le port. La prévisualisation Vite utilise habituellement le port `4173`,
qui ne fait pas partie des origines autorisées par défaut.

Le lanceur fixe ses ports et les identifiants du conteneur Neo4j dans
[start.bat](../start.bat). Modifier `NEO4J_PASSWORD` côté backend ne change
pas à lui seul le mot de passe de la base.

## Sessions et permissions

Les mots de passe sont hachés avec `scrypt` et un sel aléatoire. Les jetons
de session sont aléatoires ; seul leur hash est stocké dans SQLite, avec
une expiration et un état de révocation. Les échecs de connexion répétés
déclenchent un verrouillage temporaire.

Le frontend conserve le jeton dans `sessionStorage` et l'envoie dans
l'en-tête `Authorization: Bearer …`. Le backend vérifie les droits de
chaque requête protégée ; masquer un bouton dans l'interface ne remplace
pas ce contrôle. Les rôles sont détaillés dans
[Utilisation](UTILISATION.md#partager-les-accès).

## Persistance

- `security.db` conserve les comptes, les sessions et les permissions.
- Neo4j conserve les personnes et les relations dans son conteneur.
- Le lanceur ne configure pas de volume nommé ni de sauvegarde automatique.
  Un simple arrêt conserve le conteneur ; sa suppression ne doit pas servir
  de procédure de redémarrage ou de sauvegarde.
- Un export JSON conserve un graphe, sans ses comptes ni ses droits.
  Une restauration complète doit prendre en compte SQLite et les données Neo4j.

Les bases, fichiers `.env`, environnements installés et dossiers locaux
d'exports/sauvegardes sont exclus de Git par [.gitignore](../.gitignore).
