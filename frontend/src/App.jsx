import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import axios from "axios";
import cytoscape from "cytoscape";

const API_BASE = "http://localhost:8000";
const SESSION_TOKEN_KEY = "osint_graph_token";
const REL_FILTER_ALL = "__ALL__";
const SAME_COMPANY_RELATION_TYPE = "MEME_ENTREPRISE";
const DEFAULT_EDGE_COLOR = "#9ca3af";

const LARGE_GRAPH_THRESHOLD = 180;
const LARGE_GRAPH_INITIAL_ZOOM = 0.45;
const MINIMAP_WIDTH = 220;
const MINIMAP_HEIGHT = 150;
const BOX_ZOOM_MIN_SIZE = 12;
const ARROW_PAN_SPEED = 700;

const GRAPH_LAYOUT_DEFAULT = {
  name: "cose",
  fit: true,
  padding: 100,
  animate: "end",
  animationDuration: 450,
  randomize: true,
  nodeDimensionsIncludeLabels: true,
  componentSpacing: 220,
  nodeRepulsion: 420000,
  nodeOverlap: 20,
  idealEdgeLength: 260,
  edgeElasticity: 60,
  nestingFactor: 1.05,
  gravity: 0.12,
  numIter: 2200,
  initialTemp: 240,
  coolingFactor: 0.95,
  minTemp: 1,
};

const GRAPH_LAYOUT_EXPLODED = {
  name: "cose",
  fit: false,
  padding: 220,
  animate: "end",
  animationDuration: 600,
  randomize: true,
  nodeDimensionsIncludeLabels: true,
  componentSpacing: 380,
  nodeRepulsion: 1800000,
  nodeOverlap: 8,
  idealEdgeLength: 420,
  edgeElasticity: 35,
  nestingFactor: 1.1,
  gravity: 0.04,
  numIter: 3000,
  initialTemp: 300,
  coolingFactor: 0.95,
  minTemp: 1,
};

// Trim optional text and represent an empty value as null for API payloads.
function toOptionalString(value) {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Compute a stable unsigned hash used to choose a company color.
function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Assign a stable color to a normalized company name, with a fallback for missing names.
function colorFromCompany(company) {
  const normalized = (company ?? "").trim().toLowerCase();
  if (!normalized) return DEFAULT_EDGE_COLOR;
  const hue = hashString(normalized) % 360;
  return `hsl(${hue}, 68%, 42%)`;
}

// Keep a numeric value within the given inclusive bounds.
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Extract a readable API error detail or use the supplied fallback message.
function getApiErrorMessage(error, fallbackMessage) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail;
  }
  return fallbackMessage;
}

// Manage authentication, the graph library, and the interactive person and relationship editor.
function App() {
  const [authToken, setAuthToken] = useState(
    /* Restore the bearer token from this browser session when the app initializes. */ () => window.sessionStorage.getItem(SESSION_TOKEN_KEY) ?? ""
  );
  const [currentUser, setCurrentUser] = useState(null);
  const [graphs, setGraphs] = useState([]);
  const [selectedGraphId, setSelectedGraphId] = useState("");
  const [currentGraphRole, setCurrentGraphRole] = useState("");
  const [graphPermissions, setGraphPermissions] = useState([]);
  const [authLoading, setAuthLoading] = useState(Boolean(authToken));
  const [authError, setAuthError] = useState("");
  const [loginUserId, setLoginUserId] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [isAccessOpen, setIsAccessOpen] = useState(true);
  const [isAdministrationOpen, setIsAdministrationOpen] = useState(true);
  const [graphActionError, setGraphActionError] = useState("");
  const [graphActionMessage, setGraphActionMessage] = useState("");
  const [creatingGraph, setCreatingGraph] = useState(false);
  const [permissionUserId, setPermissionUserId] = useState("");
  const [permissionDisplayName, setPermissionDisplayName] = useState("");
  const [permissionPassword, setPermissionPassword] = useState("");
  const [permissionRole, setPermissionRole] = useState("viewer");
  const [permissionSubmitting, setPermissionSubmitting] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const [permissionMessage, setPermissionMessage] = useState("");
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [persons, setPersons] = useState([]);
  const [companies, setCompanies] = useState([]);

  const [personAlias, setPersonAlias] = useState("");
  const [personNom, setPersonNom] = useState("");
  const [personPrenom, setPersonPrenom] = useState("");
  const [personDateNaissance, setPersonDateNaissance] = useState("");
  const [personDateMort, setPersonDateMort] = useState("");
  const [personEntreprise, setPersonEntreprise] = useState("");
  const [personDescription, setPersonDescription] = useState("");

  const [relFrom, setRelFrom] = useState("");
  const [relFromSearch, setRelFromSearch] = useState("");
  const [relTo, setRelTo] = useState("");
  const [relToSearch, setRelToSearch] = useState("");
  const [relLabel, setRelLabel] = useState("CONNAIT");
  const [filterNodeId, setFilterNodeId] = useState("");
  const [filterNodeSearch, setFilterNodeSearch] = useState("");
  const [filterRelationType, setFilterRelationType] = useState(REL_FILTER_ALL);
  const [filterCompany, setFilterCompany] = useState("");
  const [filterHops, setFilterHops] = useState(1);
  const [isFilterOpen, setIsFilterOpen] = useState(true);
  const [isCreatePersonOpen, setIsCreatePersonOpen] = useState(true);
  const [isCreateRelationOpen, setIsCreateRelationOpen] = useState(true);
  const [isDetailsFormOpen, setIsDetailsFormOpen] = useState(true);

  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsDeleting, setDetailsDeleting] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [detailsMessage, setDetailsMessage] = useState("");

  const [editAlias, setEditAlias] = useState("");
  const [editNom, setEditNom] = useState("");
  const [editPrenom, setEditPrenom] = useState("");
  const [editDateNaissance, setEditDateNaissance] = useState("");
  const [editDateMort, setEditDateMort] = useState("");
  const [editEntreprise, setEditEntreprise] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const importFileInputRef = useRef(null);
  const libraryImportFileInputRef = useRef(null);
  const miniMapCanvasRef = useRef(null);
  const miniMapViewportRef = useRef(null);
  const miniMapTransformRef = useRef(null);
  const miniMapRafRef = useRef(null);
  const boxZoomDragRef = useRef(null);
  const arrowPanStateRef = useRef({
    left: false,
    right: false,
    up: false,
    down: false,
    shift: false,
    rafId: null,
    lastTs: 0,
  });

  const [isBoxZoomMode, setIsBoxZoomMode] = useState(false);
  const [boxZoomRect, setBoxZoomRect] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isLibraryImporting, setIsLibraryImporting] = useState(false);
  const [transferMessage, setTransferMessage] = useState("");
  const [transferError, setTransferError] = useState("");

  const canEditGraph =
    currentGraphRole === "editor" || currentGraphRole === "admin";
  const canAdminGraph = currentGraphRole === "admin";

  // Clear the stored session and graph state, optionally showing a sign-in message.
  const clearSession = useCallback((message = "") => {
    window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    setAuthLoading(false);
    setAuthToken("");
    setCurrentUser(null);
    setGraphs([]);
    setSelectedGraphId("");
    setCurrentGraphRole("");
    setGraphPermissions([]);
    setGraph({ nodes: [], edges: [] });
    setPersons([]);
    setCompanies([]);
    setSelectedPersonId("");
    setSelectedPerson(null);
    setAuthError(message);
  }, []);

  // Merge request options with the current bearer token.
  const getAuthConfig = useCallback(
    (extra = {}) => {
      const headers = {
        ...(extra.headers ?? {}),
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }
      return {
        ...extra,
        headers,
      };
    },
    [authToken]
  );

  // Add the selected or explicitly supplied graph identifier to an authenticated request.
  const getGraphConfig = useCallback(
    (extra = {}, graphIdOverride = null) => {
      const config = getAuthConfig(extra);
      const graphId = graphIdOverride ?? selectedGraphId;
      return {
        ...config,
        params: {
          ...(config.params ?? {}),
          ...(graphId ? { graph_id: graphId } : {}),
        },
      };
    },
    [getAuthConfig, selectedGraphId]
  );

  // Clear an expired session on an unauthorized response and report whether it was handled.
  const handleApiAuthError = useCallback(
    (error) => {
      if (error?.response?.status === 401) {
        clearSession("Session expiree. Reconnecte-toi.");
        return true;
      }
      return false;
    },
    [clearSession]
  );

  // Draw the graph overview and viewport rectangle using the current Cytoscape coordinates.
  const renderMiniMap = useCallback((cy) => {
    const canvas = miniMapCanvasRef.current;
    const viewport = miniMapViewportRef.current;
    if (!canvas || !viewport) return;

    const cssWidth = canvas.clientWidth || MINIMAP_WIDTH;
    const cssHeight = canvas.clientHeight || MINIMAP_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const nodes = cy.nodes();
    if (nodes.length === 0) {
      viewport.style.display = "none";
      miniMapTransformRef.current = null;
      return;
    }

    const nodeBounds = nodes.boundingBox({
      includeLabels: false,
      includeOverlays: false,
    });
    let graphBounds = nodeBounds;
    if (
      !Number.isFinite(nodeBounds.x1) ||
      !Number.isFinite(nodeBounds.y1) ||
      !Number.isFinite(nodeBounds.x2) ||
      !Number.isFinite(nodeBounds.y2)
    ) {
      const fallbackBounds = cy.elements().boundingBox({
        includeLabels: false,
        includeOverlays: false,
      });
      if (
        !Number.isFinite(fallbackBounds.x1) ||
        !Number.isFinite(fallbackBounds.y1) ||
        !Number.isFinite(fallbackBounds.x2) ||
        !Number.isFinite(fallbackBounds.y2)
      ) {
        const extent = cy.extent();
        if (
          !Number.isFinite(extent.x1) ||
          !Number.isFinite(extent.y1) ||
          !Number.isFinite(extent.x2) ||
          !Number.isFinite(extent.y2)
        ) {
          viewport.style.display = "none";
          miniMapTransformRef.current = null;
          return;
        }
        graphBounds = {
          x1: extent.x1,
          y1: extent.y1,
          x2: extent.x2,
          y2: extent.y2,
        };
      } else {
        graphBounds = fallbackBounds;
      }
    }
    const boundsPadding = 60;
    const worldX1 = graphBounds.x1 - boundsPadding;
    const worldY1 = graphBounds.y1 - boundsPadding;
    const worldX2 = graphBounds.x2 + boundsPadding;
    const worldY2 = graphBounds.y2 + boundsPadding;

    const worldWidth = Math.max(1, worldX2 - worldX1);
    const worldHeight = Math.max(1, worldY2 - worldY1);
    const scale = Math.min(cssWidth / worldWidth, cssHeight / worldHeight);
    const offsetX = (cssWidth - worldWidth * scale) / 2;
    const offsetY = (cssHeight - worldHeight * scale) / 2;

    // Convert a graph x-coordinate into a minimap canvas coordinate.
    const toMiniX = (x) => offsetX + (x - worldX1) * scale;
    // Convert a graph y-coordinate into a minimap canvas coordinate.
    const toMiniY = (y) => offsetY + (y - worldY1) * scale;

    const edges = cy.edges();
    ctx.save();
    ctx.globalAlpha = 0.35;
    edges.forEach((edge) => {
      // Draw a relationship line on the minimap using its graph color.
      const sourcePos = edge.source().position();
      const targetPos = edge.target().position();

      ctx.beginPath();
      ctx.moveTo(toMiniX(sourcePos.x), toMiniY(sourcePos.y));
      ctx.lineTo(toMiniX(targetPos.x), toMiniY(targetPos.y));
      ctx.lineWidth = 1;
      ctx.strokeStyle = edge.data("color") || "#9ca3af";
      ctx.stroke();
    });
    ctx.restore();

    nodes.forEach((node) => {
      // Draw a person marker on the minimap, highlighting selected nodes.
      const pos = node.position();
      const radius = node.selected() ? 3.2 : 2.4;
      ctx.beginPath();
      ctx.arc(toMiniX(pos.x), toMiniY(pos.y), radius, 0, Math.PI * 2);
      ctx.fillStyle = node.selected() ? "#10b981" : "#4f46e5";
      ctx.fill();
    });

    const extent = cy.extent();
    const viewportLeft = clamp(toMiniX(extent.x1), 0, cssWidth);
    const viewportTop = clamp(toMiniY(extent.y1), 0, cssHeight);
    const viewportWidth = clamp(Math.max(2, (extent.x2 - extent.x1) * scale), 2, cssWidth);
    const viewportHeight = clamp(Math.max(2, (extent.y2 - extent.y1) * scale), 2, cssHeight);

    viewport.style.display = "block";
    viewport.style.left = `${viewportLeft}px`;
    viewport.style.top = `${viewportTop}px`;
    viewport.style.width = `${viewportWidth}px`;
    viewport.style.height = `${viewportHeight}px`;

    miniMapTransformRef.current = {
      worldX1,
      worldY1,
      scale,
      offsetX,
      offsetY,
    };
  }, []);

  // Coalesce minimap redraw requests into a single animation frame.
  const scheduleMiniMapRender = useCallback(() => {
    if (miniMapRafRef.current !== null) return;
    miniMapRafRef.current = requestAnimationFrame(() => {
      // Clear the pending frame marker and redraw the minimap from the current graph.
      miniMapRafRef.current = null;
      const cy = cyRef.current;
      if (cy) {
        renderMiniMap(cy);
      }
    });
  }, [renderMiniMap]);

  // Discard the active box-zoom drag and its selection rectangle.
  const clearBoxZoom = useCallback(() => {
    boxZoomDragRef.current = null;
    setBoxZoomRect(null);
  }, []);

  // Convert a dragged rectangle to graph coordinates and animate zooming in or out around it.
  const applyBoxZoom = useCallback(
    (startX, startY, endX, endY, mode) => {
      const cy = cyRef.current;
      const container = containerRef.current;
      if (!cy || !container) return;

      const minX = Math.min(startX, endX);
      const minY = Math.min(startY, endY);
      const maxX = Math.max(startX, endX);
      const maxY = Math.max(startY, endY);
      const width = maxX - minX;
      const height = maxY - minY;

      if (width < BOX_ZOOM_MIN_SIZE || height < BOX_ZOOM_MIN_SIZE) {
        return;
      }

      const zoom = cy.zoom();
      const pan = cy.pan();
      const boxX1 = (minX - pan.x) / zoom;
      const boxY1 = (minY - pan.y) / zoom;
      const boxX2 = (maxX - pan.x) / zoom;
      const boxY2 = (maxY - pan.y) / zoom;

      if (mode === "out") {
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const factorX = container.clientWidth / width;
        const factorY = container.clientHeight / height;
        const factor = Math.max(1.01, Math.min(factorX, factorY));

        const modelCenterX = (centerX - pan.x) / zoom;
        const modelCenterY = (centerY - pan.y) / zoom;
        const newZoom = clamp(zoom / factor, cy.minZoom(), cy.maxZoom());
        const targetPan = {
          x: container.clientWidth / 2 - modelCenterX * newZoom,
          y: container.clientHeight / 2 - modelCenterY * newZoom,
        };

        cy.animate({
          zoom: newZoom,
          pan: targetPan,
          duration: 250,
        });
      } else {
        cy.animate({
          fit: {
            boundingBox: {
              x1: boxX1,
              y1: boxY1,
              x2: boxX2,
              y2: boxY2,
            },
            padding: 24,
          },
          duration: 250,
        });
      }

      scheduleMiniMapRender();
    },
    [scheduleMiniMapRender]
  );

  // Start a captured box-zoom drag, using the right mouse button to zoom out.
  const handleGraphPointerDown = useCallback(
    (event) => {
      if (!isBoxZoomMode || (event.button !== 0 && event.button !== 2)) return;

      const container = containerRef.current;
      if (!container) return;

      const bounds = container.getBoundingClientRect();
      const startX = clamp(event.clientX - bounds.left, 0, bounds.width);
      const startY = clamp(event.clientY - bounds.top, 0, bounds.height);

      boxZoomDragRef.current = {
        pointerId: event.pointerId,
        mode: event.button === 2 ? "out" : "in",
        startX,
        startY,
        currentX: startX,
        currentY: startY,
      };
      setBoxZoomRect({
        mode: event.button === 2 ? "out" : "in",
        left: startX,
        top: startY,
        width: 0,
        height: 0,
      });

      if (event.currentTarget.setPointerCapture) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [isBoxZoomMode]
  );

  // Update the visible zoom rectangle while its captured pointer moves.
  const handleGraphPointerMove = useCallback((event) => {
    const drag = boxZoomDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const container = containerRef.current;
    const cy = cyRef.current;
    if (!container || !cy) return;

    const bounds = container.getBoundingClientRect();
    const currentX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const currentY = clamp(event.clientY - bounds.top, 0, bounds.height);

    drag.currentX = currentX;
    drag.currentY = currentY;

    const left = Math.min(drag.startX, currentX);
    const top = Math.min(drag.startY, currentY);
    const width = Math.abs(currentX - drag.startX);
    const height = Math.abs(currentY - drag.startY);
    setBoxZoomRect({ mode: drag.mode, left, top, width, height });

    event.preventDefault();
  }, []);

  // Release the captured pointer, apply the selected box zoom, and clear the drag state.
  const handleGraphPointerUp = useCallback(
    (event) => {
      const drag = boxZoomDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      if (event.currentTarget.releasePointerCapture) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      applyBoxZoom(
        drag.startX,
        drag.startY,
        drag.currentX,
        drag.currentY,
        drag.mode
      );
      clearBoxZoom();
      event.preventDefault();
    },
    [applyBoxZoom, clearBoxZoom]
  );

  // Discard a box-zoom selection when its pointer interaction is canceled.
  const handleGraphPointerCancel = useCallback(
    (event) => {
      const drag = boxZoomDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      clearBoxZoom();
    },
    [clearBoxZoom]
  );

  // Recenter the graph viewport on the position clicked in the minimap.
  const handleMiniMapPointerDown = useCallback(
    (event) => {
      const cy = cyRef.current;
      const transform = miniMapTransformRef.current;
      if (!cy || !transform) return;

      const bounds = event.currentTarget.getBoundingClientRect();
      const clickX = clamp(event.clientX - bounds.left, 0, bounds.width);
      const clickY = clamp(event.clientY - bounds.top, 0, bounds.height);
      const modelX = (clickX - transform.offsetX) / transform.scale + transform.worldX1;
      const modelY = (clickY - transform.offsetY) / transform.scale + transform.worldY1;

      const zoom = cy.zoom();
      const targetPan = {
        x: cy.width() / 2 - modelX * zoom,
        y: cy.height() / 2 - modelY * zoom,
      };

      cy.animate({
        pan: targetPan,
        duration: 180,
      });
      scheduleMiniMapRender();
    },
    [scheduleMiniMapRender]
  );

  // Suppress the browser context menu while right-click box zoom is enabled.
  const handleGraphContextMenu = useCallback(
    (event) => {
      if (!isBoxZoomMode) return;
      event.preventDefault();
    },
    [isBoxZoomMode]
  );

  useEffect(() => {
    // Register cleanup for any minimap frame still pending when the component unmounts.
    return () => {
      // Cancel a pending minimap animation frame during component cleanup.
      if (miniMapRafRef.current !== null) {
        cancelAnimationFrame(miniMapRafRef.current);
      }
    };
  }, []);

  // ---------- API CALLS ----------

  // Refresh accessible graphs and keep the selected graph only if access still exists.
  const fetchAvailableGraphs = useCallback(
    async (nextActiveGraphId) => {
      if (!authToken) {
        setGraphs([]);
        return [];
      }
      try {
        const res = await axios.get(`${API_BASE}/graphs`, getAuthConfig());
        const graphItems = res.data;
        setGraphs(graphItems);
        if (typeof nextActiveGraphId === "string") {
          const exists = graphItems.some(/* Check whether the requested graph remains in the accessible graph library. */ (item) => item.id === nextActiveGraphId);
          setSelectedGraphId(exists ? nextActiveGraphId : "");
        } else if (
          selectedGraphId &&
          !graphItems.some(/* Check whether the currently selected graph remains accessible. */ (item) => item.id === selectedGraphId)
        ) {
          setSelectedGraphId("");
        }
        return graphItems;
      } catch (err) {
        if (!handleApiAuthError(err)) {
          setAuthError(getApiErrorMessage(err, "Impossible de charger les graphes."));
        }
        return [];
      }
    },
    [authToken, getAuthConfig, handleApiAuthError, selectedGraphId]
  );

  // Load the selected graph's nodes and edges, handling expired sessions.
  const fetchGraph = useCallback(async () => {
    if (!authToken || !selectedGraphId) {
      setGraph({ nodes: [], edges: [] });
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/graph`, getGraphConfig());
      setGraph(res.data);
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur fetchGraph:", err);
      }
    }
  }, [authToken, getGraphConfig, handleApiAuthError, selectedGraphId]);

  // Refresh the selected graph's person list for selection and autocomplete.
  const fetchPersons = useCallback(async () => {
    if (!authToken || !selectedGraphId) {
      setPersons([]);
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/persons`, getGraphConfig());
      setPersons(res.data);
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur fetchPersons:", err);
      }
    }
  }, [authToken, getGraphConfig, handleApiAuthError, selectedGraphId]);

  // Refresh company names used by graph filters and person forms.
  const fetchCompanies = useCallback(async () => {
    if (!authToken || !selectedGraphId) {
      setCompanies([]);
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/companies`, getGraphConfig());
      setCompanies(res.data);
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur fetchCompanies:", err);
      }
    }
  }, [authToken, getGraphConfig, handleApiAuthError, selectedGraphId]);

  // Load the selected graph's permissions when the current account administers it.
  const fetchGraphPermissions = useCallback(async () => {
    if (!authToken || !selectedGraphId || !canAdminGraph) {
      setGraphPermissions([]);
      return;
    }
    try {
      const res = await axios.get(
        `${API_BASE}/graphs/${selectedGraphId}/permissions`,
        getAuthConfig()
      );
      setGraphPermissions(res.data);
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur chargement permissions:", err);
      }
    }
  }, [
    authToken,
    canAdminGraph,
    getAuthConfig,
    handleApiAuthError,
    selectedGraphId,
  ]);

  // Load a person's full record and populate the detail-editing form.
  const loadPersonDetails = useCallback(
    async (personId) => {
      if (!personId || !selectedGraphId) return;
      setDetailsLoading(true);
      setDetailsError("");
      setDetailsMessage("");

      try {
        const res = await axios.get(
          `${API_BASE}/persons/${personId}`,
          getGraphConfig()
        );
        const p = res.data;
        setSelectedPerson(p);
        setEditAlias(p.alias ?? "");
        setEditNom(p.nom ?? "");
        setEditPrenom(p.prenom ?? "");
        setEditDateNaissance(p.date_naissance ?? "");
        setEditDateMort(p.date_mort ?? "");
        setEditEntreprise(p.entreprise ?? "");
        setEditDescription(p.description ?? "");
      } catch (err) {
        if (!handleApiAuthError(err)) {
          console.error("Erreur chargement details personne:", err);
          setDetailsError("Impossible de charger les details de la personne.");
        }
      } finally {
        setDetailsLoading(false);
      }
    },
    [getGraphConfig, handleApiAuthError, selectedGraphId]
  );

  useEffect(() => {
    // Keep browser session storage synchronized with the current bearer token.
    if (authToken) {
      window.sessionStorage.setItem(SESSION_TOKEN_KEY, authToken);
    } else {
      window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
    }
  }, [authToken]);

  useEffect(() => {
    // Validate a stored session and load its account and graphs when authentication changes.
    if (!authToken) {
      setAuthLoading(false);
      return;
    }

    let isMounted = true;
    setAuthLoading(true);
    setAuthError("");

    // Restore the current account and graph library from a stored session, ignoring stale responses.
    const loadSession = async () => {
      try {
        const [meRes, graphsRes] = await Promise.all([
          axios.get(`${API_BASE}/auth/me`, getAuthConfig()),
          axios.get(`${API_BASE}/graphs`, getAuthConfig()),
        ]);
        if (!isMounted) return;

        setCurrentUser(meRes.data);
        setGraphs(graphsRes.data);
        setSelectedGraphId("");
      } catch (err) {
        if (!isMounted) return;
        if (!handleApiAuthError(err)) {
          setAuthError(getApiErrorMessage(err, "Impossible de charger la session."));
        }
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadSession();
    return () => {
      // Ignore session-loading results after this effect has been replaced or unmounted.
      isMounted = false;
    };
  }, [authToken, getAuthConfig, handleApiAuthError]);

  useEffect(() => {
    // Synchronize the current graph role with the selected graph and refreshed permissions.
    const currentGraph = graphs.find(/* Find the selected graph by its identifier. */ (graphItem) => graphItem.id === selectedGraphId);
    setCurrentGraphRole(currentGraph?.role ?? "");
  }, [graphs, selectedGraphId]);

  useEffect(() => {
    // Reset person selection, graph filters, relationship inputs, and messages when switching graphs.
    setSelectedPersonId("");
    setSelectedPerson(null);
    setFilterNodeId("");
    setFilterNodeSearch("");
    setFilterRelationType(REL_FILTER_ALL);
    setFilterCompany("");
    setFilterHops(1);
    setRelFrom("");
    setRelFromSearch("");
    setRelTo("");
    setRelToSearch("");
    setTransferMessage("");
    setTransferError("");
    setGraphActionMessage("");
    setGraphActionError("");
  }, [selectedGraphId]);

  useEffect(() => {
    // Load the selected graph's data or clear it when no authenticated graph is selected.
    if (!authToken || !selectedGraphId) {
      setGraph({ nodes: [], edges: [] });
      setPersons([]);
      setCompanies([]);
      setGraphPermissions([]);
      setSelectedPersonId("");
      setSelectedPerson(null);
      return;
    }

    fetchGraph();
    fetchPersons();
    fetchCompanies();
  }, [authToken, fetchCompanies, fetchGraph, fetchPersons, selectedGraphId]);

  useEffect(() => {
    // Refresh graph permissions for administrators and clear them when administration is lost.
    if (!canAdminGraph) {
      setGraphPermissions([]);
      return;
    }
    fetchGraphPermissions();
  }, [canAdminGraph, fetchGraphPermissions, selectedGraphId]);

  // Submit login credentials and store the returned session for authenticated API calls.
  const handleLogin = useCallback(async (event) => {
    event.preventDefault();
    setLoginSubmitting(true);
    setAuthError("");
    try {
      const res = await axios.post(`${API_BASE}/auth/login`, {
        user_id: loginUserId,
        password: loginPassword,
      });
      setAuthToken(res.data.token);
      setCurrentUser(res.data.user);
      setLoginPassword("");
    } catch (err) {
      setAuthError(getApiErrorMessage(err, "Connexion impossible."));
    } finally {
      setLoginSubmitting(false);
    }
  }, [loginPassword, loginUserId]);

  // Request session revocation and clear local authentication state.
  const handleLogout = useCallback(async () => {
    try {
      if (authToken) {
        await axios.post(`${API_BASE}/auth/logout`, {}, getAuthConfig());
      }
    } catch (err) {
      console.error("Erreur logout:", err);
    } finally {
      clearSession("");
    }
  }, [authToken, clearSession, getAuthConfig]);

  // Create a named graph and return its metadata while managing creation feedback.
  const createGraphByName = useCallback(async (graphName) => {
    const name = toOptionalString(graphName);
    if (!name) {
      return null;
    }

    setCreatingGraph(true);
    setGraphActionError("");
    setGraphActionMessage("");
    try {
      const res = await axios.post(
        `${API_BASE}/graphs`,
        { name, description: null },
        getAuthConfig()
      );
      return res.data;
    } catch (err) {
      if (!handleApiAuthError(err)) {
        setGraphActionError(getApiErrorMessage(err, "Impossible de creer le graphe."));
      }
      return null;
    } finally {
      setCreatingGraph(false);
    }
  }, [getAuthConfig, handleApiAuthError]);

  // Prompt for a graph name, create the graph, and select it in the refreshed library.
  const handleCreateGraph = useCallback(async () => {
    const proposedName = window.prompt("Nom du nouveau graphe ?", "Nouveau graphe");
    const createdGraph = await createGraphByName(proposedName);
    if (!createdGraph) {
      return;
    }

    await fetchAvailableGraphs(createdGraph.id);
    setGraphActionMessage("Graphe cree.");
  }, [createGraphByName, fetchAvailableGraphs]);

  // Read a JSON file, create a graph for its contents, and import its snapshot into that graph.
  const handleLibraryImportGraph = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLibraryImporting(true);
    setGraphActionError("");
    setGraphActionMessage("");

    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Format JSON invalide.");
      }

      if (!parsed || !Array.isArray(parsed.persons) || !Array.isArray(parsed.relations)) {
        throw new Error(
          "Le fichier doit contenir { persons: [...], relations: [...] }."
        );
      }

      const defaultName =
        toOptionalString(parsed?.graph?.name) ??
        toOptionalString(file.name.replace(/\.json$/i, "")) ??
        "Graphe importe";

      const createdGraph = await createGraphByName(defaultName);
      if (!createdGraph) {
        return;
      }

      const response = await axios.post(
        `${API_BASE}/graph/import`,
        {
          replace_existing: true,
          data: parsed,
        },
        getGraphConfig({}, createdGraph.id)
      );

      await fetchAvailableGraphs(createdGraph.id);
      setGraphActionMessage(
        `Import termine (${response.data.persons_imported} personnes, ${response.data.relations_imported} liens).`
      );
    } catch (err) {
      if (!handleApiAuthError(err)) {
        setGraphActionError(getApiErrorMessage(err, "Impossible d'importer le graphe."));
      }
    } finally {
      event.target.value = "";
      setIsLibraryImporting(false);
    }
  }, [
    createGraphByName,
    fetchAvailableGraphs,
    getGraphConfig,
    handleApiAuthError,
  ]);

  // Submit an account's graph role and optional account details, then refresh the permission list.
  const handleGrantPermission = useCallback(async (event) => {
    event.preventDefault();
    if (!selectedGraphId) return;
    setPermissionSubmitting(true);
    setPermissionError("");
    setPermissionMessage("");
    try {
      await axios.post(
        `${API_BASE}/graphs/${selectedGraphId}/permissions`,
        {
          user_id: permissionUserId,
          display_name: toOptionalString(permissionDisplayName),
          password: toOptionalString(permissionPassword),
          role: permissionRole,
        },
        getAuthConfig()
      );
      await fetchGraphPermissions();
      setPermissionUserId("");
      setPermissionDisplayName("");
      setPermissionPassword("");
      setPermissionRole("viewer");
      setPermissionMessage("Droit utilisateur mis a jour.");
    } catch (err) {
      if (!handleApiAuthError(err)) {
        setPermissionError(getApiErrorMessage(err, "Impossible de gerer cet acces."));
      }
    } finally {
      setPermissionSubmitting(false);
    }
  }, [
    fetchGraphPermissions,
    getAuthConfig,
    handleApiAuthError,
    permissionDisplayName,
    permissionPassword,
    permissionRole,
    permissionUserId,
    selectedGraphId,
  ]);

  // Update a graph member's role and refresh both permissions and the current account's access.
  const handlePermissionRoleChange = useCallback(async (userId, nextRole) => {
    if (!selectedGraphId) return;
    setPermissionError("");
    setPermissionMessage("");
    try {
      await axios.put(
        `${API_BASE}/graphs/${selectedGraphId}/permissions/${userId}`,
        { role: nextRole },
        getAuthConfig()
      );
      const refreshedGraphs = await fetchAvailableGraphs(selectedGraphId);
      const refreshedCurrent = refreshedGraphs.find(
        /* Find the selected graph in the refreshed access list. */ (graphItem) => graphItem.id === selectedGraphId
      );
      if (refreshedCurrent?.role === "admin") {
        await fetchGraphPermissions();
      } else {
        setGraphPermissions([]);
      }
      setPermissionMessage("Role mis a jour.");
    } catch (err) {
      if (!handleApiAuthError(err)) {
        setPermissionError(getApiErrorMessage(err, "Impossible de modifier ce role."));
      }
    }
  }, [
    fetchAvailableGraphs,
    fetchGraphPermissions,
    getAuthConfig,
    handleApiAuthError,
    selectedGraphId,
  ]);

  // Confirm removal of graph access and refresh permissions and the graph library afterward.
  const handleDeletePermission = useCallback(async (userId) => {
    if (!selectedGraphId) return;
    const confirmed = window.confirm("Retirer cet utilisateur de ce graphe ?");
    if (!confirmed) return;
    setPermissionError("");
    setPermissionMessage("");
    try {
      await axios.delete(
        `${API_BASE}/graphs/${selectedGraphId}/permissions/${userId}`,
        getAuthConfig()
      );
      const refreshedGraphs = await fetchAvailableGraphs(selectedGraphId);
      const refreshedCurrent = refreshedGraphs.find(
        /* Find the selected graph in the refreshed access list. */ (graphItem) => graphItem.id === selectedGraphId
      );
      if (refreshedCurrent?.role === "admin") {
        await fetchGraphPermissions();
      } else {
        setGraphPermissions([]);
      }
      setPermissionMessage("Acces retire.");
    } catch (err) {
      if (!handleApiAuthError(err)) {
        setPermissionError(getApiErrorMessage(err, "Impossible de retirer cet acces."));
      }
    }
  }, [
    fetchAvailableGraphs,
    fetchGraphPermissions,
    getAuthConfig,
    handleApiAuthError,
    selectedGraphId,
  ]);

  // Fetch the current graph snapshot and save it as a timestamped JSON export.
  const handleExportGraph = useCallback(async () => {
    setTransferError("");
    setTransferMessage("");
    setIsExporting(true);
    try {
      const res = await axios.get(`${API_BASE}/graph/export`, getGraphConfig());
      const now = new Date();
      const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      const graphName =
        graphs.find(/* Find the selected graph metadata for naming its export. */ (graphItem) => graphItem.id === selectedGraphId)?.name ??
        "graph";
      const safeGraphName = graphName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const fileName = `osint-graph-${safeGraphName}-${timestamp}.json`;

      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json",
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      setTransferMessage("Export JSON termine.");
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur export graphe:", err);
        setTransferError(getApiErrorMessage(err, "Impossible d'exporter le graphe."));
      }
    } finally {
      setIsExporting(false);
    }
  }, [getGraphConfig, graphs, handleApiAuthError, selectedGraphId]);

  // Read and validate a JSON snapshot, confirm replacement, and refresh the imported graph's data.
  const handleImportGraph = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file || !selectedGraphId) return;

    setTransferError("");
    setTransferMessage("");
    setIsImporting(true);

    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Format JSON invalide.");
      }

      if (!parsed || !Array.isArray(parsed.persons) || !Array.isArray(parsed.relations)) {
        throw new Error(
          "Le fichier doit contenir { persons: [...], relations: [...] }."
        );
      }

      const confirmed = window.confirm(
        "Importer ce fichier et remplacer le graphe actuel ?"
      );
      if (!confirmed) {
        return;
      }

      const response = await axios.post(
        `${API_BASE}/graph/import`,
        {
          replace_existing: true,
          data: parsed,
        },
        getGraphConfig()
      );

      setSelectedPersonId("");
      setFilterNodeId("");
      setFilterNodeSearch("");
      setFilterRelationType(REL_FILTER_ALL);
      setFilterCompany("");
      setFilterHops(1);

      await fetchPersons();
      await fetchCompanies();
      await fetchGraph();

      setTransferMessage(
        `Import termine (${response.data.persons_imported} personnes, ${response.data.relations_imported} liens).`
      );
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur import graphe:", err);
        const apiDetail = err?.response?.data?.detail;
        if (typeof apiDetail === "string") {
          setTransferError(apiDetail);
        } else if (err instanceof Error) {
          setTransferError(err.message);
        } else {
          setTransferError("Impossible d'importer le graphe.");
        }
      }
    } finally {
      event.target.value = "";
      setIsImporting(false);
    }
  }, [
    fetchCompanies,
    fetchGraph,
    fetchPersons,
    getGraphConfig,
    handleApiAuthError,
    selectedGraphId,
  ]);

  useEffect(() => {
    // Load newly selected person details or clear the detail panel when selection is removed.
    if (!selectedPersonId) {
      setSelectedPerson(null);
      setDetailsError("");
      setDetailsMessage("");
      return;
    }
    loadPersonDetails(selectedPersonId);
  }, [selectedPersonId, loadPersonDetails]);

  useEffect(() => {
    // Keep the person filter label synchronized with its record and clear missing selections.
    if (!filterNodeId) return;
    const selected = persons.find(/* Find the person currently used as the graph filter seed. */ (p) => p.id === filterNodeId);
    if (!selected) {
      setFilterNodeId("");
      setFilterNodeSearch("");
      return;
    }
    const selectedLabel = selected.label ?? "";
    if (filterNodeSearch !== selectedLabel) {
      setFilterNodeSearch(selectedLabel);
    }
  }, [filterNodeId, persons, filterNodeSearch]);

  useEffect(() => {
    // Refresh the relationship source label and clear it if the person no longer exists.
    if (!relFrom) return;
    const selected = persons.find(/* Find the currently selected relationship source person. */ (p) => p.id === relFrom);
    if (!selected) {
      setRelFrom("");
      setRelFromSearch("");
      return;
    }
    const selectedLabel = selected.label ?? "";
    if (relFromSearch !== selectedLabel) {
      setRelFromSearch(selectedLabel);
    }
  }, [relFrom, persons, relFromSearch]);

  useEffect(() => {
    // Refresh the relationship target label and clear it if the person no longer exists.
    if (!relTo) return;
    const selected = persons.find(/* Find the currently selected relationship target person. */ (p) => p.id === relTo);
    if (!selected) {
      setRelTo("");
      setRelToSearch("");
      return;
    }
    const selectedLabel = selected.label ?? "";
    if (relToSearch !== selectedLabel) {
      setRelToSearch(selectedLabel);
    }
  }, [relTo, persons, relToSearch]);

  // Produce a French-locale person list sorted by label for selection controls.
  const sortedPersons = useMemo(() => {
    return [...persons].sort(/* Compare person labels using French ordering without case or accent sensitivity. */ (a, b) =>
      (a.label ?? "").localeCompare(b.label ?? "", "fr", {
        sensitivity: "base",
      })
    );
  }, [persons]);

  // Resolve a typed label to a person using a trimmed, case-insensitive exact match.
  const findPersonByLabel = useCallback(
    (rawValue) => {
      const normalized = toOptionalString(rawValue)?.toLowerCase();
      if (!normalized) return null;
      return (
        sortedPersons.find(
          /* Match the normalized input against a person's label. */ (person) => (person.label ?? "").toLowerCase() === normalized
        ) ?? null
      );
    },
    [sortedPersons]
  );

  // Update the person filter text and resolve its selected node identifier.
  const handleFilterNodeInputChange = useCallback(
    (value) => {
      setFilterNodeSearch(value);
      const person = findPersonByLabel(value);
      setFilterNodeId(person?.id ?? "");
    },
    [findPersonByLabel]
  );

  // Resolve the relationship source from the person label entered by the user.
  const handleRelFromInputChange = useCallback(
    (value) => {
      setRelFromSearch(value);
      const person = findPersonByLabel(value);
      setRelFrom(person?.id ?? "");
    },
    [findPersonByLabel]
  );

  // Resolve the relationship target from the person label entered by the user.
  const handleRelToInputChange = useCallback(
    (value) => {
      setRelToSearch(value);
      const person = findPersonByLabel(value);
      setRelTo(person?.id ?? "");
    },
    [findPersonByLabel]
  );

  // Set or clear the person filter and synchronize its displayed label.
  const setFilterNodeFromId = useCallback(
    (personId) => {
      if (!personId) {
        setFilterNodeId("");
        setFilterNodeSearch("");
        return;
      }
      setFilterNodeId(personId);
      const selected = sortedPersons.find(/* Find the label belonging to the requested person identifier. */ (person) => person.id === personId);
      setFilterNodeSearch(selected?.label ?? "");
    },
    [sortedPersons]
  );

  // Submit a new person, reset the creation form, and refresh graph data and company options.
  const handleCreatePerson = async (e) => {
    e.preventDefault();
    if (!canEditGraph || !selectedGraphId) return;

    const nomNormalized = toOptionalString(personNom);
    const prenomNormalized = toOptionalString(personPrenom);
    const aliasInput = toOptionalString(personAlias);
    const alias =
      aliasInput ??
      (nomNormalized && prenomNormalized
        ? `${nomNormalized} ${prenomNormalized}`
        : null);
    if (!alias) return;

    if (
      personDateNaissance &&
      personDateMort &&
      personDateMort < personDateNaissance
    ) {
      return;
    }

    try {
      await axios.post(
        `${API_BASE}/persons`,
        {
          alias,
          nom: nomNormalized,
          prenom: prenomNormalized,
          date_naissance: personDateNaissance || null,
          date_mort: personDateMort || null,
          entreprise: toOptionalString(personEntreprise),
          description: toOptionalString(personDescription),
        },
        getGraphConfig()
      );

      setPersonAlias("");
      setPersonNom("");
      setPersonPrenom("");
      setPersonDateNaissance("");
      setPersonDateMort("");
      setPersonEntreprise("");
      setPersonDescription("");

      await fetchPersons();
      await fetchCompanies();
      await fetchGraph();
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur creation personne:", err);
      }
    }
  };

  // Save the selected person's edited fields and refresh the graph and detail panel.
  const handleUpdatePerson = async (e) => {
    e.preventDefault();
    if (!selectedPersonId || !canEditGraph || !selectedGraphId) return;

    const nomNormalized = toOptionalString(editNom);
    const prenomNormalized = toOptionalString(editPrenom);
    const aliasInput = toOptionalString(editAlias);
    const alias =
      aliasInput ??
      (nomNormalized && prenomNormalized
        ? `${nomNormalized} ${prenomNormalized}`
        : null);
    if (!alias) {
      setDetailsError("Renseigne un alias, ou bien nom + prenom.");
      return;
    }

    if (editDateNaissance && editDateMort && editDateMort < editDateNaissance) {
      setDetailsError("La date de mort doit etre apres la date de naissance.");
      return;
    }

    setDetailsError("");
    setDetailsMessage("");

    try {
      const res = await axios.put(
        `${API_BASE}/persons/${selectedPersonId}`,
        {
          alias,
          nom: nomNormalized,
          prenom: prenomNormalized,
          date_naissance: editDateNaissance || null,
          date_mort: editDateMort || null,
          entreprise: toOptionalString(editEntreprise),
          description: toOptionalString(editDescription),
        },
        getGraphConfig()
      );

      setSelectedPerson(res.data);
      setDetailsMessage("Modifications enregistrees.");

      await fetchPersons();
      await fetchCompanies();
      await fetchGraph();
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur modification personne:", err);
        setDetailsError(getApiErrorMessage(err, "Impossible de modifier la personne."));
      }
    }
  };

  // Confirm deletion of the selected person, remove it, and refresh the graph and selection state.
  const handleDeletePerson = async () => {
    if (!selectedPersonId || detailsDeleting || !canEditGraph || !selectedGraphId) return;

    const confirmed = window.confirm(
      "Supprimer cette personne ? Cette action est irreversible."
    );
    if (!confirmed) return;

    setDetailsDeleting(true);
    setDetailsError("");
    setDetailsMessage("");

    try {
      await axios.delete(
        `${API_BASE}/persons/${selectedPersonId}`,
        getGraphConfig()
      );
      closeDetailsPanel();
      await fetchPersons();
      await fetchCompanies();
      await fetchGraph();
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur suppression personne:", err);
        setDetailsError(getApiErrorMessage(err, "Impossible de supprimer la personne."));
      }
    } finally {
      setDetailsDeleting(false);
    }
  };

  // Clear person selection and reset the detail form to its expanded state for the next selection.
  const closeDetailsPanel = () => {
    setSelectedPersonId("");
    setIsDetailsFormOpen(true);
  };

  // Validate the selected people and relationship label, create the link, and refresh the graph.
  const handleCreateRelation = async (e) => {
    e.preventDefault();
    if (!relFrom || !relTo || !relLabel.trim() || !canEditGraph || !selectedGraphId) {
      return;
    }

    try {
      await axios.post(
        `${API_BASE}/relations`,
        {
          from_id: relFrom,
          to_id: relTo,
          label: relLabel,
        },
        getGraphConfig()
      );
      await fetchGraph();
    } catch (err) {
      if (!handleApiAuthError(err)) {
        console.error("Erreur creation relation:", err);
      }
    }
  };

  // ---------- ELEMENTS CYTOSCAPE ----------

  // Collect unique relationship labels and sort them for the relationship filter.
  const relationTypes = useMemo(() => {
    const labels = new Set(graph.edges.map(/* Extract each edge's relationship type for the filter options. */ (e) => e.label));
    return Array.from(labels).sort(/* Order relationship labels alphabetically. */ (a, b) => a.localeCompare(b));
  }, [graph.edges]);

  // Resolve metadata for the currently selected graph.
  const currentGraph = useMemo(
    () => graphs.find(/* Find the selected graph by its identifier. */ (graphItem) => graphItem.id === selectedGraphId) ?? null,
    [graphs, selectedGraphId]
  );

  // Normalize, remove empty values from, and sort company names for selection controls.
  const allCompanyOptions = useMemo(() => {
    return [...companies]
      .map(/* Normalize a company name before building autocomplete options. */ (company) => toOptionalString(company))
      .filter(Boolean)
      .sort(/* Order company names alphabetically. */ (a, b) => a.localeCompare(b));
  }, [companies]);

  useEffect(() => {
    // Clear the company filter when the selected relationship type no longer supports it.
    if (filterRelationType !== SAME_COMPANY_RELATION_TYPE && filterCompany) {
      setFilterCompany("");
    }
  }, [filterRelationType, filterCompany]);

  useEffect(() => {
    // Clear a company filter whose value no longer exists in the graph.
    if (!filterCompany) return;
    const exists = allCompanyOptions.includes(filterCompany);
    if (!exists) {
      setFilterCompany("");
    }
  }, [filterCompany, allCompanyOptions]);

  // Apply relationship, company, and hop-depth filters, then convert visible records to Cytoscape elements.
  const apiElements = useMemo(() => {
    if (graph.nodes.length === 0) {
      return [];
    }

    const hasRelationCriteria = filterRelationType !== REL_FILTER_ALL;
    const relationFilteredEdges =
      hasRelationCriteria
        ? graph.edges.filter(/* Keep edges matching the selected relationship type. */ (e) => e.label === filterRelationType)
        : graph.edges;
    const baseEdges =
      filterRelationType === SAME_COMPANY_RELATION_TYPE && filterCompany
        ? relationFilteredEdges.filter(
            /* Keep same-company edges matching the selected company. */ (e) => toOptionalString(e.company ?? "") === filterCompany
          )
        : relationFilteredEdges;

    const hasAnyFilter = Boolean(filterNodeId) || hasRelationCriteria;
    if (!hasAnyFilter) {
      return [
        ...graph.nodes.map(/* Convert a person record into a Cytoscape node. */ (n) => ({
          group: "nodes",
          data: {
            id: n.id,
            label: n.label,
            type: n.type,
          },
        })),
        ...graph.edges.map(/* Convert a relationship into a Cytoscape edge with its display color. */ (e) => ({
          group: "edges",
          data: {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            company: e.company ?? null,
            color:
              e.label === SAME_COMPANY_RELATION_TYPE
                ? colorFromCompany(e.company)
                : DEFAULT_EDGE_COLOR,
          },
        })),
      ];
    }

    const traversalEdges =
      filterNodeId && hasRelationCriteria ? baseEdges : graph.edges;

    const seedNodeIds = new Set();
    if (filterNodeId) {
      seedNodeIds.add(filterNodeId);
    } else if (hasRelationCriteria) {
      for (const edge of baseEdges) {
        seedNodeIds.add(edge.source);
        seedNodeIds.add(edge.target);
      }
    }

    if (seedNodeIds.size === 0) {
      return [];
    }

    const adjacency = new Map();
    for (const edge of traversalEdges) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
      adjacency.get(edge.source).push(edge.target);
      adjacency.get(edge.target).push(edge.source);
    }

    const maxDepth = Math.max(0, Number(filterHops) || 0);
    const visitedDepth = new Map();
    const queue = [];

    for (const seedId of seedNodeIds) {
      visitedDepth.set(seedId, 0);
      queue.push({ id: seedId, depth: 0 });
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;

      const neighbors = adjacency.get(current.id) ?? [];
      for (const neighborId of neighbors) {
        const nextDepth = current.depth + 1;
        const knownDepth = visitedDepth.get(neighborId);
        if (knownDepth !== undefined && knownDepth <= nextDepth) continue;
        visitedDepth.set(neighborId, nextDepth);
        queue.push({ id: neighborId, depth: nextDepth });
      }
    }

    const visibleNodeIds = new Set(visitedDepth.keys());
    const candidateEdges =
      maxDepth === 0 && hasRelationCriteria ? baseEdges : traversalEdges;
    const filteredEdges = candidateEdges.filter(
      /* Keep edges whose endpoints are both included in the filtered node set. */ (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );
    const filteredNodes = graph.nodes.filter(/* Keep people reached by the active graph filters. */ (n) => visibleNodeIds.has(n.id));

    return [
      ...filteredNodes.map(/* Convert a visible person into a Cytoscape node. */ (n) => ({
        group: "nodes",
        data: {
          id: n.id,
          label: n.label,
          type: n.type,
        },
      })),
      ...filteredEdges.map(/* Convert a visible relationship into a Cytoscape edge with its display color. */ (e) => ({
        group: "edges",
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          company: e.company ?? null,
          color:
            e.label === SAME_COMPANY_RELATION_TYPE
              ? colorFromCompany(e.company)
              : DEFAULT_EDGE_COLOR,
        },
      })),
    ];
  }, [graph, filterNodeId, filterRelationType, filterCompany, filterHops]);

  // ---------- INIT CYTOSCAPE (une seule fois) ----------

  useEffect(() => {
    // Initialize Cytoscape styling and selection listeners and arrange cleanup of the graph instance.
    if (!containerRef.current) return;
    if (cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      minZoom: 0.03,
      maxZoom: 3,
      wheelSensitivity: 1,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#4f46e5",
            label: "data(label)",
            color: "#ffffff",
            "font-size": 12,
            "text-valign": "center",
            "text-halign": "center",
            "text-outline-width": 2,
            "text-outline-color": "#4f46e5",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-style": "solid",
            "line-color": "data(color)",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 10,
            "text-background-opacity": 1,
            "text-background-color": "#f3f4f6",
            "text-background-padding": 2,
          },
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#10b981",
            "text-outline-color": "#10b981",
          },
        },
      ],
      layout: { name: "preset" },
    });
    cy.userPanningEnabled(true);

    // Schedule a minimap redraw after Cytoscape changes its view, layout, or selection.
    const handleMiniMapRefresh = () => {
      scheduleMiniMapRender();
    };

    cy.on("tap", "node", (evt) => {
      // Select a tapped person and open the detail form.
      const nodeId = evt.target.id();
      setSelectedPersonId(nodeId);
      setIsDetailsFormOpen(true);
    });

    cy.on("tap", (evt) => {
      // Clear person selection when the empty graph background is tapped.
      if (evt.target === cy) {
        setSelectedPersonId("");
      }
    });
    cy.on("pan zoom resize render position select unselect", handleMiniMapRefresh);
    cy.on("layoutstop", handleMiniMapRefresh);

    cyRef.current = cy;
    scheduleMiniMapRender();

    return () => {
      // Detach minimap listeners and destroy Cytoscape when its container is released.
      cy.off("pan zoom resize render position select unselect", handleMiniMapRefresh);
      cy.off("layoutstop", handleMiniMapRefresh);
      cy.destroy();
      cyRef.current = null;
    };
  }, [scheduleMiniMapRender]);

  // ---------- MISE A JOUR DU GRAPH ----------

  useEffect(() => {
    // Disable ordinary graph dragging while box-zoom selection is active.
    const cy = cyRef.current;
    if (!cy) return;
    cy.userPanningEnabled(!isBoxZoomMode);
  }, [isBoxZoomMode]);

  useEffect(() => {
    // Install keyboard listeners and an animation loop for smooth arrow-key panning.
    // Detect editable controls so graph keyboard shortcuts do not interrupt typing.
    const isTypingTarget = (target) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      );
    };

    // Pan the graph continuously from held arrow keys, using elapsed time and the Shift speed modifier.
    const stepLoop = (timestamp) => {
      const state = arrowPanStateRef.current;
      const cy = cyRef.current;
      if (!cy) {
        state.rafId = null;
        state.lastTs = 0;
        return;
      }

      if (!state.left && !state.right && !state.up && !state.down) {
        state.rafId = null;
        state.lastTs = 0;
        return;
      }

      if (!state.lastTs) {
        state.lastTs = timestamp;
      }
      const dt = Math.min(0.05, (timestamp - state.lastTs) / 1000);
      state.lastTs = timestamp;

      const speed = state.shift ? ARROW_PAN_SPEED * 1.8 : ARROW_PAN_SPEED;
      const dx =
        (state.left ? speed : 0) - (state.right ? speed : 0);
      const dy =
        (state.up ? speed : 0) - (state.down ? speed : 0);

      if (dx !== 0 || dy !== 0) {
        const pan = cy.pan();
        cy.pan({
          x: pan.x + dx * dt,
          y: pan.y + dy * dt,
        });
        scheduleMiniMapRender();
      }

      state.rafId = requestAnimationFrame(stepLoop);
    };

    // Start keyboard panning only when no animation frame is already scheduled.
    const startLoopIfNeeded = () => {
      const state = arrowPanStateRef.current;
      if (state.rafId !== null) return;
      state.lastTs = 0;
      state.rafId = requestAnimationFrame(stepLoop);
    };

    // Track arrow and Shift key presses and begin graph panning outside editable controls.
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;

      const state = arrowPanStateRef.current;
      if (event.key === "Shift") {
        state.shift = true;
        return;
      }

      let handled = true;
      if (event.key === "ArrowLeft") state.left = true;
      else if (event.key === "ArrowRight") state.right = true;
      else if (event.key === "ArrowUp") state.up = true;
      else if (event.key === "ArrowDown") state.down = true;
      else handled = false;

      if (!handled) return;
      event.preventDefault();
      startLoopIfNeeded();
    };

    // Clear the released arrow or Shift key from the keyboard-panning state.
    const handleKeyUp = (event) => {
      const state = arrowPanStateRef.current;
      if (event.key === "Shift") {
        state.shift = false;
        return;
      }

      if (event.key === "ArrowLeft") state.left = false;
      if (event.key === "ArrowRight") state.right = false;
      if (event.key === "ArrowUp") state.up = false;
      if (event.key === "ArrowDown") state.down = false;
    };

    // Clear held-key state when the window loses focus to prevent unwanted panning.
    const handleBlur = () => {
      const state = arrowPanStateRef.current;
      state.left = false;
      state.right = false;
      state.up = false;
      state.down = false;
      state.shift = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      // Remove keyboard listeners, cancel panning, and clear held-key state during cleanup.
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      const state = arrowPanStateRef.current;
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
      }
      state.rafId = null;
      state.lastTs = 0;
      state.left = false;
      state.right = false;
      state.up = false;
      state.down = false;
      state.shift = false;
    };
  }, [scheduleMiniMapRender]);

  useEffect(() => {
    // Replace rendered graph elements and choose a layout suited to the visible graph size.
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().remove();
    cy.add(apiElements);

    const isLargeGraph = cy.nodes().length >= LARGE_GRAPH_THRESHOLD;
    const layoutConfig = isLargeGraph
      ? GRAPH_LAYOUT_EXPLODED
      : GRAPH_LAYOUT_DEFAULT;

    const layout = cy.layout(layoutConfig);
    if (isLargeGraph) {
      layout.on("layoutstop", () => {
        // Center a large graph after layout and apply the bounded initial zoom.
        cy.center();
        cy.zoom(
          Math.max(
            cy.minZoom(),
            Math.min(cy.maxZoom(), LARGE_GRAPH_INITIAL_ZOOM)
          )
        );
        scheduleMiniMapRender();
      });
    }
    layout.run();
    scheduleMiniMapRender();
  }, [apiElements, scheduleMiniMapRender]);

  // Fit all visible graph elements into the viewport.
  const fitGraph = () => {
    const cy = cyRef.current;
    if (cy) cy.fit();
  };

  // Restore the default node, relationship, company, and hop-depth filters.
  const resetGraphFilter = () => {
    setFilterNodeId("");
    setFilterNodeSearch("");
    setFilterRelationType(REL_FILTER_ALL);
    setFilterCompany("");
    setFilterHops(1);
  };

  const isDepthFilterEnabled =
    Boolean(filterNodeId) || filterRelationType !== REL_FILTER_ALL;

  // ---------- RENDER ----------

  if (authLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui",
          backgroundColor: "#f3f4f6",
        }}
      >
        <div
          style={{
            width: "360px",
            backgroundColor: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: "12px",
            padding: "20px",
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.08)",
          }}
        >
          Chargement de la session...
        </div>
      </div>
    );
  }

  if (!authToken) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui",
          background:
            "radial-gradient(circle at top left, #dbeafe 0%, #eff6ff 45%, #f8fafc 100%)",
          padding: "24px",
        }}
      >
        <form
          onSubmit={handleLogin}
          style={{
            width: "100%",
            maxWidth: "380px",
            backgroundColor: "rgba(255,255,255,0.96)",
            border: "1px solid #d1d5db",
            borderRadius: "16px",
            padding: "24px",
            boxShadow: "0 18px 44px rgba(15, 23, 42, 0.12)",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "24px" }}>OSINT Graph</h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#4b5563" }}>
            Connexion requise pour acceder aux graphes et a leurs droits.
          </p>

          <label style={{ fontSize: "12px", fontWeight: 600 }}>Identifiant</label>
          <input
            type="text"
            value={loginUserId}
            onChange={/* Update the login identifier from the sign-in field. */ (e) => setLoginUserId(e.target.value)}
            autoComplete="username"
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
            }}
          />

          <label style={{ fontSize: "12px", fontWeight: 600 }}>Mot de passe</label>
          <input
            type="password"
            value={loginPassword}
            onChange={/* Update the password entered in the sign-in form. */ (e) => setLoginPassword(e.target.value)}
            autoComplete="current-password"
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
            }}
          />

          {authError && (
            <p style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
              {authError}
            </p>
          )}

          <button
            type="submit"
            disabled={loginSubmitting}
            style={{
              marginTop: "4px",
              padding: "10px 12px",
              border: "none",
              borderRadius: "10px",
              backgroundColor: loginSubmitting ? "#93c5fd" : "#2563eb",
              color: "#fff",
              fontWeight: 600,
              cursor: loginSubmitting ? "not-allowed" : "pointer",
            }}
          >
            {loginSubmitting ? "Connexion..." : "Se connecter"}
          </button>
        </form>
      </div>
    );
  }

  if (!selectedGraphId) {
    return (
      <div
        style={{
          minHeight: "100vh",
          fontFamily: "system-ui",
          background:
            "linear-gradient(135deg, #eff6ff 0%, #f8fafc 55%, #ecfeff 100%)",
          padding: "32px",
        }}
      >
        <input
          ref={libraryImportFileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleLibraryImportGraph}
          style={{ display: "none" }}
        />
        <div
          style={{
            maxWidth: "1080px",
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: "32px" }}>Tes graphes</h1>
              <p style={{ margin: "8px 0 0", fontSize: "14px", color: "#475569" }}>
                Choisis un graphe existant ou cree-en un nouveau avant d'ouvrir le studio.
              </p>
            </div>
            <div
              style={{
                backgroundColor: "rgba(255,255,255,0.9)",
                border: "1px solid #dbeafe",
                borderRadius: "14px",
                padding: "14px 16px",
                minWidth: "260px",
                boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
              }}
            >
              <div style={{ fontSize: "12px", color: "#64748b" }}>Connecte en tant que</div>
              <div style={{ fontSize: "16px", fontWeight: 700, marginTop: "4px" }}>
                {currentUser?.display_name || currentUser?.id || "Utilisateur"}
              </div>
              <div style={{ fontSize: "12px", color: "#475569", marginTop: "2px" }}>
                {currentUser?.id ?? "-"}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                style={{
                  marginTop: "12px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  backgroundColor: "#fff",
                  cursor: "pointer",
                }}
              >
                Se deconnecter
              </button>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={handleCreateGraph}
              disabled={creatingGraph || isLibraryImporting}
              style={{
                padding: "12px 14px",
                borderRadius: "12px",
                border: "none",
                backgroundColor: creatingGraph ? "#93c5fd" : "#2563eb",
                color: "#fff",
                fontWeight: 600,
                cursor: creatingGraph || isLibraryImporting ? "not-allowed" : "pointer",
              }}
            >
              {creatingGraph ? "Creation..." : "Creer un nouveau graphe"}
            </button>
            <button
              type="button"
              onClick={/* Open the JSON file picker for importing a new graph into the library. */ () => libraryImportFileInputRef.current?.click()}
              disabled={isLibraryImporting || creatingGraph}
              style={{
                padding: "12px 14px",
                borderRadius: "12px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#fff",
                fontWeight: 600,
                cursor: isLibraryImporting || creatingGraph ? "not-allowed" : "pointer",
              }}
            >
              {isLibraryImporting ? "Import en cours..." : "Importer un graphe"}
            </button>
          </div>

          {authError && (
            <p style={{ margin: 0, fontSize: "13px", color: "#b91c1c" }}>{authError}</p>
          )}
          {graphActionMessage && (
            <p style={{ margin: 0, fontSize: "13px", color: "#047857" }}>
              {graphActionMessage}
            </p>
          )}
          {graphActionError && (
            <p style={{ margin: 0, fontSize: "13px", color: "#b91c1c" }}>
              {graphActionError}
            </p>
          )}

          {graphs.length === 0 ? (
            <div
              style={{
                backgroundColor: "rgba(255,255,255,0.92)",
                border: "1px dashed #cbd5e1",
                borderRadius: "16px",
                padding: "28px",
                color: "#475569",
                textAlign: "center",
              }}
            >
              Aucun graphe disponible pour ce compte.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "16px",
              }}
            >
              {graphs.map(/* Render an accessible graph as a selectable library card. */ (graphItem) => (
                <button
                  key={graphItem.id}
                  type="button"
                  onClick={/* Open the graph represented by this library card. */ () => setSelectedGraphId(graphItem.id)}
                  style={{
                    textAlign: "left",
                    padding: "18px",
                    borderRadius: "18px",
                    border: "1px solid #dbeafe",
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(239,246,255,0.96) 100%)",
                    boxShadow: "0 14px 34px rgba(15, 23, 42, 0.08)",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "12px",
                      alignItems: "flex-start",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "18px", fontWeight: 700 }}>
                        {graphItem.name}
                      </div>
                      <div style={{ fontSize: "12px", color: "#475569", marginTop: "6px" }}>
                        {graphItem.description || "Sans description"}
                      </div>
                    </div>
                    <span
                      style={{
                        padding: "4px 8px",
                        borderRadius: "999px",
                        backgroundColor: "#dbeafe",
                        color: "#1d4ed8",
                        fontSize: "11px",
                        fontWeight: 700,
                        textTransform: "uppercase",
                      }}
                    >
                      {graphItem.role}
                    </span>
                  </div>
                  <div style={{ fontSize: "11px", color: "#64748b", marginTop: "14px" }}>
                    Cree par {graphItem.created_by}
                  </div>
                  <div
                    style={{
                      marginTop: "18px",
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "#2563eb",
                    }}
                  >
                    Ouvrir le graphe
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui" }}>
      <div
        style={{
          width: "340px",
          padding: "16px",
          borderRight: "1px solid #e5e7eb",
          overflowY: "auto",
        }}
      >
        <h1 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "8px" }}>
          OSINT Graph PoC
        </h1>
        <p style={{ fontSize: "12px", color: "#6b7280", marginBottom: "16px" }}>
          Ajoute des personnes, des liens, puis clique un noeud pour modifier ses infos.
        </p>
        {authError && (
          <p style={{ fontSize: "12px", color: "#b91c1c", marginBottom: "16px" }}>
            {authError}
          </p>
        )}

        <section style={{ marginBottom: "16px" }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
          >
            <h2 style={{ fontSize: "14px", fontWeight: "600", margin: 0 }}>
              Session
            </h2>
            <button
              type="button"
              onClick={/* Toggle the session information section. */ () => setIsAccessOpen(/* Invert the previous session-panel visibility. */ (prev) => !prev)}
              style={{
                padding: "4px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {isAccessOpen ? "Masquer" : "Afficher"}
            </button>
          </div>

          {isAccessOpen && (
            <>
              <div
                style={{
                  border: "1px solid #d1d5db",
                  backgroundColor: "#f8fafc",
                  borderRadius: "8px",
                  padding: "10px",
                  marginBottom: "10px",
                }}
              >
                <div style={{ fontSize: "12px", fontWeight: 600 }}>
                  {currentUser?.display_name || currentUser?.id || "Utilisateur"}
                </div>
                <div style={{ fontSize: "11px", color: "#475569", marginTop: "4px" }}>
                  ID: {currentUser?.id ?? "-"}
                </div>
                <div style={{ fontSize: "11px", color: "#475569", marginTop: "2px" }}>
                  Graphe: {currentGraph?.name || "-"}
                </div>
                <div style={{ fontSize: "11px", color: "#475569", marginTop: "2px" }}>
                  Role: {currentGraphRole || "aucun"}
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={/* Leave the graph editor and return to the graph library. */ () => setSelectedGraphId("")}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "1px solid #d1d5db",
                    backgroundColor: "#fff",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  Liste des graphes
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "1px solid #d1d5db",
                    backgroundColor: "#fff",
                    fontSize: "12px",
                    cursor: "pointer",
                  }}
                >
                  Se deconnecter
                </button>
              </div>
            </>
          )}
        </section>

        {canAdminGraph && (
          <section style={{ marginBottom: "16px" }}>
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
            >
              <h2 style={{ fontSize: "14px", fontWeight: "600", margin: 0 }}>
                Administration
              </h2>
              <button
                type="button"
                onClick={/* Toggle the graph administration section. */ () => setIsAdministrationOpen(/* Invert the previous administration-panel visibility. */ (prev) => !prev)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  backgroundColor: "#fff",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {isAdministrationOpen ? "Masquer" : "Afficher"}
              </button>
            </div>

            {isAdministrationOpen && (
              <>
                <form
                  onSubmit={handleGrantPermission}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    padding: "10px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    backgroundColor: "#fafafa",
                    marginBottom: "12px",
                  }}
                >
                  <label style={{ fontSize: "12px" }}>Utilisateur</label>
                  <input
                    type="text"
                    value={permissionUserId}
                    onChange={/* Update the account identifier in the graph-permission form. */ (e) => setPermissionUserId(e.target.value)}
                    placeholder="ID utilisateur"
                    style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                  />

                  <label style={{ fontSize: "12px" }}>Nom affiche</label>
                  <input
                    type="text"
                    value={permissionDisplayName}
                    onChange={/* Update the display name used when granting graph access. */ (e) => setPermissionDisplayName(e.target.value)}
                    placeholder="Optionnel"
                    style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                  />

                  <label style={{ fontSize: "12px" }}>
                    Mot de passe (uniquement si nouvel utilisateur)
                  </label>
                  <input
                    type="password"
                    value={permissionPassword}
                    onChange={/* Update the initial password used for a newly granted account. */ (e) => setPermissionPassword(e.target.value)}
                    placeholder="Optionnel"
                    style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                  />

                  <label style={{ fontSize: "12px" }}>Role</label>
                  <select
                    value={permissionRole}
                    onChange={/* Choose the graph role to assign to the account. */ (e) => setPermissionRole(e.target.value)}
                    style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                  >
                    <option value="viewer">Visualisation</option>
                    <option value="editor">Modification</option>
                    <option value="admin">Administration</option>
                  </select>

                  <button
                    type="submit"
                    disabled={permissionSubmitting}
                    style={{
                      padding: "6px 8px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: permissionSubmitting ? "#86efac" : "#16a34a",
                      color: "#fff",
                      fontSize: "13px",
                      cursor: permissionSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {permissionSubmitting ? "Enregistrement..." : "Ajouter / mettre a jour"}
                  </button>
                </form>

                {permissionMessage && (
                  <p style={{ fontSize: "12px", color: "#047857", marginTop: 0 }}>
                    {permissionMessage}
                  </p>
                )}
                {permissionError && (
                  <p style={{ fontSize: "12px", color: "#b91c1c", marginTop: 0 }}>
                    {permissionError}
                  </p>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {graphPermissions.map(/* Render a graph member's identity and permission controls. */ (permission) => (
                    <div
                      key={permission.user_id}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        padding: "10px",
                        backgroundColor: "#fff",
                      }}
                    >
                      <div style={{ fontSize: "12px", fontWeight: 600 }}>
                        {permission.display_name || permission.user_id}
                      </div>
                      <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "8px" }}>
                        {permission.user_id}
                      </div>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <select
                          value={permission.role}
                          onChange={/* Apply the graph role selected for this account. */ (e) =>
                            handlePermissionRoleChange(permission.user_id, e.target.value)
                          }
                          style={{
                            flex: 1,
                            padding: "6px 8px",
                            borderRadius: "4px",
                            border: "1px solid #d1d5db",
                          }}
                        >
                          <option value="viewer">Visualisation</option>
                          <option value="editor">Modification</option>
                          <option value="admin">Administration</option>
                        </select>
                        <button
                          type="button"
                          onClick={/* Start removal of this account's graph access. */ () => handleDeletePermission(permission.user_id)}
                          style={{
                            padding: "6px 8px",
                            borderRadius: "4px",
                            border: "none",
                            backgroundColor: "#dc2626",
                            color: "#fff",
                            fontSize: "12px",
                            cursor: "pointer",
                          }}
                        >
                          Retirer
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <section style={{ marginBottom: "16px" }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
          >
            <h2 style={{ fontSize: "14px", fontWeight: "600", margin: 0 }}>
              Filtre relationnel
            </h2>
            <button
              type="button"
              onClick={/* Toggle the relationship-filter section. */ () => setIsFilterOpen(/* Invert the previous filter-panel visibility. */ (prev) => !prev)}
              style={{
                padding: "4px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {isFilterOpen ? "Masquer" : "Afficher"}
            </button>
          </div>

          {isFilterOpen && (
            <>
              <label style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                Noeud de depart
              </label>
              <input
                type="text"
                list="persons-options"
                value={filterNodeSearch}
                onChange={/* Resolve the person label entered in the graph filter. */ (e) => handleFilterNodeInputChange(e.target.value)}
                placeholder="Rechercher et selectionner un noeud..."
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  marginBottom: "8px",
                }}
              />

              <button
                type="button"
                onClick={/* Use the currently selected person as the graph filter seed. */ () => setFilterNodeFromId(selectedPersonId)}
                disabled={!selectedPersonId}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  backgroundColor: selectedPersonId ? "#f9fafb" : "#f3f4f6",
                  fontSize: "12px",
                  cursor: selectedPersonId ? "pointer" : "not-allowed",
                  marginBottom: "8px",
                }}
              >
                Utiliser le noeud ouvert dans l'encart
              </button>

              <label style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                Type de lien
              </label>
              <select
                value={filterRelationType}
                onChange={/* Update the relationship type used by graph filtering. */ (e) => setFilterRelationType(e.target.value)}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  marginBottom: "8px",
                }}
              >
                <option value={REL_FILTER_ALL}>Tous les liens</option>
                {relationTypes.map(/* Render a relationship-type filter option. */ (relationType) => (
                  <option key={relationType} value={relationType}>
                    {relationType}
                  </option>
                ))}
              </select>

              {filterRelationType === SAME_COMPANY_RELATION_TYPE && (
                <>
                  <label style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                    Entreprise
                  </label>
                  <select
                    value={filterCompany}
                    onChange={/* Update the company used by the same-company relationship filter. */ (e) => setFilterCompany(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: "4px",
                      border: "1px solid #d1d5db",
                      marginBottom: "8px",
                    }}
                  >
                    <option value="">Toutes les entreprises</option>
                    {allCompanyOptions.map(/* Render a company filter option. */ (company) => (
                      <option key={company} value={company}>
                        {company}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <label style={{ fontSize: "12px", display: "block", marginBottom: "6px" }}>
                Profondeur (poignees de main)
              </label>
              <input
                type="number"
                min="0"
                max="10"
                value={filterHops}
                disabled={!isDepthFilterEnabled}
                onChange={(e) => {
                  // Parse the requested traversal depth and limit it to zero through ten hops.
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  const clamped = Math.min(10, Math.max(0, parsed));
                  setFilterHops(clamped);
                }}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  marginBottom: "8px",
                  backgroundColor: isDepthFilterEnabled ? "#fff" : "#f9fafb",
                }}
              />

              <button
                type="button"
                onClick={resetGraphFilter}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  backgroundColor: "#f9fafb",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Reinitialiser le filtre
              </button>
            </>
          )}
        </section>

        <section style={{ marginBottom: "24px" }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
          >
            <h2 style={{ fontSize: "14px", fontWeight: "600", margin: 0 }}>
              Nouvelle personne
            </h2>
            <button
              type="button"
              onClick={/* Toggle the person creation form. */ () => setIsCreatePersonOpen(/* Invert the previous person-creation form visibility. */ (prev) => !prev)}
              style={{
                padding: "4px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {isCreatePersonOpen ? "Masquer" : "Afficher"}
            </button>
          </div>
          {isCreatePersonOpen && (
            canEditGraph ? (
              <form
                onSubmit={handleCreatePerson}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <label style={{ fontSize: "12px" }}>
                  Alias (optionnel si nom + prenom renseignes)
                </label>
                <input
                  type="text"
                  placeholder="Alias"
                  value={personAlias}
                  onChange={/* Update the new person's alias. */ (e) => setPersonAlias(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Nom (optionnel)</label>
                <input
                  type="text"
                  placeholder="Nom"
                  value={personNom}
                  onChange={/* Update the new person's surname. */ (e) => setPersonNom(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Prenom (optionnel)</label>
                <input
                  type="text"
                  placeholder="Prenom"
                  value={personPrenom}
                  onChange={/* Update the new person's first name. */ (e) => setPersonPrenom(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Date de naissance (optionnel)</label>
                <input
                  type="date"
                  value={personDateNaissance}
                  onChange={/* Update the new person's birth date. */ (e) => setPersonDateNaissance(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Date de mort (optionnel)</label>
                <input
                  type="date"
                  value={personDateMort}
                  onChange={/* Update the new person's death date. */ (e) => setPersonDateMort(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Entreprise (optionnel)</label>
                <input
                  type="text"
                  list="companies-list"
                  placeholder="Selectionner ou saisir une entreprise"
                  value={personEntreprise}
                  onChange={/* Update the new person's company. */ (e) => setPersonEntreprise(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Description / notes (optionnel)</label>
                <textarea
                  rows={3}
                  placeholder="Notes sur la personne"
                  value={personDescription}
                  onChange={/* Update the new person's notes. */ (e) => setPersonDescription(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db", fontSize: "12px" }}
                />

                <button
                  type="submit"
                  style={{
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "none",
                    backgroundColor: "#4f46e5",
                    color: "#fff",
                    fontSize: "13px",
                    cursor: "pointer",
                  }}
                >
                  Creer
                </button>
              </form>
            ) : (
              <p style={{ fontSize: "12px", color: "#6b7280", margin: 0 }}>
                Role requis: modification ou administration.
              </p>
            )
          )}
          <datalist id="companies-list">
            {companies.map(/* Render a company suggestion for person forms. */ (company) => (
              <option key={company} value={company} />
            ))}
          </datalist>
          <datalist id="persons-options">
            {sortedPersons.map(/* Render a person-label suggestion for filters and relationship endpoints. */ (person) => (
              <option key={`person-option-${person.id}`} value={person.label} />
            ))}
          </datalist>
        </section>

        <section style={{ marginBottom: "24px" }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
          >
            <h2 style={{ fontSize: "14px", fontWeight: "600", margin: 0 }}>
              Nouveau lien
            </h2>
            <button
              type="button"
              onClick={/* Toggle the relationship creation form. */ () => setIsCreateRelationOpen(/* Invert the previous relationship-creation form visibility. */ (prev) => !prev)}
              style={{
                padding: "4px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              {isCreateRelationOpen ? "Masquer" : "Afficher"}
            </button>
          </div>
          {isCreateRelationOpen && (
            canEditGraph ? (
              <form
                onSubmit={handleCreateRelation}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <label style={{ fontSize: "12px" }}>Depuis :</label>
                <input
                  type="text"
                  list="persons-options"
                  value={relFromSearch}
                  onChange={/* Resolve the source person entered in the relationship form. */ (e) => handleRelFromInputChange(e.target.value)}
                  placeholder="Saisir / selectionner une personne..."
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Vers :</label>
                <input
                  type="text"
                  list="persons-options"
                  value={relToSearch}
                  onChange={/* Resolve the target person entered in the relationship form. */ (e) => handleRelToInputChange(e.target.value)}
                  placeholder="Saisir / selectionner une personne..."
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Type de lien :</label>
                <input
                  type="text"
                  value={relLabel}
                  onChange={/* Update the relationship label to create. */ (e) => setRelLabel(e.target.value)}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <button
                  type="submit"
                  style={{
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "none",
                    backgroundColor: "#10b981",
                    color: "#fff",
                    fontSize: "13px",
                    cursor: "pointer",
                  }}
                >
                  Creer le lien
                </button>
              </form>
            ) : (
              <p style={{ fontSize: "12px", color: "#6b7280", margin: 0 }}>
                Role requis: modification ou administration.
              </p>
            )
          )}
        </section>

        <section>
          <input
            ref={importFileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImportGraph}
            style={{ display: "none" }}
          />
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleExportGraph}
              disabled={isExporting || isImporting || !selectedGraphId}
              style={{
                padding: "6px 8px",
                borderRadius: "4px",
                border: "1px solid #d1d5db",
                backgroundColor: isExporting ? "#e5e7eb" : "#f9fafb",
                fontSize: "13px",
                cursor: isExporting || isImporting ? "not-allowed" : "pointer",
              }}
            >
              {isExporting ? "Export..." : "Exporter JSON"}
            </button>
            {canEditGraph && (
              <button
                type="button"
                onClick={/* Open the JSON file picker for importing into the current graph. */ () => importFileInputRef.current?.click()}
                disabled={isImporting || isExporting || !selectedGraphId}
                style={{
                  padding: "6px 8px",
                  borderRadius: "4px",
                  border: "1px solid #d1d5db",
                  backgroundColor: isImporting ? "#e5e7eb" : "#f9fafb",
                  fontSize: "13px",
                  cursor: isImporting || isExporting ? "not-allowed" : "pointer",
                }}
              >
                {isImporting ? "Import..." : "Importer JSON"}
              </button>
            )}
          </div>
          {transferMessage && (
            <p style={{ fontSize: "12px", color: "#047857", marginTop: "8px", marginBottom: 0 }}>
              {transferMessage}
            </p>
          )}
          {transferError && (
            <p style={{ fontSize: "12px", color: "#b91c1c", marginTop: "8px", marginBottom: 0 }}>
              {transferError}
            </p>
          )}
        </section>
      </div>

      <div
        id="graph-wrapper"
        style={{
          flex: 1,
          position: "relative",
          backgroundColor: "#f3f4f6",
        }}
      >
        <div
          id="graph-container"
          ref={containerRef}
          onPointerDown={handleGraphPointerDown}
          onPointerMove={handleGraphPointerMove}
          onPointerUp={handleGraphPointerUp}
          onPointerCancel={handleGraphPointerCancel}
          onContextMenu={handleGraphContextMenu}
          style={{
            width: "100%",
            height: "100%",
            cursor: isBoxZoomMode ? "crosshair" : "grab",
            userSelect: "none",
          }}
        ></div>

        <div
          style={{
            position: "absolute",
            left: "12px",
            top: "12px",
            zIndex: 4,
            display: "flex",
            gap: "8px",
            padding: "6px",
            borderRadius: "8px",
            border: "1px solid #d1d5db",
            backgroundColor: "rgba(255,255,255,0.92)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
          }}
        >
          <button
            type="button"
            onClick={fetchGraph}
            disabled={!selectedGraphId}
            style={{
              padding: "6px 8px",
              borderRadius: "4px",
              border: "1px solid #d1d5db",
              backgroundColor: "#f9fafb",
              fontSize: "13px",
              cursor: selectedGraphId ? "pointer" : "not-allowed",
            }}
          >
            Rafraichir
          </button>
          <button
            type="button"
            onClick={fitGraph}
            disabled={!selectedGraphId}
            style={{
              padding: "6px 8px",
              borderRadius: "4px",
              border: "1px solid #d1d5db",
              backgroundColor: "#f9fafb",
              fontSize: "13px",
              cursor: selectedGraphId ? "pointer" : "not-allowed",
            }}
          >
            Recentrer
          </button>
          <button
            type="button"
            onClick={() => {
              // Toggle box-zoom mode and discard any unfinished zoom selection.
              setIsBoxZoomMode(/* Invert the previous box-zoom mode. */ (prev) => !prev);
              clearBoxZoom();
            }}
            disabled={!selectedGraphId}
            style={{
              padding: "6px 8px",
              borderRadius: "4px",
              border: "1px solid #d1d5db",
              backgroundColor: isBoxZoomMode ? "#dbeafe" : "#f9fafb",
              fontSize: "13px",
              cursor: selectedGraphId ? "pointer" : "not-allowed",
            }}
          >
            Zoom par cadre {isBoxZoomMode ? "ON" : "OFF"}
          </button>
          {currentGraph && (
            <div
              style={{
                alignSelf: "center",
                fontSize: "12px",
                color: "#475569",
                paddingLeft: "4px",
              }}
            >
              {currentGraph.name}
            </div>
          )}
        </div>

        {isBoxZoomMode && (
          <div
            style={{
              position: "absolute",
              left: "12px",
              top: "58px",
              backgroundColor: "rgba(17,24,39,0.82)",
              color: "#f9fafb",
              fontSize: "11px",
              padding: "6px 8px",
              borderRadius: "6px",
              pointerEvents: "none",
            }}
          >
            Clic gauche: zoomer. Clic droit: dezoomer. Fleches: deplacer.
          </div>
        )}

        {boxZoomRect && (
          <div
            style={{
              position: "absolute",
              left: `${boxZoomRect.left}px`,
              top: `${boxZoomRect.top}px`,
              width: `${boxZoomRect.width}px`,
              height: `${boxZoomRect.height}px`,
              border:
                boxZoomRect.mode === "out"
                  ? "1px dashed #f59e0b"
                  : "1px dashed #2563eb",
              backgroundColor:
                boxZoomRect.mode === "out"
                  ? "rgba(245,158,11,0.14)"
                  : "rgba(37,99,235,0.14)",
              pointerEvents: "none",
            }}
          />
        )}

        <div
          onPointerDown={handleMiniMapPointerDown}
          style={{
            position: "absolute",
            left: "12px",
            bottom: "12px",
            zIndex: 3,
            pointerEvents: "auto",
            touchAction: "none",
            display: "block",
            width: `${MINIMAP_WIDTH}px`,
            height: `${MINIMAP_HEIGHT}px`,
            border: "1px solid rgba(255,255,255,0.45)",
            backgroundColor: "#111827",
            borderRadius: "8px",
            overflow: "hidden",
            boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
            cursor: "pointer",
          }}
          title="Mini-carte: clique pour recentrer le graphe"
        >
          <canvas
            ref={miniMapCanvasRef}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
          <div
            ref={miniMapViewportRef}
            style={{
              display: "none",
              position: "absolute",
              border: "2px solid #22c55e",
              backgroundColor: "rgba(34,197,94,0.14)",
              pointerEvents: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {selectedPersonId && (
          <aside
            style={{
              position: "absolute",
              top: "16px",
              right: "16px",
              width: "360px",
              maxHeight: "calc(100% - 32px)",
              overflowY: "auto",
              backgroundColor: "#ffffff",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              padding: "12px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            }}
          >
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}
            >
              <h3 style={{ margin: 0, fontSize: "15px" }}>Details de la personne</h3>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={/* Toggle the selected person's detail form. */ () => setIsDetailsFormOpen(/* Invert the previous detail-form visibility. */ (prev) => !prev)}
                  style={{
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    padding: "3px 6px",
                  }}
                >
                  {isDetailsFormOpen ? "Masquer" : "Afficher"}
                </button>
                <button
                  type="button"
                  onClick={closeDetailsPanel}
                  style={{
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    padding: "3px 6px",
                  }}
                >
                  Fermer
                </button>
              </div>
            </div>

            {detailsLoading && <p style={{ fontSize: "12px" }}>Chargement...</p>}
            {!detailsLoading && detailsError && (
              <p style={{ fontSize: "12px", color: "#b91c1c" }}>{detailsError}</p>
            )}

            {!detailsLoading && !detailsError && selectedPerson && isDetailsFormOpen && (
              <form
                onSubmit={handleUpdatePerson}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <label style={{ fontSize: "12px" }}>
                  Alias (optionnel si nom + prenom renseignes)
                </label>
                <input
                  type="text"
                  value={editAlias}
                  onChange={/* Update the selected person's alias in the editing form. */ (e) => setEditAlias(e.target.value)}
                  readOnly={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Nom</label>
                <input
                  type="text"
                  value={editNom}
                  onChange={/* Update the selected person's surname in the editing form. */ (e) => setEditNom(e.target.value)}
                  readOnly={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Prenom</label>
                <input
                  type="text"
                  value={editPrenom}
                  onChange={/* Update the selected person's first name in the editing form. */ (e) => setEditPrenom(e.target.value)}
                  readOnly={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Date de naissance</label>
                <input
                  type="date"
                  value={editDateNaissance}
                  onChange={/* Update the selected person's birth date in the editing form. */ (e) => setEditDateNaissance(e.target.value)}
                  disabled={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Date de mort</label>
                <input
                  type="date"
                  value={editDateMort}
                  onChange={/* Update the selected person's death date in the editing form. */ (e) => setEditDateMort(e.target.value)}
                  disabled={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Age calcule</label>
                <input
                  type="text"
                  value={selectedPerson.age ?? "-"}
                  readOnly
                  style={{
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "1px solid #d1d5db",
                    backgroundColor: "#f9fafb",
                  }}
                />

                <label style={{ fontSize: "12px" }}>Entreprise</label>
                <input
                  type="text"
                  list="companies-list"
                  placeholder="Selectionner ou saisir une entreprise"
                  value={editEntreprise}
                  onChange={/* Update the selected person's company in the editing form. */ (e) => setEditEntreprise(e.target.value)}
                  readOnly={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db" }}
                />

                <label style={{ fontSize: "12px" }}>Description / notes</label>
                <textarea
                  rows={4}
                  value={editDescription}
                  onChange={/* Update the selected person's notes in the editing form. */ (e) => setEditDescription(e.target.value)}
                  readOnly={!canEditGraph}
                  style={{ padding: "6px 8px", borderRadius: "4px", border: "1px solid #d1d5db", fontSize: "12px" }}
                />

                {detailsMessage && (
                  <p style={{ fontSize: "12px", color: "#047857", margin: 0 }}>
                    {detailsMessage}
                  </p>
                )}

                {canEditGraph ? (
                  <>
                    <button
                      type="submit"
                      style={{
                        marginTop: "4px",
                        padding: "7px 8px",
                        borderRadius: "4px",
                        border: "none",
                        backgroundColor: "#2563eb",
                        color: "#fff",
                        fontSize: "13px",
                        cursor: "pointer",
                      }}
                    >
                      Enregistrer
                    </button>
                    <button
                      type="button"
                      onClick={handleDeletePerson}
                      disabled={detailsDeleting}
                      style={{
                        padding: "7px 8px",
                        borderRadius: "4px",
                        border: "none",
                        backgroundColor: detailsDeleting ? "#9ca3af" : "#dc2626",
                        color: "#fff",
                        fontSize: "13px",
                        cursor: detailsDeleting ? "not-allowed" : "pointer",
                      }}
                    >
                      {detailsDeleting ? "Suppression..." : "Supprimer"}
                    </button>
                  </>
                ) : (
                  <p style={{ fontSize: "12px", color: "#6b7280", margin: 0 }}>
                    Consultation seule.
                  </p>
                )}
              </form>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;
