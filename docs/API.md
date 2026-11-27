# Référence API

[Retour à la documentation](../README.md)

L'API locale écoute sur `http://localhost:8000`.
[Swagger UI](http://localhost:8000/docs) expose les schémas de validation.
Les modèles et routes sont définis dans [backend/main.py](../backend/main.py).

## Authentification et sélection du graphe

Ouvrir une session avec `POST /auth/login` et un corps JSON
`{"user_id": "votre-identifiant", "password": "votre-mot-de-passe"}`.
La réponse contient `token`, `expires_at` et `user`.

Les autres routes applicatives exigent l'en-tête :

```http
Authorization: Bearer <token>
```

Récupérer un identifiant de graphe avec `GET /graphs`. Les routes de personnes,
de relations, d'entreprises et d'import/export exigent toutes
`?graph_id=<graph_id>`. Les routes de permissions portent cet identifiant
dans leur chemin.

Dans les exemples ci-dessous, remplacer les valeurs entre `<…>` par celles
de la session et du graphe utilisés.

## Routes

Le rôle minimal s'applique au graphe ciblé. `editor` inclut `viewer` ;
`admin` inclut les deux.

| Méthode | Route | Accès minimal | Fonction |
| --- | --- | --- | --- |
| GET | `/` | Public | Redirection vers `/docs`. |
| POST | `/auth/login` | Identifiants valides | Ouvrir une session. |
| POST | `/auth/logout` | Session | Révoquer la session courante. |
| GET | `/auth/me` | Session | Lire l'identité du compte connecté. |
| GET | `/graphs` | Session | Lister les graphes accessibles et le rôle du compte sur chacun. |
| POST | `/graphs` | Session | Créer un graphe ; le créateur devient administrateur. |
| GET | `/graphs/{graph_id}/permissions` | `admin` | Lister les accès. |
| POST | `/graphs/{graph_id}/permissions` | `admin` | Attribuer un accès, avec création du compte s'il est absent. |
| PUT | `/graphs/{graph_id}/permissions/{user_id}` | `admin` | Modifier un rôle existant. |
| DELETE | `/graphs/{graph_id}/permissions/{user_id}` | `admin` | Retirer un accès. |
| GET | `/persons?graph_id=…` | `viewer` | Lister les nœuds représentant les personnes. |
| POST | `/persons?graph_id=…` | `editor` | Créer une personne. |
| GET | `/persons/{person_id}?graph_id=…` | `viewer` | Lire une fiche complète. |
| PUT | `/persons/{person_id}?graph_id=…` | `editor` | Remplacer les champs de la fiche. |
| DELETE | `/persons/{person_id}?graph_id=…` | `editor` | Supprimer une personne et ses relations. |
| GET | `/companies?graph_id=…` | `viewer` | Lister les entreprises distinctes. |
| POST | `/relations?graph_id=…` | `editor` | Créer une relation orientée. |
| GET | `/graph?graph_id=…` | `viewer` | Lire les nœuds et liens de visualisation. |
| GET | `/graph/export?graph_id=…` | `viewer` | Exporter les données complètes du graphe. |
| POST | `/graph/import?graph_id=…` | `editor` | Remplacer ou fusionner les données du graphe. |

`POST /graphs` attend `name` et éventuellement `description`.
L'attribution d'un accès attend `user_id`, `role` et éventuellement
`display_name` et `password`. Le mot de passe est nécessaire pour un nouveau
compte et doit être omis pour un compte existant.
La modification d'un rôle attend un objet `{"role": "viewer"}` ;
les valeurs possibles sont `viewer`, `editor` et `admin`.

## Personnes et relations

Créer une personne :

```http
POST /persons?graph_id=<graph_id>
Authorization: Bearer <token>
Content-Type: application/json

{
  "alias": "alice",
  "nom": "Dupont",
  "prenom": "Alice",
  "date_naissance": "1994-05-10",
  "date_mort": null,
  "entreprise": "Acme",
  "description": "Source : rapport de référence"
}
```

La réponse est un nœud de visualisation. Pour lire la fiche complète, utiliser
`GET /persons/<person_id>?graph_id=<graph_id>`.
La modification utilise `PUT` sur cette même URL avec les mêmes champs que
la création. Les champs facultatifs omis prennent la valeur `null` : envoyer
l'ensemble de la fiche à conserver. La suppression utilise `DELETE`
sur cette URL et renvoie `{"deleted": true}`.

Créer une relation :

```http
POST /relations?graph_id=<graph_id>
Authorization: Bearer <token>
Content-Type: application/json

{
  "from_id": "<person_id_source>",
  "to_id": "<person_id_cible>",
  "label": "CONNAIT"
}
```

Les deux personnes doivent appartenir au graphe ciblé.
L'API ne propose pas de route dédiée à la modification ou à la suppression
d'une relation isolée.

## Format de visualisation

`GET /graph?graph_id=…` renvoie `{"nodes": [...], "edges": [...]}` :

- Nœud : `id`, `label`, `type` et `info_categories`.
- Lien : `id`, `source`, `target`, `label` et `company` éventuellement nul.

Ce format décrit l'affichage du graphe ; il ne contient pas toutes les
propriétés des fiches personnes.

## Format d'import et d'export

`GET /graph/export?graph_id=…` renvoie un document de cette forme :

```json
{
  "graph": {
    "id": "graphe-source",
    "name": "Exemple",
    "description": null
  },
  "persons": [
    {"id": "personne-a", "alias": "alice"},
    {"id": "personne-b", "alias": "bob"}
  ],
  "relations": [
    {
      "source": "personne-a",
      "target": "personne-b",
      "label": "CONNAIT",
      "properties": {"id": "relation-ab"}
    }
  ]
}
```

L'exemple est réduit aux champs utiles pour illustrer la structure ;
l'export réel contient les propriétés enregistrées des personnes et relations.
Il ne contient ni comptes, ni sessions, ni permissions.

Pour importer, envoyer à `POST /graph/import?graph_id=<graph_id>` un objet
`{"replace_existing": true, "data": ...}`, où `data` est le document exporté.
Avec `true`, les personnes et relations du graphe ciblé sont remplacées.
Avec `false`, les personnes sont fusionnées par identifiant et les relations
par source, cible et type, dans ce graphe.

La cible est toujours le `graph_id` de la requête : les métadonnées du
graphe source ne changent pas le nom ou les permissions de la destination.
Les liens `MEME_ENTREPRISE` sont recalculés.
La réponse contient `replaced`, `persons_imported` et `relations_imported`.

## Erreurs courantes

Les erreurs applicatives portent un champ `detail`. Les erreurs de validation
Pydantic peuvent fournir une liste structurée dans ce champ.

| Statut | Signification habituelle |
| --- | --- |
| `400` | Opération incompatible avec l'état courant, par exemple définition du mot de passe d'un compte existant. |
| `401` | Identifiants incorrects ou session absente, expirée ou révoquée. |
| `403` | Rôle insuffisant sur le graphe. |
| `404` | Ressource introuvable dans le périmètre accessible au compte. |
| `409` | Conflit, par exemple alias déjà utilisé. |
| `422` | Corps, paramètres ou valeurs métier invalides. |
| `429` | Compte temporairement verrouillé après des échecs de connexion. |
