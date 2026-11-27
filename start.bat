@echo off
echo ============================================
echo   LANCEMENT INFRA OSINT-GRAPH
echo ============================================

REM --- Resolve project paths from this script so any clone location works. ---
set "PROJECT_DIR=%~dp0"
set "BACKEND_DIR=%PROJECT_DIR%backend"
set "FRONTEND_DIR=%PROJECT_DIR%frontend"
set "VENV_DIR=%BACKEND_DIR%\venv"

echo.
echo [1/4] Vérification de Docker Desktop...

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker Desktop n'est pas lance. Tentative de lancement...

    REM --- Chemin Docker Desktop : verifie que c'est le bon ---
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Attente du démarrage de Docker...
    timeout /t 10 >nul

    docker info >nul 2>&1
    if %errorlevel% neq 0 (
        echo ERREUR : Docker n'est toujours pas disponible.
        echo Verifie Docker Desktop manuellement.
        pause
        exit /b 1
    )
)

echo.
echo [2/4] Démarrage Neo4j dans Docker...

docker ps -a --format "{{.Names}}" | findstr /C:"neo4j-osint" >nul
if %errorlevel% neq 0 (
    echo Le container Neo4j n'existe pas, creation...
    docker run -d ^
        -p 7474:7474 -p 7687:7687 ^
        -e NEO4J_AUTH=neo4j/neo4j123 ^
        --name neo4j-osint ^
        neo4j:5
) else (
    echo Container trouve, demarrage...
    docker start neo4j-osint >nul
)

echo.
echo [3/4] Lancement du backend FastAPI...
start powershell -NoExit -Command "cd '%BACKEND_DIR%'; ./venv/Scripts/activate; uvicorn main:app --reload --port 8000"

echo.
echo [4/4] Lancement du frontend React...
start powershell -NoExit -Command "cd '%FRONTEND_DIR%'; npm run dev"

echo.
echo ============================================
echo Infra OSINT-GRAPH lancee 🚀
echo --------------------------------------------
echo Backend :  http://localhost:8000/docs
echo Frontend : http://localhost:5173
echo Neo4j :    http://localhost:7474
echo ============================================
pause
