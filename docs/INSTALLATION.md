# Installation et démarrage

[Retour à la documentation](../README.md)

Ce guide couvre le lancement local de la version web. Les réglages des
services sont détaillés dans [Configuration](CONFIGURATION.md).

## Prérequis

- Git pour cloner le dépôt.
- Python avec `venv` et `pip`.
- Node.js avec npm, compatible avec les dépendances verrouillées du frontend :
  `^20.19.0 || >=22.12.0` pour Vite et son plugin React.
- Docker Desktop démarré, pour exécuter Neo4j avec le lanceur Windows.

Le premier téléchargement des dépendances et de l'image Docker nécessite
un accès Internet. Le lanceur `start.bat` est prévu pour Windows.

## Préparer le projet

Cloner le dépôt, puis se placer à sa racine :

```powershell
git clone https://github.com/Me-K/osint-graph-web.git
cd osint-graph-web
```

Installer les dépendances une seule fois, puis à nouveau lorsqu'elles changent :

```powershell
python -m venv backend/venv
.\backend\venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd --prefix frontend ci
```

## Démarrer sous Windows

Depuis la racine du dépôt :

```powershell
.\start.bat
```

Le lanceur tente de démarrer Docker Desktop s'il est arrêté, crée ou redémarre
le conteneur `neo4j-osint`, puis ouvre deux terminaux PowerShell pour le backend
et le frontend. Il utilise son propre emplacement pour retrouver le projet.
Il n'installe pas les dépendances.

| Service | Adresse locale |
| --- | --- |
| Application | [http://localhost:5173](http://localhost:5173) |
| Documentation interactive de l'API | [http://localhost:8000/docs](http://localhost:8000/docs) |
| Neo4j Browser | [http://localhost:7474](http://localhost:7474) |
| Connexion du backend à Neo4j | `bolt://localhost:7687` |

Au premier démarrage, le backend crée le compte `admin` et un graphe principal.
Sans mot de passe initial configuré, il génère un mot de passe et l'affiche
dans la console du backend. Utiliser ces identifiants pour se connecter.
Les variables `APP_BOOTSTRAP_ADMIN_*` permettent de
[personnaliser ce compte avant sa création](CONFIGURATION.md#compte-initial).

La suite du parcours est décrite dans le [guide d'utilisation](UTILISATION.md).

## Démarrage manuel

Après l'installation des dépendances, lancer les services dans cet ordre.
Les commandes suivantes partent de la racine du dépôt.

Créer Neo4j une seule fois avec les paramètres locaux du lanceur :

```powershell
docker run -d -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/neo4j123 --name neo4j-osint neo4j:5
```

Si ce conteneur existe déjà, utiliser `docker start neo4j-osint`.
Attendre que Neo4j soit prêt, puis démarrer le backend dans un terminal :

```powershell
cd backend
.\venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

Dans un deuxième terminal, démarrer le frontend :

```powershell
npm.cmd --prefix frontend run dev
```

Sous Linux ou macOS, utiliser un moteur Docker disponible, `python3` pour
créer le venv, `./venv/bin/python` depuis `backend/` et `npm` à la place de
`npm.cmd`. Le lanceur Windows n'est pas utilisé.

## Arrêter ou diagnostiquer le lancement

Arrêter chaque serveur avec `Ctrl+C` dans son terminal. Arrêter ensuite Neo4j
avec `docker stop neo4j-osint` ; cette commande conserve le conteneur.

| Symptôme | Vérification |
| --- | --- |
| Docker indisponible | Ouvrir Docker Desktop, attendre qu'il soit prêt et vérifier `docker info`. |
| Module Python introuvable | Réinstaller les dépendances avec le Python de `backend/venv`. |
| Connexion à Neo4j refusée | Vérifier `docker ps`, puis `docker logs neo4j-osint` et les variables `NEO4J_*`. |
| L'interface ne joint pas l'API | Vérifier le terminal backend et l'adresse de l'API dans [Configuration](CONFIGURATION.md#adresses-et-origines-du-frontend). |
| Vite utilise un autre port | Libérer le port `5173` ou adapter `APP_CORS_ORIGINS` à l'adresse affichée par Vite. |
| Mot de passe initial introuvable | Consulter la console du premier démarrage ; changer la variable d'initialisation ne modifie pas un compte existant. |
