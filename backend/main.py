from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
from typing import Any, Dict, List, Literal, Optional
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from neo4j import GraphDatabase
from pydantic import BaseModel, Field

AUTO_COMPANY_RELATION_TYPE = "MEME_ENTREPRISE"
ROLE_VIEWER = "viewer"
ROLE_EDITOR = "editor"
ROLE_ADMIN = "admin"
ROLE_LEVELS = {
    ROLE_VIEWER: 1,
    ROLE_EDITOR: 2,
    ROLE_ADMIN: 3,
}
VALID_ROLES = set(ROLE_LEVELS)
DEFAULT_GRAPH_ID = os.getenv("APP_DEFAULT_GRAPH_ID", "default-main")
DEFAULT_GRAPH_NAME = os.getenv("APP_DEFAULT_GRAPH_NAME", "Graphe principal")
PASSWORD_MIN_LENGTH = int(os.getenv("APP_PASSWORD_MIN_LENGTH", "10"))
LOGIN_MAX_FAILURES = int(os.getenv("APP_LOGIN_MAX_FAILURES", "5"))
LOGIN_LOCK_MINUTES = int(os.getenv("APP_LOGIN_LOCK_MINUTES", "15"))
SESSION_TTL_HOURS = int(os.getenv("APP_SESSION_TTL_HOURS", "12"))
SECURITY_DB_PATH = Path(
    os.getenv("APP_SECURITY_DB", Path(__file__).with_name("security.db"))
)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "neo4j123")

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


# Return a timezone-aware UTC timestamp for sessions and database records.
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Serialize a timestamp in UTC using ISO 8601.
def datetime_to_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


# Parse an optional ISO timestamp, treating timestamps without a timezone as UTC.
def parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


# Trim an optional value and convert empty text to None.
def clean_optional(value: Optional[Any]) -> Optional[str]:
    if value is None:
        return None
    cleaned = value.strip() if isinstance(value, str) else str(value).strip()
    return cleaned if cleaned else None


# Normalize a login identifier to lowercase and reject invalid characters or lengths.
def normalize_user_id_or_raise(value: Optional[str]) -> str:
    normalized = clean_optional(value)
    if not normalized:
        raise HTTPException(
            status_code=422,
            detail="L'identifiant utilisateur est obligatoire.",
        )
    normalized = normalized.lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._@-]{2,63}", normalized):
        raise HTTPException(
            status_code=422,
            detail=(
                "Identifiant invalide. Utilisez 3 a 64 caracteres "
                "parmi lettres, chiffres, '.', '_', '@' ou '-'."
            ),
        )
    return normalized


# Normalize a graph role and reject values outside viewer, editor, and admin.
def normalize_role_or_raise(value: Optional[str]) -> str:
    role = clean_optional(value)
    if role not in VALID_ROLES:
        raise HTTPException(
            status_code=422,
            detail="Role invalide. Valeurs attendues: viewer, editor, admin.",
        )
    return role


# Check whether a graph role meets the required permission level.
def role_satisfies(user_role: str, required_role: str) -> bool:
    return ROLE_LEVELS[user_role] >= ROLE_LEVELS[required_role]


# Enforce password length limits and the required mix of character categories.
def validate_password_strength(password: Optional[str]):
    if password is None:
        raise HTTPException(status_code=422, detail="Le mot de passe est obligatoire.")
    if len(password) < PASSWORD_MIN_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Le mot de passe doit contenir au moins "
                f"{PASSWORD_MIN_LENGTH} caracteres."
            ),
        )
    categories = 0
    categories += int(any(char.islower() for char in password))
    categories += int(any(char.isupper() for char in password))
    categories += int(any(char.isdigit() for char in password))
    categories += int(any(not char.isalnum() for char in password))
    if categories < 3:
        raise HTTPException(
            status_code=422,
            detail=(
                "Le mot de passe doit melanger au moins trois categories parmi "
                "minuscules, majuscules, chiffres et symboles."
            ),
        )


# Hash a password with scrypt and a random salt, storing the parameters with the digest.
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    )
    return "scrypt$16384$8$1$%s$%s" % (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(key).decode("ascii"),
    )


# Recompute a stored scrypt hash and compare it with the supplied password securely.
def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, n_value, r_value, p_value, salt_b64, key_b64 = stored_hash.split("$")
    except ValueError:
        return False
    if algorithm != "scrypt":
        return False
    salt = base64.b64decode(salt_b64.encode("ascii"))
    expected_key = base64.b64decode(key_b64.encode("ascii"))
    derived_key = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=int(n_value),
        r=int(r_value),
        p=int(p_value),
        dklen=len(expected_key),
    )
    return hmac.compare_digest(derived_key, expected_key)


# Hash a session token with SHA-256 so the database does not store the bearer token.
def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# Generate an unpredictable bearer token for a new session.
def new_session_token() -> str:
    return secrets.token_urlsafe(32)


# Open a SQLite connection for accounts, sessions, graph metadata, and permissions.
def get_security_connection() -> sqlite3.Connection:
    SECURITY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(SECURITY_DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


# Create the SQLite tables and indexes used for accounts, sessions, and graph permissions.
def init_security_db():
    with get_security_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                display_name TEXT,
                password_hash TEXT NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0,
                failed_login_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS graphs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (created_by) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS graph_permissions (
                user_id TEXT NOT NULL,
                graph_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, graph_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                revoked_at TEXT,
                user_agent TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
                ON sessions(token_hash);
            CREATE INDEX IF NOT EXISTS idx_permissions_graph
                ON graph_permissions(graph_id);
            """
        )


# Validate and insert an account with a hashed password and creation timestamps.
def create_user_record(
    connection: sqlite3.Connection,
    user_id: str,
    password: str,
    display_name: Optional[str] = None,
):
    validate_password_strength(password)
    now = datetime_to_iso(utcnow())
    connection.execute(
        """
        INSERT INTO users (
            id,
            display_name,
            password_hash,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            user_id,
            clean_optional(display_name),
            hash_password(password),
            now,
            now,
        ),
    )


# Ensure the configured bootstrap account exists, generating an initial password if needed.
def ensure_bootstrap_admin() -> str:
    bootstrap_admin_id = normalize_user_id_or_raise(
        os.getenv("APP_BOOTSTRAP_ADMIN_ID", "admin")
    )
    bootstrap_admin_name = clean_optional(
        os.getenv("APP_BOOTSTRAP_ADMIN_NAME", "Administrateur")
    )
    bootstrap_admin_password = os.getenv("APP_BOOTSTRAP_ADMIN_PASSWORD")

    with get_security_connection() as connection:
        existing = connection.execute(
            "SELECT id FROM users WHERE id = ?",
            (bootstrap_admin_id,),
        ).fetchone()
        if existing is not None:
            return bootstrap_admin_id

        if bootstrap_admin_password is None:
            bootstrap_admin_password = secrets.token_urlsafe(18)
            print(
                "[security] Compte admin initialise:",
                bootstrap_admin_id,
                f"mot de passe temporaire: {bootstrap_admin_password}",
            )

        create_user_record(
            connection,
            bootstrap_admin_id,
            bootstrap_admin_password,
            bootstrap_admin_name,
        )
        connection.commit()

    return bootstrap_admin_id


# Create or recover the default graph and ensure the bootstrap account can administer it.
def ensure_default_graph(admin_user_id: str):
    now = datetime_to_iso(utcnow())
    with get_security_connection() as connection:
        existing_graph = connection.execute(
            "SELECT id FROM graphs WHERE id = ?",
            (DEFAULT_GRAPH_ID,),
        ).fetchone()
        if existing_graph is None:
            connection.execute(
                """
                INSERT INTO graphs (
                    id,
                    name,
                    description,
                    created_by,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    DEFAULT_GRAPH_ID,
                    DEFAULT_GRAPH_NAME,
                    "Graphe cree automatiquement pour initialiser l'application.",
                    admin_user_id,
                    now,
                    now,
                ),
            )

        existing_permission = connection.execute(
            """
            SELECT user_id
            FROM graph_permissions
            WHERE user_id = ? AND graph_id = ?
            """,
            (admin_user_id, DEFAULT_GRAPH_ID),
        ).fetchone()
        if existing_permission is None:
            connection.execute(
                """
                INSERT INTO graph_permissions (
                    user_id,
                    graph_id,
                    role,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (admin_user_id, DEFAULT_GRAPH_ID, ROLE_ADMIN, now, now),
            )
        connection.commit()


# Assign Neo4j records without a graph identifier to the default graph.
def migrate_legacy_graph_scope(default_graph_id: str):
    with driver.session() as session:
        session.run(
            """
            MATCH (p:Person)
            WHERE p.graph_id IS NULL
            SET p.graph_id = $graph_id
            """,
            graph_id=default_graph_id,
        )
        session.run(
            """
            MATCH ()-[r]->()
            WHERE r.graph_id IS NULL
            SET r.graph_id = $graph_id
            """,
            graph_id=default_graph_id,
        )


# Look up an account by its normalized identifier using the supplied connection.
def get_user_row(connection: sqlite3.Connection, user_id: str) -> Optional[sqlite3.Row]:
    return connection.execute(
        "SELECT * FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()


# Record a failed login and temporarily lock the account when the threshold is reached.
def register_login_failure(connection: sqlite3.Connection, user_row: sqlite3.Row):
    attempts = int(user_row["failed_login_attempts"]) + 1
    lock_until = None
    if attempts >= LOGIN_MAX_FAILURES:
        attempts = 0
        lock_until = datetime_to_iso(
            utcnow() + timedelta(minutes=LOGIN_LOCK_MINUTES)
        )

    connection.execute(
        """
        UPDATE users
        SET failed_login_attempts = ?,
            locked_until = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (attempts, lock_until, datetime_to_iso(utcnow()), user_row["id"]),
    )


# Clear the failed-login counter and any temporary account lock.
def reset_login_failures(connection: sqlite3.Connection, user_id: str):
    connection.execute(
        """
        UPDATE users
        SET failed_login_attempts = 0,
            locked_until = NULL,
            updated_at = ?
        WHERE id = ?
        """,
        (datetime_to_iso(utcnow()), user_id),
    )


# Validate credentials, enforce account status and lockout, and record login outcomes.
def authenticate_user_credentials(
    user_id: str,
    password: str,
) -> sqlite3.Row:
    normalized_user_id = normalize_user_id_or_raise(user_id)
    invalid_credentials = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Identifiants invalides.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    with get_security_connection() as connection:
        user_row = get_user_row(connection, normalized_user_id)
        if user_row is None or user_row["disabled"]:
            raise invalid_credentials

        locked_until = parse_datetime(user_row["locked_until"])
        if locked_until is not None and locked_until > utcnow():
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    "Compte temporairement verrouille apres plusieurs echecs. "
                    "Reessayez plus tard."
                ),
            )

        if not verify_password(password, user_row["password_hash"]):
            register_login_failure(connection, user_row)
            connection.commit()
            raise invalid_credentials

        reset_login_failures(connection, normalized_user_id)
        connection.commit()
        refreshed_user = get_user_row(connection, normalized_user_id)
        if refreshed_user is None:
            raise invalid_credentials
        return refreshed_user


# Store an expiring session using a token hash and return the bearer token to the caller.
def create_session(
    connection: sqlite3.Connection,
    user_id: str,
    user_agent: Optional[str] = None,
) -> Dict[str, Any]:
    token = new_session_token()
    now = utcnow()
    expires_at = now + timedelta(hours=SESSION_TTL_HOURS)
    session_id = str(uuid.uuid4())
    connection.execute(
        """
        INSERT INTO sessions (
            id,
            user_id,
            token_hash,
            created_at,
            expires_at,
            last_seen_at,
            user_agent
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            user_id,
            hash_session_token(token),
            datetime_to_iso(now),
            datetime_to_iso(expires_at),
            datetime_to_iso(now),
            clean_optional(user_agent),
        ),
    )
    return {
        "session_id": session_id,
        "token": token,
        "expires_at": datetime_to_iso(expires_at),
    }


# Mark a session as revoked so its bearer token can no longer authenticate requests.
def revoke_session(connection: sqlite3.Connection, session_id: str):
    connection.execute(
        """
        UPDATE sessions
        SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL
        """,
        (datetime_to_iso(utcnow()), session_id),
    )


# Resolve a valid session, reject disabled accounts or expired tokens, and update last activity.
def get_session_from_token(token: str) -> Optional[Dict[str, Any]]:
    with get_security_connection() as connection:
        row = connection.execute(
            """
            SELECT
                s.id AS session_id,
                s.user_id AS user_id,
                s.expires_at AS expires_at,
                u.display_name AS display_name,
                u.disabled AS disabled
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
              AND s.revoked_at IS NULL
            """,
            (hash_session_token(token),),
        ).fetchone()
        if row is None or row["disabled"]:
            return None

        expires_at = parse_datetime(row["expires_at"])
        if expires_at is None or expires_at <= utcnow():
            revoke_session(connection, row["session_id"])
            connection.commit()
            return None

        connection.execute(
            """
            UPDATE sessions
            SET last_seen_at = ?
            WHERE id = ?
            """,
            (datetime_to_iso(utcnow()), row["session_id"]),
        )
        connection.commit()

        return {
            "session_id": row["session_id"],
            "user_id": row["user_id"],
            "display_name": row["display_name"],
            "expires_at": row["expires_at"],
        }


# List the graphs accessible to an account together with its role on each graph.
def list_graphs_for_user(user_id: str) -> List[Dict[str, Any]]:
    with get_security_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                g.id,
                g.name,
                g.description,
                g.created_by,
                g.created_at,
                gp.role
            FROM graphs g
            JOIN graph_permissions gp ON gp.graph_id = g.id
            WHERE gp.user_id = ?
            ORDER BY lower(g.name), g.created_at
            """,
            (user_id,),
        ).fetchall()
        return [dict(row) for row in rows]


# Retrieve graph metadata and the requesting account's permission, if access exists.
def get_graph_access(user_id: str, graph_id: str) -> Optional[Dict[str, Any]]:
    with get_security_connection() as connection:
        row = connection.execute(
            """
            SELECT
                g.id,
                g.name,
                g.description,
                g.created_by,
                g.created_at,
                gp.role
            FROM graphs g
            JOIN graph_permissions gp ON gp.graph_id = g.id
            WHERE g.id = ? AND gp.user_id = ?
            """,
            (graph_id, user_id),
        ).fetchone()
        return dict(row) if row is not None else None


# Reject access to a missing graph or a graph where the account lacks the required role.
def require_graph_access(user_id: str, graph_id: str, minimum_role: str) -> Dict[str, Any]:
    graph = get_graph_access(user_id, graph_id)
    if graph is None:
        raise HTTPException(
            status_code=404,
            detail="Graphe introuvable ou acces refuse.",
        )
    if not role_satisfies(graph["role"], minimum_role):
        raise HTTPException(
            status_code=403,
            detail="Droits insuffisants pour cette operation.",
        )
    return graph


# Create graph metadata and grant its creator the graph administrator role.
def create_graph_record(
    connection: sqlite3.Connection,
    name: str,
    description: Optional[str],
    creator_user_id: str,
) -> Dict[str, Any]:
    graph_id = str(uuid.uuid4())
    now = datetime_to_iso(utcnow())
    connection.execute(
        """
        INSERT INTO graphs (
            id,
            name,
            description,
            created_by,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (graph_id, name, description, creator_user_id, now, now),
    )
    connection.execute(
        """
        INSERT INTO graph_permissions (
            user_id,
            graph_id,
            role,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        """,
        (creator_user_id, graph_id, ROLE_ADMIN, now, now),
    )
    return {
        "id": graph_id,
        "name": name,
        "description": description,
        "created_by": creator_user_id,
        "created_at": now,
        "role": ROLE_ADMIN,
    }


# List the accounts assigned to a graph, including their roles and account status.
def list_graph_permissions(graph_id: str) -> List[Dict[str, Any]]:
    with get_security_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                gp.user_id,
                u.display_name,
                u.disabled,
                gp.role,
                gp.created_at,
                gp.updated_at
            FROM graph_permissions gp
            JOIN users u ON u.id = gp.user_id
            WHERE gp.graph_id = ?
            ORDER BY
                CASE gp.role
                    WHEN 'admin' THEN 1
                    WHEN 'editor' THEN 2
                    ELSE 3
                END,
                lower(gp.user_id)
            """,
            (graph_id,),
        ).fetchall()
        return [dict(row) for row in rows]


# Count administrator permission assignments on a graph.
def count_graph_admins(connection: sqlite3.Connection, graph_id: str) -> int:
    row = connection.execute(
        """
        SELECT count(*) AS admin_count
        FROM graph_permissions
        WHERE graph_id = ? AND role = ?
        """,
        (graph_id, ROLE_ADMIN),
    ).fetchone()
    return int(row["admin_count"]) if row is not None else 0


# Assign a graph role, creating a missing account or updating its display name when supplied.
def grant_graph_permission(
    graph_id: str,
    user_id: str,
    role: str,
    password: Optional[str],
    display_name: Optional[str],
) -> Dict[str, Any]:
    normalized_user_id = normalize_user_id_or_raise(user_id)
    normalized_role = normalize_role_or_raise(role)

    with get_security_connection() as connection:
        graph_row = connection.execute(
            "SELECT id FROM graphs WHERE id = ?",
            (graph_id,),
        ).fetchone()
        if graph_row is None:
            raise HTTPException(status_code=404, detail="Graphe introuvable.")

        existing_user = get_user_row(connection, normalized_user_id)
        if existing_user is None:
            create_user_record(connection, normalized_user_id, password or "", display_name)
        elif clean_optional(password) is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Le mot de passe ne peut etre defini que lors de la creation "
                    "d'un nouvel utilisateur."
                ),
            )

        if existing_user is not None and clean_optional(display_name) is not None:
            connection.execute(
                """
                UPDATE users
                SET display_name = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (clean_optional(display_name), datetime_to_iso(utcnow()), normalized_user_id),
            )

        now = datetime_to_iso(utcnow())
        connection.execute(
            """
            INSERT INTO graph_permissions (
                user_id,
                graph_id,
                role,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, graph_id)
            DO UPDATE SET
                role = excluded.role,
                updated_at = excluded.updated_at
            """,
            (normalized_user_id, graph_id, normalized_role, now, now),
        )
        connection.commit()

    permissions = list_graph_permissions(graph_id)
    for permission in permissions:
        if permission["user_id"] == normalized_user_id:
            return permission
    raise HTTPException(status_code=500, detail="Impossible d'attribuer le droit.")


# Change an existing graph permission while protecting the last graph administrator.
def update_graph_permission_role(
    graph_id: str,
    target_user_id: str,
    role: str,
):
    normalized_user_id = normalize_user_id_or_raise(target_user_id)
    normalized_role = normalize_role_or_raise(role)

    with get_security_connection() as connection:
        existing = connection.execute(
            """
            SELECT role
            FROM graph_permissions
            WHERE graph_id = ? AND user_id = ?
            """,
            (graph_id, normalized_user_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Droit introuvable.")

        if existing["role"] == ROLE_ADMIN and normalized_role != ROLE_ADMIN:
            if count_graph_admins(connection, graph_id) <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Le graphe doit conserver au moins un administrateur.",
                )

        connection.execute(
            """
            UPDATE graph_permissions
            SET role = ?,
                updated_at = ?
            WHERE graph_id = ? AND user_id = ?
            """,
            (
                normalized_role,
                datetime_to_iso(utcnow()),
                graph_id,
                normalized_user_id,
            ),
        )
        connection.commit()

    permissions = list_graph_permissions(graph_id)
    for permission in permissions:
        if permission["user_id"] == normalized_user_id:
            return permission
    raise HTTPException(status_code=500, detail="Impossible de modifier le droit.")


# Remove an account's graph access while protecting the last graph administrator.
def delete_graph_permission(graph_id: str, target_user_id: str):
    normalized_user_id = normalize_user_id_or_raise(target_user_id)

    with get_security_connection() as connection:
        existing = connection.execute(
            """
            SELECT role
            FROM graph_permissions
            WHERE graph_id = ? AND user_id = ?
            """,
            (graph_id, normalized_user_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Droit introuvable.")

        if existing["role"] == ROLE_ADMIN and count_graph_admins(connection, graph_id) <= 1:
            raise HTTPException(
                status_code=400,
                detail="Le graphe doit conserver au moins un administrateur.",
            )

        connection.execute(
            """
            DELETE FROM graph_permissions
            WHERE graph_id = ? AND user_id = ?
            """,
            (graph_id, normalized_user_id),
        )
        connection.commit()


# Trim a relationship label and reject an empty relationship type.
def normalize_relation_label_or_raise(label: Optional[str]) -> str:
    normalized = clean_optional(label)
    if not normalized:
        raise HTTPException(status_code=422, detail="Le type de lien est obligatoire.")
    return normalized


# Escape backticks before embedding a relationship type in a Cypher query.
def escape_cypher_identifier(value: str) -> str:
    return value.replace("`", "``")


# Format an optional first name with an uppercase initial and lowercase remaining letters.
def format_prenom_display(value: Optional[str]) -> Optional[str]:
    prenom = clean_optional(value)
    if not prenom:
        return None
    return prenom[:1].upper() + prenom[1:].lower()


# Use an explicit alias or derive one from a complete name, rejecting insufficient identity data.
def resolve_alias_or_raise(
    alias: Optional[str], nom: Optional[str], prenom: Optional[str]
) -> str:
    alias_clean = clean_optional(alias)
    if alias_clean:
        return alias_clean

    nom_clean = clean_optional(nom)
    prenom_clean = clean_optional(prenom)
    if nom_clean and prenom_clean:
        return f"{nom_clean} {prenom_clean}"

    if nom_clean or prenom_clean:
        raise HTTPException(
            status_code=422,
            detail=(
                "Si seul le nom ou le prenom est renseigne, "
                "un alias explicite est obligatoire."
            ),
        )

    raise HTTPException(
        status_code=422,
        detail="Renseignez un alias ou bien le nom et le prenom.",
    )


# Read an optional date value and return None when it cannot be parsed.
def parse_optional_date(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


# Convert a supported date value to ISO date text, or return None when unavailable.
def to_iso_date(value) -> Optional[str]:
    parsed = parse_optional_date(value)
    return parsed.isoformat() if parsed else None


# Choose a readable node label from the alias, name fields, or legacy name.
def person_label(person) -> str:
    alias = clean_optional(person.get("alias"))
    if alias:
        return alias

    nom = clean_optional(person.get("nom"))
    prenom = format_prenom_display(person.get("prenom"))
    if nom and prenom:
        return f"{nom.upper()} {prenom}"
    if nom:
        return nom.upper()
    if prenom:
        return prenom

    legacy_name = person.get("name")
    if legacy_name:
        return legacy_name

    return "Person"


# Identify which information categories are available for a person's display badges.
def person_info_categories(person) -> List[str]:
    categories: List[str] = []
    if person.get("nom") or person.get("prenom"):
        categories.append("identite")
    if person.get("entreprise"):
        categories.append("entreprise")
    if person.get("date_naissance") or person.get("date_mort"):
        categories.append("dates")
    if person.get("description"):
        categories.append("notes")
    return categories


# Calculate age in completed years at death or today when a birth date is available.
def compute_age(date_naissance: Optional[date], date_mort: Optional[date]) -> Optional[int]:
    if date_naissance is None:
        return None
    reference_date = date_mort or date.today()
    years = reference_date.year - date_naissance.year
    has_had_birthday = (reference_date.month, reference_date.day) >= (
        date_naissance.month,
        date_naissance.day,
    )
    return years if has_had_birthday else years - 1


# Check that the birth date precedes the death date, or is not in the future for a living person.
def validate_person_dates(date_naissance: Optional[date], date_mort: Optional[date]):
    if (
        date_naissance is not None
        and date_mort is not None
        and date_mort < date_naissance
    ):
        raise HTTPException(
            status_code=422,
            detail="La date de mort doit etre superieure ou egale a la date de naissance.",
        )
    if date_naissance is not None:
        reference_date = date_mort or date.today()
        if date_naissance > reference_date:
            raise HTTPException(
                status_code=422,
                detail="La date de naissance ne peut pas etre dans le futur.",
            )


# Parse an optional imported date and report invalid values with the field name.
def parse_optional_date_strict(value: Any, field_name: str) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date):
        return value

    value_str = str(value).strip()
    if not value_str:
        return None

    try:
        return date.fromisoformat(value_str)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{field_name} invalide (format attendu: YYYY-MM-DD).",
        ) from exc


# Convert a stored person into the detail response, normalizing dates and calculating age.
def person_to_details(person) -> "PersonDetails":
    date_naissance = parse_optional_date(person.get("date_naissance"))
    date_mort = parse_optional_date(person.get("date_mort"))
    computed_age = compute_age(date_naissance, date_mort)
    return PersonDetails(
        id=person["id"],
        alias=person.get("alias"),
        nom=person.get("nom"),
        prenom=person.get("prenom"),
        date_naissance=date_naissance.isoformat() if date_naissance else None,
        date_mort=date_mort.isoformat() if date_mort else None,
        age=computed_age if computed_age is not None else person.get("age"),
        entreprise=person.get("entreprise"),
        description=person.get("description"),
    )


class AuthUser(BaseModel):
    id: str
    display_name: Optional[str] = None


class AuthTokenResponse(BaseModel):
    token: str
    expires_at: str
    user: AuthUser


class AuthLoginRequest(BaseModel):
    user_id: str
    password: str


class PersonCreate(BaseModel):
    alias: Optional[str] = Field(default=None, min_length=1)
    nom: Optional[str] = None
    prenom: Optional[str] = None
    date_naissance: Optional[date] = None
    date_mort: Optional[date] = None
    entreprise: Optional[str] = None
    description: Optional[str] = None


class PersonUpdate(BaseModel):
    alias: Optional[str] = Field(default=None, min_length=1)
    nom: Optional[str] = None
    prenom: Optional[str] = None
    date_naissance: Optional[date] = None
    date_mort: Optional[date] = None
    entreprise: Optional[str] = None
    description: Optional[str] = None


class PersonDetails(BaseModel):
    id: str
    alias: Optional[str] = None
    nom: Optional[str] = None
    prenom: Optional[str] = None
    date_naissance: Optional[str] = None
    date_mort: Optional[str] = None
    age: Optional[int] = None
    entreprise: Optional[str] = None
    description: Optional[str] = None


class RelationCreate(BaseModel):
    from_id: str
    to_id: str
    label: str


class Node(BaseModel):
    id: str
    label: str
    type: str
    info_categories: List[str] = Field(default_factory=list)


class Edge(BaseModel):
    id: str
    source: str
    target: str
    label: str
    company: Optional[str] = None


class GraphResponse(BaseModel):
    nodes: List[Node]
    edges: List[Edge]


class DeleteResponse(BaseModel):
    deleted: bool


class GraphSummary(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    role: str
    created_by: str
    created_at: str


class GraphCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=600)


class GraphPermission(BaseModel):
    user_id: str
    display_name: Optional[str] = None
    disabled: bool
    role: str
    created_at: str
    updated_at: str


class GraphPermissionAssignRequest(BaseModel):
    user_id: str
    password: Optional[str] = None
    display_name: Optional[str] = None
    role: Literal["viewer", "editor", "admin"]


class GraphPermissionUpdateRequest(BaseModel):
    role: Literal["viewer", "editor", "admin"]


class GraphExportData(BaseModel):
    graph: Optional[Dict[str, Any]] = None
    persons: List[Dict[str, Any]] = Field(default_factory=list)
    relations: List[Dict[str, Any]] = Field(default_factory=list)


class GraphImportRequest(BaseModel):
    replace_existing: bool = True
    data: GraphExportData


class GraphImportResponse(BaseModel):
    replaced: bool
    persons_imported: int
    relations_imported: int


# Initialize security storage, bootstrap accounts, and Neo4j graph metadata, then close the driver on shutdown.
@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_security_db()
    bootstrap_admin_id = ensure_bootstrap_admin()
    ensure_default_graph(bootstrap_admin_id)
    migrate_legacy_graph_scope(DEFAULT_GRAPH_ID)
    yield
    driver.close()


app = FastAPI(title="OSINT Graph API", lifespan=lifespan)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "APP_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Extract a bearer token from the authorization header or reject an invalid header.
def extract_bearer_token(authorization: Optional[str]) -> str:
    if authorization is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentification requise.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Jeton d'authentification invalide.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return value.strip()


# Authenticate the bearer token and expose the current account and session to API handlers.
def get_current_user(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    token = extract_bearer_token(authorization)
    session_data = get_session_from_token(token)
    if session_data is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session invalide ou expiree.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return {
        "id": session_data["user_id"],
        "display_name": session_data["display_name"],
        "session_id": session_data["session_id"],
        "expires_at": session_data["expires_at"],
    }


# Check whether another person in the graph already uses the requested alias.
def alias_exists_in_graph(
    tx,
    graph_id: str,
    alias: str,
    exclude_person_id: Optional[str] = None,
) -> bool:
    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id, alias: $alias})
        WHERE $exclude_person_id IS NULL OR p.id <> $exclude_person_id
        RETURN p.id AS id
        LIMIT 1
        """,
        graph_id=graph_id,
        alias=alias,
        exclude_person_id=exclude_person_id,
    )
    return result.single() is not None


# Insert a person into the requested graph and return the stored record.
def create_person(
    tx,
    graph_id: str,
    alias: str,
    nom: Optional[str],
    prenom: Optional[str],
    date_naissance: Optional[str],
    date_mort: Optional[str],
    age: Optional[int],
    entreprise: Optional[str],
    description: Optional[str],
):
    if alias_exists_in_graph(tx, graph_id, alias):
        raise HTTPException(
            status_code=409,
            detail="Une personne avec cet alias existe deja dans ce graphe.",
        )

    result = tx.run(
        """
        CREATE (p:Person {
            id: randomUUID(),
            graph_id: $graph_id,
            alias: $alias,
            nom: $nom,
            prenom: $prenom,
            date_naissance: $date_naissance,
            date_mort: $date_mort,
            age: $age,
            entreprise: $entreprise,
            description: $description
        })
        RETURN p
        """,
        graph_id=graph_id,
        alias=alias,
        nom=nom,
        prenom=prenom,
        date_naissance=date_naissance,
        date_mort=date_mort,
        age=age,
        entreprise=entreprise,
        description=description,
    )
    record = result.single()
    return record["p"] if record else None


# Retrieve a person by identifier within the requested graph.
def get_person_by_id(tx, graph_id: str, person_id: str):
    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id, id: $person_id})
        RETURN p
        """,
        graph_id=graph_id,
        person_id=person_id,
    )
    record = result.single()
    return record["p"] if record else None


# Replace a person's editable fields within the requested graph and return the updated record.
def update_person_by_id(
    tx,
    graph_id: str,
    person_id: str,
    alias: str,
    nom: Optional[str],
    prenom: Optional[str],
    date_naissance: Optional[str],
    date_mort: Optional[str],
    age: Optional[int],
    entreprise: Optional[str],
    description: Optional[str],
):
    if alias_exists_in_graph(tx, graph_id, alias, exclude_person_id=person_id):
        raise HTTPException(
            status_code=409,
            detail="Une autre personne avec cet alias existe deja dans ce graphe.",
        )

    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id, id: $person_id})
        SET p.alias = $alias,
            p.nom = $nom,
            p.prenom = $prenom,
            p.date_naissance = $date_naissance,
            p.date_mort = $date_mort,
            p.age = $age,
            p.entreprise = $entreprise,
            p.description = $description
        RETURN p
        """,
        graph_id=graph_id,
        person_id=person_id,
        alias=alias,
        nom=nom,
        prenom=prenom,
        date_naissance=date_naissance,
        date_mort=date_mort,
        age=age,
        entreprise=entreprise,
        description=description,
    )
    record = result.single()
    return record["p"] if record else None


# Refresh automatic same-company relationships for one person after their company changes.
def sync_same_company_links(tx, graph_id: str, person_id: str):
    tx.run(
        f"""
        MATCH (p:Person {{id: $person_id, graph_id: $graph_id}})
        OPTIONAL MATCH (p)-[r:`{AUTO_COMPANY_RELATION_TYPE}` {{graph_id: $graph_id}}]-(:Person {{graph_id: $graph_id}})
        DELETE r
        WITH p
        WHERE p.entreprise IS NOT NULL AND trim(p.entreprise) <> ""
        MATCH (o:Person {{graph_id: $graph_id}})
        WHERE o.id <> p.id AND o.entreprise = p.entreprise
        WITH CASE WHEN p.id < o.id THEN p ELSE o END AS a,
             CASE WHEN p.id < o.id THEN o ELSE p END AS b
        MERGE (a)-[r:`{AUTO_COMPANY_RELATION_TYPE}` {{graph_id: $graph_id}}]->(b)
        ON CREATE SET r.id = randomUUID(), r.auto = true, r.company = a.entreprise
        SET r.auto = true, r.company = a.entreprise
        """,
        graph_id=graph_id,
        person_id=person_id,
    )


# Recreate all automatic same-company relationships in a graph from current person records.
def rebuild_same_company_links(tx, graph_id: str):
    tx.run(
        f"""
        MATCH ()-[r:`{AUTO_COMPANY_RELATION_TYPE}` {{graph_id: $graph_id}}]->()
        DELETE r
        """,
        graph_id=graph_id,
    )
    tx.run(
        f"""
        MATCH (a:Person {{graph_id: $graph_id}})
        WHERE a.entreprise IS NOT NULL AND trim(a.entreprise) <> ""
        MATCH (b:Person {{graph_id: $graph_id}})
        WHERE b.id <> a.id AND b.entreprise = a.entreprise AND a.id < b.id
        MERGE (a)-[r:`{AUTO_COMPANY_RELATION_TYPE}` {{graph_id: $graph_id}}]->(b)
        ON CREATE SET r.id = randomUUID()
        SET r.auto = true, r.company = a.entreprise
        """,
        graph_id=graph_id,
    )


# Delete a person and their relationships within the graph, reporting whether a record was removed.
def delete_person_by_id(tx, graph_id: str, person_id: str) -> bool:
    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id, id: $person_id})
        DETACH DELETE p
        RETURN count(p) AS deleted_count
        """,
        graph_id=graph_id,
        person_id=person_id,
    )
    record = result.single()
    return bool(record and record["deleted_count"] > 0)


# Return the distinct nonempty company names present in a graph.
def list_companies(tx, graph_id: str):
    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id})
        WHERE p.entreprise IS NOT NULL AND trim(p.entreprise) <> ""
        RETURN DISTINCT trim(p.entreprise) AS entreprise
        ORDER BY entreprise
        """,
        graph_id=graph_id,
    )
    return [record["entreprise"] for record in result]


# Create or reuse a directed relationship of the requested type between two graph members.
def create_relation(tx, graph_id: str, from_id: str, to_id: str, label: str):
    escaped_label = escape_cypher_identifier(label)
    result = tx.run(
        f"""
        MATCH (a:Person {{id: $from_id, graph_id: $graph_id}})
        MATCH (b:Person {{id: $to_id, graph_id: $graph_id}})
        WHERE a.id <> b.id
        MERGE (a)-[r:`{escaped_label}` {{graph_id: $graph_id}}]->(b)
        ON CREATE SET r.id = randomUUID()
        RETURN r.id AS id, type(r) AS type, a.id AS source, b.id AS target
        """,
        graph_id=graph_id,
        from_id=from_id,
        to_id=to_id,
    )
    return result.single()


# Build the node and edge collections needed to display a graph.
def get_full_graph(tx, graph_id: str):
    result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id})
        OPTIONAL MATCH (p)-[r]->(q:Person {graph_id: $graph_id})
        WHERE r IS NULL OR r.graph_id = $graph_id
        RETURN p, r, q, type(r) AS rel_type
        """,
        graph_id=graph_id,
    )
    nodes = {}
    edges = {}

    for record in result:
        p = record["p"]
        r = record["r"]
        q = record["q"]
        rel_type = record["rel_type"]

        nodes[p["id"]] = {
            "id": p["id"],
            "label": person_label(p),
            "type": "Person",
            "info_categories": person_info_categories(p),
        }

        if q is not None:
            nodes[q["id"]] = {
                "id": q["id"],
                "label": person_label(q),
                "type": "Person",
                "info_categories": person_info_categories(q),
            }

        if r is not None:
            rid = r.get("id")
            if rid is None:
                rid = f"{p['id']}_{q['id']}_{rel_type}"
            company = None
            if rel_type == AUTO_COMPANY_RELATION_TYPE:
                company = clean_optional(r.get("company")) or clean_optional(
                    p.get("entreprise")
                ) or clean_optional(q.get("entreprise"))
            edges[rid] = {
                "id": rid,
                "source": p["id"],
                "target": q["id"],
                "label": rel_type,
                "company": company,
            }

    return list(nodes.values()), list(edges.values())


# Validate an imported person and normalize identity, dates, age, and optional properties.
def normalize_import_person(raw_person: Dict[str, Any], index: int) -> Dict[str, Any]:
    person_id = clean_optional(str(raw_person.get("id") or ""))
    if not person_id:
        raise HTTPException(
            status_code=422,
            detail=f"Personne #{index + 1}: champ 'id' obligatoire.",
        )

    alias = clean_optional(raw_person.get("alias"))
    nom = clean_optional(raw_person.get("nom"))
    prenom = clean_optional(raw_person.get("prenom"))

    normalized: Dict[str, Any] = {"id": person_id}
    if alias or nom or prenom:
        normalized["alias"] = resolve_alias_or_raise(alias, nom, prenom)
    if nom:
        normalized["nom"] = nom
    if prenom:
        normalized["prenom"] = prenom

    date_naissance = parse_optional_date_strict(
        raw_person.get("date_naissance"), "date_naissance"
    )
    date_mort = parse_optional_date_strict(raw_person.get("date_mort"), "date_mort")
    validate_person_dates(date_naissance, date_mort)

    date_naissance_iso = to_iso_date(date_naissance)
    date_mort_iso = to_iso_date(date_mort)
    if date_naissance_iso is not None:
        normalized["date_naissance"] = date_naissance_iso
    if date_mort_iso is not None:
        normalized["date_mort"] = date_mort_iso

    computed_age = compute_age(date_naissance, date_mort)
    raw_age = raw_person.get("age")
    if computed_age is not None:
        normalized["age"] = computed_age
    elif isinstance(raw_age, int):
        normalized["age"] = raw_age

    entreprise = clean_optional(raw_person.get("entreprise"))
    if entreprise:
        normalized["entreprise"] = entreprise

    description = clean_optional(raw_person.get("description"))
    if description:
        normalized["description"] = description

    return normalized


# Normalize current or legacy relationship fields and preserve supported custom properties.
def normalize_import_relation(raw_relation: Dict[str, Any], index: int) -> Dict[str, Any]:
    source = clean_optional(
        str(raw_relation.get("source") or raw_relation.get("from_id") or "")
    )
    target = clean_optional(
        str(raw_relation.get("target") or raw_relation.get("to_id") or "")
    )
    if not source or not target:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Relation #{index + 1}: champs 'source'/'target' "
                "ou 'from_id'/'to_id' obligatoires."
            ),
        )

    label = normalize_relation_label_or_raise(raw_relation.get("label"))
    if label == AUTO_COMPANY_RELATION_TYPE:
        return {
            "source": source,
            "target": target,
            "label": label,
            "properties": {},
        }

    properties: Dict[str, Any] = {}
    raw_properties = raw_relation.get("properties")
    if isinstance(raw_properties, dict):
        for key, value in raw_properties.items():
            if isinstance(key, str):
                properties[key] = value

    relation_id = clean_optional(str(raw_relation.get("id") or ""))
    if relation_id and "id" not in properties:
        properties["id"] = relation_id

    if "auto" in raw_relation and "auto" not in properties:
        properties["auto"] = bool(raw_relation.get("auto"))

    return {
        "source": source,
        "target": target,
        "label": label,
        "properties": properties,
    }


# Assemble a versioned JSON-compatible snapshot containing graph metadata, persons, and relationships.
def export_graph_snapshot(tx, graph_id: str, graph_meta: Dict[str, Any]) -> GraphExportData:
    persons_result = tx.run(
        """
        MATCH (p:Person {graph_id: $graph_id})
        RETURN properties(p) AS person
        ORDER BY coalesce(p.alias, p.nom, p.id)
        """,
        graph_id=graph_id,
    )
    persons = [record["person"] for record in persons_result]

    relations_result = tx.run(
        """
        MATCH (a:Person {graph_id: $graph_id})-[r]->(b:Person {graph_id: $graph_id})
        WHERE r.graph_id = $graph_id
        RETURN a.id AS source, b.id AS target, type(r) AS label, properties(r) AS properties
        ORDER BY label, source, target
        """,
        graph_id=graph_id,
    )
    relations = [
        {
            "source": record["source"],
            "target": record["target"],
            "label": record["label"],
            "properties": record["properties"] or {},
        }
        for record in relations_result
    ]

    return GraphExportData(
        graph={
            "id": graph_meta["id"],
            "name": graph_meta["name"],
            "description": graph_meta.get("description"),
        },
        persons=persons,
        relations=relations,
    )


# Merge or replace a graph's records in the current transaction and rebuild automatic company links.
def import_graph_snapshot(
    tx,
    graph_id: str,
    persons: List[Dict[str, Any]],
    relations: List[Dict[str, Any]],
    replace_existing: bool,
) -> Dict[str, int]:
    if replace_existing:
        tx.run(
            """
            MATCH (p:Person {graph_id: $graph_id})
            DETACH DELETE p
            """,
            graph_id=graph_id,
        )

    if persons:
        rows = []
        for person in persons:
            row = dict(person)
            row["graph_id"] = graph_id
            rows.append(row)

        tx.run(
            """
            UNWIND $rows AS row
            MERGE (p:Person {graph_id: $graph_id, id: row.id})
            SET p += row
            SET p.graph_id = $graph_id
            """,
            rows=rows,
            graph_id=graph_id,
        )

    grouped_relations: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for relation in relations:
        if relation["label"] == AUTO_COMPANY_RELATION_TYPE:
            continue
        grouped_relations[relation["label"]].append(
            {
                "source": relation["source"],
                "target": relation["target"],
                "properties": {
                    **(relation.get("properties") or {}),
                    "graph_id": graph_id,
                },
            }
        )

    for label, rows in grouped_relations.items():
        escaped_label = escape_cypher_identifier(label)
        tx.run(
            f"""
            UNWIND $rows AS row
            MATCH (a:Person {{id: row.source, graph_id: $graph_id}})
            MATCH (b:Person {{id: row.target, graph_id: $graph_id}})
            WHERE a.id <> b.id
            MERGE (a)-[r:`{escaped_label}` {{graph_id: $graph_id}}]->(b)
            SET r += row.properties
            SET r.id = coalesce(r.id, randomUUID())
            """,
            rows=rows,
            graph_id=graph_id,
        )

    rebuild_same_company_links(tx, graph_id)

    return {
        "persons_imported": len(persons),
        "relations_imported": len(relations),
    }


# Authenticate login credentials and return a new bearer session with account details.
@app.post("/auth/login", response_model=AuthTokenResponse)
def login_endpoint(
    payload: AuthLoginRequest,
    user_agent: Optional[str] = Header(default=None),
):
    user = authenticate_user_credentials(payload.user_id, payload.password)
    with get_security_connection() as connection:
        session_info = create_session(connection, user["id"], user_agent)
        connection.commit()

    return AuthTokenResponse(
        token=session_info["token"],
        expires_at=session_info["expires_at"],
        user=AuthUser(id=user["id"], display_name=user["display_name"]),
    )


# Revoke the authenticated session to sign out the current client.
@app.post("/auth/logout", response_model=DeleteResponse)
def logout_endpoint(current_user: Dict[str, Any] = Depends(get_current_user)):
    with get_security_connection() as connection:
        revoke_session(connection, current_user["session_id"])
        connection.commit()
    return DeleteResponse(deleted=True)


# Return the public identity details of the authenticated account.
@app.get("/auth/me", response_model=AuthUser)
def me_endpoint(current_user: Dict[str, Any] = Depends(get_current_user)):
    return AuthUser(
        id=current_user["id"],
        display_name=current_user["display_name"],
    )


# Return the graph library available to the authenticated account.
@app.get("/graphs", response_model=List[GraphSummary])
def list_graphs_endpoint(current_user: Dict[str, Any] = Depends(get_current_user)):
    graphs = list_graphs_for_user(current_user["id"])
    return [GraphSummary(**graph) for graph in graphs]


# Validate a graph name and create a graph administered by the authenticated account.
@app.post("/graphs", response_model=GraphSummary)
def create_graph_endpoint(
    payload: GraphCreateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    graph_name = clean_optional(payload.name)
    if not graph_name:
        raise HTTPException(status_code=422, detail="Le nom du graphe est obligatoire.")

    with get_security_connection() as connection:
        created = create_graph_record(
            connection,
            graph_name,
            clean_optional(payload.description),
            current_user["id"],
        )
        connection.commit()

    return GraphSummary(**created)


# Require graph administrator access before returning the graph's permission assignments.
@app.get("/graphs/{graph_id}/permissions", response_model=List[GraphPermission])
def list_graph_permissions_endpoint(
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_ADMIN)
    permissions = list_graph_permissions(graph_id)
    return [GraphPermission(**permission) for permission in permissions]


# Require graph administrator access before assigning a role to an account.
@app.post("/graphs/{graph_id}/permissions", response_model=GraphPermission)
def grant_graph_permission_endpoint(
    graph_id: str,
    payload: GraphPermissionAssignRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_ADMIN)
    granted = grant_graph_permission(
        graph_id,
        payload.user_id,
        payload.role,
        payload.password,
        payload.display_name,
    )
    return GraphPermission(**granted)


# Require graph administrator access before changing an existing permission.
@app.put("/graphs/{graph_id}/permissions/{user_id}", response_model=GraphPermission)
def update_graph_permission_endpoint(
    graph_id: str,
    user_id: str,
    payload: GraphPermissionUpdateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_ADMIN)
    updated = update_graph_permission_role(graph_id, user_id, payload.role)
    return GraphPermission(**updated)


# Require graph administrator access before revoking an account's graph permission.
@app.delete("/graphs/{graph_id}/permissions/{user_id}", response_model=DeleteResponse)
def delete_graph_permission_endpoint(
    graph_id: str,
    user_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_ADMIN)
    delete_graph_permission(graph_id, user_id)
    return DeleteResponse(deleted=True)


# Require edit access, validate person data, and create the person with automatic company links.
@app.post("/persons", response_model=Node)
def create_person_endpoint(
    person: PersonCreate,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_EDITOR)
    alias = resolve_alias_or_raise(person.alias, person.nom, person.prenom)
    validate_person_dates(person.date_naissance, person.date_mort)
    age = compute_age(person.date_naissance, person.date_mort)

    with driver.session() as session:
        created = session.execute_write(
            create_person,
            graph_id,
            alias,
            clean_optional(person.nom),
            clean_optional(person.prenom),
            to_iso_date(person.date_naissance),
            to_iso_date(person.date_mort),
            age,
            clean_optional(person.entreprise),
            clean_optional(person.description),
        )
        if created is None:
            raise HTTPException(status_code=500, detail="Creation de personne echouee.")
        session.execute_write(sync_same_company_links, graph_id, created["id"])
        return Node(
            id=created["id"],
            label=person_label(created),
            type="Person",
            info_categories=person_info_categories(created),
        )


# Require read access and return labeled person nodes for the requested graph.
@app.get("/persons", response_model=List[Node])
def list_persons(
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_VIEWER)
    with driver.session() as session:
        result = session.run(
            """
            MATCH (p:Person {graph_id: $graph_id})
            RETURN p
            ORDER BY coalesce(p.alias, p.nom, p.id)
            """,
            graph_id=graph_id,
        )
        return [
            Node(
                id=record["p"]["id"],
                label=person_label(record["p"]),
                type="Person",
                info_categories=person_info_categories(record["p"]),
            )
            for record in result
        ]


# Require read access and return a person's details, or report that the person is missing.
@app.get("/persons/{person_id}", response_model=PersonDetails)
def get_person_endpoint(
    person_id: str,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_VIEWER)
    with driver.session() as session:
        person = session.execute_read(get_person_by_id, graph_id, person_id)

    if person is None:
        raise HTTPException(status_code=404, detail="Personne introuvable.")
    return person_to_details(person)


# Require edit access, validate changes, and update a person and their automatic company links.
@app.put("/persons/{person_id}", response_model=PersonDetails)
def update_person_endpoint(
    person_id: str,
    person: PersonUpdate,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_EDITOR)
    alias = resolve_alias_or_raise(person.alias, person.nom, person.prenom)
    validate_person_dates(person.date_naissance, person.date_mort)
    age = compute_age(person.date_naissance, person.date_mort)

    with driver.session() as session:
        updated = session.execute_write(
            update_person_by_id,
            graph_id,
            person_id,
            alias,
            clean_optional(person.nom),
            clean_optional(person.prenom),
            to_iso_date(person.date_naissance),
            to_iso_date(person.date_mort),
            age,
            clean_optional(person.entreprise),
            clean_optional(person.description),
        )
        if updated is not None:
            session.execute_write(sync_same_company_links, graph_id, person_id)

    if updated is None:
        raise HTTPException(status_code=404, detail="Personne introuvable.")
    return person_to_details(updated)


# Require edit access and remove a person and their relationships from the graph.
@app.delete("/persons/{person_id}", response_model=DeleteResponse)
def delete_person_endpoint(
    person_id: str,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_EDITOR)
    with driver.session() as session:
        deleted = session.execute_write(delete_person_by_id, graph_id, person_id)

    if not deleted:
        raise HTTPException(status_code=404, detail="Personne introuvable.")
    return DeleteResponse(deleted=True)


# Require read access before returning the graph's company names for autocomplete.
@app.get("/companies", response_model=List[str])
def list_companies_endpoint(
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_VIEWER)
    with driver.session() as session:
        return session.execute_read(list_companies, graph_id)


# Require edit access and validate the endpoints and label before creating a relationship.
@app.post("/relations", response_model=Edge)
def create_relation_endpoint(
    rel: RelationCreate,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_EDITOR)
    label = normalize_relation_label_or_raise(rel.label)
    with driver.session() as session:
        record = session.execute_write(
            create_relation, graph_id, rel.from_id, rel.to_id, label
        )
        if record is None:
            raise HTTPException(
                status_code=404,
                detail="Impossible de creer le lien (noeuds source/cible introuvables).",
            )
        return Edge(
            id=record["id"],
            source=record["source"],
            target=record["target"],
            label=record["type"],
        )


# Require read access and return the graph's display nodes and edges.
@app.get("/graph", response_model=GraphResponse)
def get_graph(
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_VIEWER)
    with driver.session() as session:
        nodes, edges = session.execute_read(get_full_graph, graph_id)
        return GraphResponse(nodes=nodes, edges=edges)


# Require read access and return a complete JSON snapshot of the selected graph.
@app.get("/graph/export", response_model=GraphExportData)
def export_graph_endpoint(
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    graph_meta = require_graph_access(current_user["id"], graph_id, ROLE_VIEWER)
    with driver.session() as session:
        return session.execute_read(export_graph_snapshot, graph_id, graph_meta)


# Require edit access, validate an import payload, and merge or replace the selected graph.
@app.post("/graph/import", response_model=GraphImportResponse)
def import_graph_endpoint(
    request: GraphImportRequest,
    graph_id: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    require_graph_access(current_user["id"], graph_id, ROLE_EDITOR)
    normalized_persons = [
        normalize_import_person(raw_person, index)
        for index, raw_person in enumerate(request.data.persons)
    ]
    normalized_relations = [
        normalize_import_relation(raw_relation, index)
        for index, raw_relation in enumerate(request.data.relations)
    ]

    with driver.session() as session:
        result = session.execute_write(
            import_graph_snapshot,
            graph_id,
            normalized_persons,
            normalized_relations,
            request.replace_existing,
        )

    return GraphImportResponse(
        replaced=request.replace_existing,
        persons_imported=result["persons_imported"],
        relations_imported=result["relations_imported"],
    )


# Redirect the web API root to its interactive documentation.
@app.get("/")
def root():
    return RedirectResponse(url="/docs")
