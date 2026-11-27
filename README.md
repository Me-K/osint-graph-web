# OSINT Graph Web

OSINT Graph Web permet de représenter des personnes et leurs relations sous
forme de graphes interactifs. L'application propose une bibliothèque de
graphes, des fiches personnes, des filtres d'exploration, l'import/export JSON
et des droits de consultation, d'édition ou d'administration par graphe.

Cette version s'utilise dans un navigateur avec un backend et une base Neo4j.
La [version desktop](https://github.com/Me-K/osint-graph-desktop), conçue pour
fonctionner hors ligne, est maintenue dans un dépôt distinct.

## Démarrer

Pour une première installation, suivre le
[guide d'installation](docs/INSTALLATION.md), puis le
[guide d'utilisation](docs/UTILISATION.md).

Une fois les dépendances installées, le lanceur Windows `.\start.bat`
démarre les services locaux. L'interface est accessible sur
[localhost:5173](http://localhost:5173).

## Documentation

| Besoin | Document |
| --- | --- |
| Installer le projet, le démarrer et résoudre les problèmes de lancement | [Installation](docs/INSTALLATION.md) |
| Se connecter, gérer les graphes, explorer les relations et partager les accès | [Utilisation](docs/UTILISATION.md) |
| Comprendre la stack, le rôle de chaque composant et le stockage des données | [Architecture et stack technique](docs/ARCHITECTURE.md) |
| Régler les services, les comptes initiaux, les sessions et la persistance | [Configuration](docs/CONFIGURATION.md) |
| Utiliser les endpoints et les formats d'échange | [Référence API](docs/API.md) |
| Se repérer dans le code, travailler sur le projet et construire le frontend | [Développement](docs/DEVELOPPEMENT.md) |

## Licence

Le code utilise la licence personnalisée
[OSINT Graph — Free Redistribution, No Sale License](LICENSE) :
utilisation, modification et redistribution gratuites autorisées, vente du
logiciel ou de versions modifiées interdite. Les copies redistribuées doivent
conserver la licence et les mentions de copyright ; les modifications doivent
être identifiées.

Le texte complet de [LICENSE](LICENSE) précise les conditions, notamment celles
des prestations payantes distinctes du logiciel. Les
[composants tiers](THIRD_PARTY.md) conservent leurs propres licences.
La restriction de vente ne correspond pas à une licence open source au sens
de l'[Open Source Initiative](https://opensource.org/osd).
