# Composants tiers

La licence [LICENSE](LICENSE) couvre le code applicatif original d'OSINT Graph
Web et sa documentation. Sa restriction de vente ne remplace pas les licences
des composants tiers et ne restreint pas les droits accordés sur ces composants
par leurs propres licences.

Les principales dépendances sont déclarées dans :

- [frontend/package.json](frontend/package.json) et
  [frontend/package-lock.json](frontend/package-lock.json) : React, React DOM,
  Cytoscape, react-cytoscapejs, Axios et leurs dépendances, ainsi que les outils
  de développement de l'interface.
- [backend/requirements.txt](backend/requirements.txt) : FastAPI, Uvicorn,
  pilote Neo4j, Pydantic et python-dotenv, avec leurs dépendances.

Les textes de licence et mentions de copyright fournis par les paquets
installés restent applicables. Ils figurent notamment dans leurs fichiers
`LICENSE`, `COPYING`, `NOTICE` ou leurs métadonnées de distribution.

Python, Node.js et le serveur Neo4j restent également soumis aux conditions
de leurs distributions respectives. Neo4j est exécuté comme service séparé ;
la licence de ce projet ne remplace pas celle de l'édition Neo4j utilisée.

Lors d'une redistribution qui inclut des composants tiers, conserver leurs
notices et respecter leurs conditions propres. Le build de l'interface copie
la licence applicative et ce document dans `frontend/dist/` ; ce document ne
remplace pas les textes de licence des dépendances.
