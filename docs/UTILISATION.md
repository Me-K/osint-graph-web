# Guide d'utilisation

[Retour à la documentation](../README.md)

Les services doivent être démarrés selon le [guide d'installation](INSTALLATION.md).
Ouvrir ensuite l'application dans le navigateur.

## Connexion et bibliothèque

Se connecter avec l'identifiant et le mot de passe du compte.
La page **Tes graphes** présente les graphes accessibles et permet de :

- ouvrir un graphe existant dans le studio ;
- créer un nouveau graphe en lui donnant un nom ;
- importer un fichier JSON dans un nouveau graphe ;
- se déconnecter.

Le créateur d'un graphe en devient administrateur. Un même compte peut avoir
des rôles différents selon les graphes.

## Personnes et relations

Dans le studio, utiliser **Nouvelle personne** pour créer une fiche.
Un alias suffit ; si l'alias est omis, il faut renseigner à la fois le nom et
le prénom pour le générer automatiquement. L'alias doit être unique dans le
graphe lors de la création ou de la modification d'une personne.

Les dates, l'entreprise et les notes sont facultatives. L'âge est calculé à
partir de la date de naissance, jusqu'à la date du décès si elle est renseignée,
ou jusqu'à aujourd'hui. Le champ entreprise propose les valeurs existantes
et accepte aussi une nouvelle valeur.

Cliquer sur un nœud pour consulter sa fiche. Les personnes disposant des droits
d'édition peuvent la modifier ou la supprimer. La suppression retire également
les relations de cette personne.

Pour créer un lien, choisir une personne source, une personne cible et un type
de relation, par exemple `CONNAIT`. Les relations saisies sont orientées.
Des liens `MEME_ENTREPRISE` sont également calculés automatiquement entre les
personnes partageant la même entreprise.

## Explorer le graphe

Le filtre relationnel combine une personne de départ, un type de lien et une
profondeur en nombre de « poignées de main ». Les filtres changent l'affichage
sans supprimer les données. **Réinitialiser le filtre** rétablit la vue complète.

- **Rafraîchir** recharge les données du graphe.
- **Recentrer** ajuste le cadrage aux éléments affichés.
- **Zoom par cadre** permet de choisir une zone : bouton gauche pour zoomer,
  bouton droit pour dézoomer.
- Les flèches du clavier déplacent la vue ; `Maj` accélère le déplacement.
- La miniature donne un aperçu de la position dans le graphe.

Les panneaux de filtre, de création et de détail peuvent être repliés.
Revenir à la bibliothèque permet de choisir un autre graphe.

## Importer et exporter

**Exporter JSON** télécharge un fichier contenant les personnes, leurs
propriétés et les relations du graphe complet, même si la vue est filtrée.
Ce fichier ne contient pas les comptes ni les permissions.

Deux parcours d'import existent :

| Point de départ | Résultat |
| --- | --- |
| **Importer un graphe**, depuis la bibliothèque | Crée un nouveau graphe à partir du fichier. |
| **Importer JSON**, depuis un graphe ouvert | Remplace le contenu du graphe courant après confirmation. |

Exporter le graphe courant avant un remplacement permet d'en conserver une
copie. L'import attend le format produit par l'export, avec les listes
`persons` et `relations`. Le [guide API](API.md#format-dimport-et-dexport)
décrit ce format.

## Partager les accès

Les droits sont définis pour chaque graphe :

| Rôle | Actions disponibles dans le graphe |
| --- | --- |
| `viewer` | Consulter, filtrer et exporter. |
| `editor` | Droits de consultation, création/modification/suppression de personnes, création de relations et import. |
| `admin` | Droits d'édition et gestion des accès. |

Dans le panneau **Administration** du graphe, un administrateur peut attribuer
un rôle à un compte, modifier ce rôle ou retirer son accès. Pour un compte
existant, laisser le mot de passe vide. Pour créer un nouveau compte,
renseigner un identifiant, un mot de passe et éventuellement un nom affiché.

L'identifiant comporte de 3 à 64 caractères : lettres non accentuées, chiffres,
`.`, `_`, `@` ou `-`, avec une lettre ou un chiffre en premier.
Il est normalisé en minuscules. Par défaut, le mot de passe comporte au moins
10 caractères et trois catégories parmi minuscules, majuscules, chiffres
et symboles.

La version web gère les accès depuis les graphes. Elle ne possède pas encore
d'écran global de gestion des comptes ni de formulaire de changement de mot
de passe. Les limites techniques sont recensées dans
[Développement](DEVELOPPEMENT.md#limites-actuelles).
