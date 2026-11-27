# Développement

[Retour à la documentation](../README.md)

Installer d'abord le projet avec [Installation](INSTALLATION.md).
Pour comprendre les choix techniques, lire [Architecture](ARCHITECTURE.md).

## Organisation du dépôt

| Emplacement | Responsabilité |
| --- | --- |
| [backend/main.py](../backend/main.py) | Modèles Pydantic, authentification, permissions, accès SQLite/Neo4j et routes FastAPI. |
| [backend/requirements.txt](../backend/requirements.txt) | Dépendances Python. |
| [frontend/src/main.jsx](../frontend/src/main.jsx) | Montage de l'application React et chargement du CSS global. |
| [frontend/src/App.jsx](../frontend/src/App.jsx) | Connexion, bibliothèque, appels API, formulaires, permissions et visualisation. |
| [frontend/src/index.css](../frontend/src/index.css) | Styles globaux chargés au démarrage. |
| [frontend/src/App.css](../frontend/src/App.css) | Fichier hérité du modèle Vite, non importé par `App.jsx`. |
| [frontend/package.json](../frontend/package.json) | Dépendances et scripts npm. |
| [frontend/package-lock.json](../frontend/package-lock.json) | Versions verrouillées des paquets npm. |
| [frontend/vite.config.js](../frontend/vite.config.js) | Plugin React et inclusion des notices dans le build. |
| [frontend/eslint.config.js](../frontend/eslint.config.js) | Règles d'analyse statique du frontend. |
| [start.bat](../start.bat) | Lancement local Windows. |
| [docs/](.) | Guides thématiques reliés depuis le README principal. |

La version desktop possède son propre dépôt et sa propre chaîne de build.
Les environnements Python, `node_modules`, `dist`, bases et exports locaux
ne font pas partie des sources versionnées.

## Commandes frontend

Depuis la racine du dépôt, sous PowerShell :

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run dev
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
```

`dev` lance Vite avec rechargement à chaud. `lint` exécute ESLint.
`build` produit les fichiers statiques dans `frontend/dist/` et y copie
`LICENSE` et `THIRD_PARTY.md` grâce au plugin `application-license`.

`npm.cmd --prefix frontend run preview` permet d'inspecter le build localement.
Le backend et Neo4j doivent rester disponibles pour utiliser l'application.
Adapter les [origines autorisées](CONFIGURATION.md#adresses-et-origines-du-frontend)
si la prévisualisation est ouverte sur le port `4173`.
Les notices copiées doivent rester accompagnées des licences des dépendances
lorsque celles-ci sont redistribuées ; voir [Composants tiers](../THIRD_PARTY.md).

## Repères dans l'implémentation

Le backend crée son pilote Neo4j au chargement. Le cycle `lifespan` initialise
SQLite et les données de démarrage, puis ferme le pilote à l'arrêt.
Les routes utilisent `get_current_user` pour la session et
`require_graph_access` pour le rôle. Les fonctions d'accès Neo4j sont
exécutées dans des transactions de lecture ou d'écriture.

Dans `App.jsx`, l'état React conserve la session, la bibliothèque, le graphe
courant, les données chargées et les formulaires. Les fonctions
`getAuthConfig` et `getGraphConfig` préparent respectivement l'authentification
et le paramètre `graph_id` des appels Axios. Après une écriture, les données
concernées sont rechargées depuis l'API.

Cytoscape utilise des références React pour son conteneur et son instance.
Les éléments visibles sont recalculés selon les données et les filtres ;
la saisie d'un formulaire ne doit pas provoquer de recentrage.
La disposition utilise `cose`. La navigation, la miniature, les filtres et
la coloration des liens d'entreprise sont gérés dans `App.jsx`.
La mise en forme de l'interface repose principalement sur ses styles inline.

## Validation d'une modification

Le dépôt web ne contient pas encore de suite de tests automatisés.
Pour une modification applicative, utiliser les contrôles adaptés : ESLint,
build du frontend, puis vérification des parcours concernés avec les services
locaux. Pour les droits, vérifier aussi la réponse de l'API avec un compte
`viewer`, `editor` ou `admin` selon le cas.

Les schémas et les exemples d'échange sont dans la [référence API](API.md).
Pour une modification de documentation, vérifier les liens relatifs et la
cohérence des exemples avec le code.

## Limites actuelles

- Le projet reste une preuve de concept ; le lanceur utilise des serveurs
  de développement et des paramètres locaux.
- Les relations n'ont pas de routes dédiées à l'édition ou à la suppression.
- Le type de relation est libre et sa validation métier reste limitée.
- La version web n'a pas d'administration globale des comptes ni de
  parcours de changement/réinitialisation du mot de passe.
- L'adresse de l'API est codée dans le frontend.
- Les dépendances Python ne sont pas verrouillées à des versions précises.
- Aucune suite de tests ni procédure de sauvegarde automatique n'est fournie.

Ces points décrivent l'état du dépôt web ; ils ne constituent pas une liste
de fonctionnalités annoncées pour une prochaine version.
