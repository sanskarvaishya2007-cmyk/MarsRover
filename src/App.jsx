import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { 
  Terminal, Cpu, Battery, BatteryCharging, 
  Send, RotateCcw, AlertTriangle, Eye, Activity, Zap, Flame, Award, CheckCircle2
} from 'lucide-react';

// Generates high-fidelity procedural texture for Mars Surface (2048x2048)
function generateMarsTerrainTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 2048;
  const ctx = canvas.getContext('2d');

  // Matte dull-orange to charcoal gradient background
  const grad = ctx.createLinearGradient(0, 0, 2048, 2048);
  grad.addColorStop(0, '#5A2A18');
  grad.addColorStop(0.4, '#3D1C10');
  grad.addColorStop(0.8, '#26120B');
  grad.addColorStop(1, '#180B07');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2048, 2048);

  // Surface dust speckles & regolith noise
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * 2048;
    const y = Math.random() * 2048;
    const r = Math.random() * 22 + 2;
    ctx.fillStyle = Math.random() > 0.4 ? 'rgba(12, 12, 15, 0.45)' : 'rgba(194, 65, 12, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tactical subtle grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let y = 0; y < 2048; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(2048, y);
    ctx.stroke();
  }

  return new THREE.CanvasTexture(canvas);
}


// --- PROCEDURAL MARTIAN TERRAIN HEIGHT ---
function getTerrainHeight(x, z) {
  const wave1 = Math.sin(x * 0.04 + z * 0.03) * 1.8;
  const wave2 = Math.cos(x * 0.02 - z * 0.05) * 1.5;
  const rough = Math.sin(x * 0.15) * Math.cos(z * 0.12) * 0.45;

  // Crater around the main mission area
  const craterDist = Math.hypot(x + 15, z - 25);
  let crater = 0;
  if (craterDist < 12) {
    crater = -Math.cos((craterDist / 12) * Math.PI) * 2.5;
  }

  return wave1 + wave2 + rough + crater;
}

// --- GRID BASED A* PATHFINDING ---
function findAStarPath(start, goal, obstacles) {
  const gridSize = 2;
  const bounds = 150;

  const toGrid = (v) => Math.round((v + bounds) / gridSize);
  const toWorld = (v) => v * gridSize - bounds;
  const key = (n) => `${n.x},${n.z}`;
  const heuristic = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  const startNode = { x: toGrid(start.x), z: toGrid(start.z) };
  const goalNode = { x: toGrid(goal.x), z: toGrid(goal.z) };

  const isBlocked = (node) => {
    const wx = toWorld(node.x);
    const wz = toWorld(node.z);

    return obstacles.some((obs) => {
      const clearance = obs.type === 'sandtrap' ? 1.5 : 2.0;
      return Math.hypot(wx - obs.x, wz - obs.z) < obs.radius + clearance;
    });
  };

  const open = [startNode];
  const cameFrom = { [key(startNode)]: null };
  const costSoFar = { [key(startNode)]: 0 };

  const directions = [
    { x: 1, z: 0 }, { x: -1, z: 0 },
    { x: 0, z: 1 }, { x: 0, z: -1 },
    { x: 1, z: 1 }, { x: -1, z: 1 },
    { x: 1, z: -1 }, { x: -1, z: -1 }
  ];

  let iterations = 0;
  const maxIterations = 12000;

  while (open.length && iterations++ < maxIterations) {
    open.sort((a, b) => {
      const fa = costSoFar[key(a)] + heuristic(a, goalNode);
      const fb = costSoFar[key(b)] + heuristic(b, goalNode);
      return fa - fb;
    });

    const current = open.shift();

    if (key(current) === key(goalNode)) {
      const path = [];
      let node = current;

      while (node) {
        path.push({ x: toWorld(node.x), z: toWorld(node.z) });
        node = cameFrom[key(node)];
      }

      const finalPath = path.reverse();

      // Preserve the exact user-entered waypoint instead of the grid-rounded node.
      const last = finalPath[finalPath.length - 1];
      if (
        !last ||
        Math.hypot(last.x - goal.x, last.z - goal.z) > 0.01
      ) {
        finalPath.push({ x: goal.x, z: goal.z });
      }

      return finalPath;
    }

    for (const dir of directions) {
      const next = { x: current.x + dir.x, z: current.z + dir.z };

      if (
        next.x < 0 ||
        next.z < 0 ||
        next.x > Math.round((bounds * 2) / gridSize) ||
        next.z > Math.round((bounds * 2) / gridSize) ||
        isBlocked(next)
      ) continue;

      const newCost = costSoFar[key(current)] + Math.hypot(dir.x, dir.z);

      if (costSoFar[key(next)] === undefined || newCost < costSoFar[key(next)]) {
        costSoFar[key(next)] = newCost;
        cameFrom[key(next)] = current;

        if (!open.some((n) => key(n) === key(next))) {
          open.push(next);
        }
      }
    }
  }

  return [];
}

// -----------------------------------------------------------------------------
// MARS ATMOSPHERE + 3-DOF ENTRY, DESCENT & LANDING MODEL
// Coordinates: X / Y / Z where Y is altitude. The rover ground simulator
// continues to use X / Z as its 2-D map plane after touchdown.
// -----------------------------------------------------------------------------
const MARS_RADIUS_M = 3_390_000;
const MARS_G0 = 3.71;
const MARS_RHO0 = 0.020;          // kg/m^3 near datum
const MARS_SCALE_HEIGHT_M = 11_100;
const MARS_TEMPERATURE_K = 210;
const MARS_R_SPECIFIC = 188.92;

function getMarsAtmosphere(altitudeM) {
  const h = Math.max(0, altitudeM);
  const density = MARS_RHO0 * Math.exp(-h / MARS_SCALE_HEIGHT_M);
  const pressure = density * MARS_R_SPECIFIC * MARS_TEMPERATURE_K;
  const gravity =
    MARS_G0 * Math.pow(MARS_RADIUS_M / (MARS_RADIUS_M + h), 2);

  return { density, pressure, gravity };
}

function createInitialEDLState() {
  return {
    phase: 'AERO-BRAKING',
    altitude: 16_000,
    x: 0,
    z: 0,
    vx: 20,
    vy: -450,
    vz: 10,
    fuel: 1200,
    heatFlux: 0,
    maxHeatFlux: 0,
    gForce: 0,
    maxGForce: 0,
    time: 0,
    phaseElapsed: 0,
    parachuteDeployed: false,
    rocketsIgnited: false,
    touchdownSpeed: 0,
    touchdownAccuracy: 0,
    touchdownG: 0,
    landingVerified: false
  };
}

function stepEDL(state, dt) {
  if (state.phase === 'LANDED') return { phaseChanged: false };

  const oldPhase = state.phase;

  // Dynamic atmosphere: density -> pressure, gravity, aerodynamic forces.
  const atm = getMarsAtmosphere(state.altitude);
  const speed = Math.max(
    0.001,
    Math.hypot(state.vx, state.vy, state.vz)
  );

  // Autonomous event logic: both altitude and pressure thresholds are used.
  if (
    state.phase === 'AERO-BRAKING' &&
    state.altitude <= 11_000 &&
    atm.pressure >= 280
  ) {
    state.phase = 'PARACHUTE';
    state.parachuteDeployed = true;
    state.phaseElapsed = 0;
  }

  if (
    state.phase === 'PARACHUTE' &&
    state.altitude <= 2_500 &&
    atm.pressure >= 450 &&
    speed <= 260
  ) {
    state.phase = 'POWERED DESCENT';
    state.rocketsIgnited = true;
    state.phaseElapsed = 0;
  }

  let referenceArea = 10;
  let dragCoefficient = 1.1;
  let liftCoefficient = 0.25;

  if (state.phase === 'PARACHUTE') {
    referenceArea = 38;
    dragCoefficient = 1.5;
    liftCoefficient = 0.08;
  }

  if (state.phase === 'POWERED DESCENT') {
    referenceArea = 6;
    dragCoefficient = 0.8;
    liftCoefficient = 0;
  }

  const massKg = 2200;

  const velocity = new THREE.Vector3(state.vx, state.vy, state.vz);
  const velocityHat = velocity.clone().normalize();

  // Aerodynamic drag.
  const dragAccel =
    (0.5 *
      atm.density *
      speed *
      speed *
      dragCoefficient *
      referenceArea) /
    massKg;

  const drag = velocityHat.clone().multiplyScalar(-dragAccel);

  // Lift is perpendicular to the velocity vector. During parachute descent,
  // the lift vector is also guided toward the landing target at (0,0).
  let lift = new THREE.Vector3();

  if (liftCoefficient > 0) {
    const guidanceX = THREE.MathUtils.clamp(
      -state.x * 0.025 - state.vx * 0.35,
      -3,
      3
    );
    const guidanceZ = THREE.MathUtils.clamp(
      -state.z * 0.025 - state.vz * 0.35,
      -3,
      3
    );

    const preferredLift = new THREE.Vector3(
      guidanceX,
      2.0,
      guidanceZ
    );

    preferredLift.sub(
      velocityHat.clone().multiplyScalar(preferredLift.dot(velocityHat))
    );

    if (preferredLift.lengthSq() > 1e-8) {
      preferredLift.normalize();
      const liftAccel =
        (0.5 *
          atm.density *
          speed *
          speed *
          liftCoefficient *
          referenceArea) /
        massKg;
      lift = preferredLift.multiplyScalar(liftAccel);
    }
  }

  // Powered descent: closed-loop throttle guidance for X/Y/Z.
  // Thrust is capped to keep peak acceleration under the 5G evaluation limit.
  let thrust = new THREE.Vector3();

  if (state.phase === 'POWERED DESCENT') {
    const desiredVerticalSpeed = -Math.max(
      2,
      Math.min(18, 2 + state.altitude * 0.006)
    );

    const verticalControl =
      (desiredVerticalSpeed - state.vy) * 1.5 + atm.gravity;

    const horizontalX = THREE.MathUtils.clamp(
      -state.x * 0.08 - state.vx * 0.9,
      -7,
      7
    );

    const horizontalZ = THREE.MathUtils.clamp(
      -state.z * 0.08 - state.vz * 0.9,
      -7,
      7
    );

    thrust.set(
      horizontalX,
      THREE.MathUtils.clamp(verticalControl, 0, 17),
      horizontalZ
    );

    const maxThrustAccel = 17;
    if (thrust.length() > maxThrustAccel) {
      thrust.setLength(maxThrustAccel);
    }

    // Demo-scale fuel flow keeps the chart readable while remaining
    // monotonic with throttle demand.
    const throttleFraction = thrust.length() / maxThrustAccel;
    state.fuel = Math.max(0, state.fuel - 0.65 * throttleFraction * dt);
  }

  // 3-DoF acceleration: aerodynamic forces + gravity + controlled thrust.
  const acceleration = new THREE.Vector3(
    drag.x + lift.x + thrust.x,
    drag.y + lift.y + thrust.y - atm.gravity,
    drag.z + lift.z + thrust.z
  );

  state.gForce = acceleration.length() / MARS_G0;
  state.maxGForce = Math.max(state.maxGForce, state.gForce);

  // Sutton-Graves-style proxy heat flux for a live EDL thermal graph.
  // Displayed in kW/m^2; it is driven by density and velocity cubed.
  state.heatFlux = Math.max(
    0,
    (0.5 * atm.density * Math.pow(speed, 3)) / 1000
  );
  state.maxHeatFlux = Math.max(state.maxHeatFlux, state.heatFlux);

  state.vx += acceleration.x * dt;
  state.vy += acceleration.y * dt;
  state.vz += acceleration.z * dt;

  state.x += state.vx * dt;
  state.altitude += state.vy * dt;
  state.z += state.vz * dt;
  state.time += dt;
  state.phaseElapsed += dt;

  // Touchdown event.
  if (state.altitude <= 0) {
    state.altitude = 0;

    const touchdownVelocity = Math.hypot(
      state.vx,
      state.vy,
      state.vz
    );

    state.touchdownSpeed = touchdownVelocity;
    state.touchdownAccuracy = Math.hypot(state.x, state.z);
    state.touchdownG = state.gForce;
    state.landingVerified =
      state.touchdownSpeed < 2.5 &&
      state.touchdownAccuracy < 50 &&
      state.touchdownG < 5;

    state.phase = 'LANDED';
    state.phaseElapsed = 0;

    // Stop the EDL vehicle at touchdown; the ground rover begins here.
    state.vx = 0;
    state.vy = 0;
    state.vz = 0;
  }

  return {
    phaseChanged: oldPhase !== state.phase,
    oldPhase,
    newPhase: state.phase,
    atmosphere: atm,
    speed,
    touchdown: state.phase === 'LANDED'
  };
}

// Compact SVG telemetry graph used without an additional charting dependency.
function TelemetryGraph({ title, unit, values, colorClass = 'text-blue-400', secondaryValues }) {
  const safeValues = values?.length ? values.slice(-90) : [0];
  const safeSecondary = secondaryValues?.length
    ? secondaryValues.slice(-90)
    : null;

  const allValues = safeSecondary
    ? [...safeValues, ...safeSecondary]
    : safeValues;

  let min = Math.min(...allValues);
  let max = Math.max(...allValues);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }

  if (Math.abs(max - min) < 1e-6) {
    min -= 1;
    max += 1;
  }

  const toPoints = (series) =>
    series
      .map((value, i) => {
        const x = (i / Math.max(1, series.length - 1)) * 100;
        const y = 94 - ((value - min) / (max - min)) * 82;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

  return (
    <div className="bg-[#18181b] border border-zinc-800 rounded-lg p-1.5 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-zinc-400 font-bold">{title}</span>
        <span className={`text-[9px] font-bold ${colorClass}`}>
          {safeValues[safeValues.length - 1]?.toFixed?.(1) ?? '0.0'} {unit}
        </span>
      </div>
      <svg viewBox="0 0 100 100" className="w-full h-12 overflow-visible">
        <line x1="0" y1="94" x2="100" y2="94" stroke="rgba(255,255,255,0.08)" />
        <line x1="0" y1="10" x2="100" y2="10" stroke="rgba(255,255,255,0.05)" />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          points={toPoints(safeValues)}
          className={colorClass}
        />
        {safeSecondary && (
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 2"
            points={toPoints(safeSecondary)}
            className="text-amber-500"
          />
        )}
      </svg>
    </div>
  );
}


export default function App() {
  const marsMountRef = useRef(null);
  const earthMountRef = useRef(null);

  // Simulation State
  const [commandInput, setCommandInput] = useState('WAYPOINT 45,60');
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [transmitTimer, setTransmitTimer] = useState(0);
  const [status, setStatus] = useState('IDLE'); // IDLE, TRANSMITTING, EXECUTING, REROUTING, CHARGING, STUCK, COMPLETED
  const [battery, setBattery] = useState(100);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [summaryMode, setSummaryMode] = useState('ROVER');
  const [edlTelemetry, setEdlTelemetry] = useState({
    phase: 'AERO-BRAKING',
    altitude: 16000,
    velocity: Math.hypot(20, -450, 10),
    density: getMarsAtmosphere(16000).density,
    pressure: getMarsAtmosphere(16000).pressure,
    fuel: 1200,
    heatFlux: 0,
    gForce: 0,
    maxGForce: 0,
    maxHeatFlux: 0,
    landingSpeed: 0,
    landingAccuracy: 0,
    landingG: 0,
    landingVerified: false,
    parachuteDeployed: false,
    rocketsIgnited: false
  });
  const [edlHistory, setEdlHistory] = useState([
    {
      t: 0,
      altitude: 16000,
      velocity: Math.hypot(20, -450, 10),
      fuel: 1200,
      heat: 0
    }
  ]);
  const [latencyMode, setLatencyMode] = useState('DEMO'); // DEMO = 2s, REAL = 20min
  const [solarExposure, setSolarExposure] = useState(100);
  const [lidarDistance, setLidarDistance] = useState(null);

  const [terminalLogs, setTerminalLogs] = useState([
    '[00:00:01] DSN LINK ESTABLISHED — PERSEVERANCE_TWIN_V6',
    '[00:00:02] EARTH VIEWPORT PALETTE REFINED TO BLUE THEME',
    '[00:00:03] WHITE ROVER CHASSIS & MATCHED 3D SOLID MODELS ACTIVE',
    '[00:00:04] DUAL 360° ORBIT CONTROLS INITIALIZED'
  ]);

  // Telemetry - Realtime (Mars View)
  const [marsTelemetry, setMarsTelemetry] = useState({
    posX: 0,
    posZ: 0,
    heading: 0,
    speed: 0,
    hazardDetected: false,
    obstaclesAvoided: 0,
    distanceTraveled: 0,
    wheelSlip: 0,
    inSoftPit: false
  });

  // Telemetry - Delayed Sync (Earth View)
  const [earthTelemetry, setEarthTelemetry] = useState({
    posX: 0,
    posZ: 0,
    heading: 0,
    battery: 100,
    status: 'IDLE',
    timestamp: '00:00:00',
    obstaclesAvoided: 0,
    distanceTraveled: 0
  });

  // Internal Physics & Pathfinding Engine Reference
  const simState = useRef({
    posX: 0,
    posZ: 0,
    posY: 0.5,
    heading: 0,
    targetX: 0,
    targetZ: 0,
    waypointQueue: [],
    speed: 0,
    battery: 100,
    status: 'EDL',
    obstaclesAvoided: 0,
    distanceTraveled: 0,
    stuck: false,
    reason: '',
    wheelSlip: 0,
    inSoftPit: false,
    detourSign: 1,
    path: [],
    pathIndex: 0,
    lidarDetected: false,
    solarExposure: 1
  });

  // Hazard Map with Boulders, Craters, and Soft-Pit Sand Traps
  const WAYPOINT_TOLERANCE = 0.8;
const WAYPOINT_NODE_TOLERANCE = 1.15;

const obstacles = useMemo(() => {
    const list = [
      { x: 10, z: 15, radius: 3.5, type: 'boulder', name: 'Alpha Rock Ridge' },
      { x: -15, z: 25, radius: 4.2, type: 'crater', name: 'Jezero Impact Basin' },
      { x: 22, z: 35, radius: 5.5, type: 'sandtrap', name: 'Soft Regolith Pit Alpha' },
      { x: 40, z: 50, radius: 3.8, type: 'boulder', name: 'Basalt Outcrop Major' },
      { x: -35, z: 45, radius: 6.5, type: 'sandtrap', name: 'Deep Dune Sinking Zone' },
      { x: 15, z: 70, radius: 4.0, type: 'crater', name: 'Secondary Crater' },
      { x: -50, z: 80, radius: 6.0, type: 'boulder', name: 'Monolith Cluster' }
    ];

    for (let i = 0; i < 75; i++) {
      const rx = (Math.random() - 0.5) * 260;
      const rz = (Math.random() - 0.5) * 260;
      if (Math.hypot(rx, rz) > 12) {
        const types = ['boulder', 'boulder', 'sandtrap', 'crater'];
        const chosenType = types[Math.floor(Math.random() * types.length)];
        const rad = chosenType === 'boulder' ? 1.8 + Math.random() * 2.5 : 3.0 + Math.random() * 3.5;
        list.push({
          x: rx,
          z: rz,
          radius: rad,
          type: chosenType,
          name: `Hazard #${i + 1} (${chosenType.toUpperCase()})`
        });
      }
    }
    return list;
  }, []);

  // 3D Scene & Camera Refs
  const marsRoverRef = useRef(null);
  const earthRoverRef = useRef(null);
  const lidarRaysRef = useRef([]);
  const wheelsRef = useRef([]);
  const rockerPartsRef = useRef([]);
  const lidarObjectsRef = useRef([]);
  const raycasterRef = useRef(new THREE.Raycaster());
  const edlStateRef = useRef(createInitialEDLState());
  const edlVisualRef = useRef(null);
  const marsControlsRef = useRef(null);
  const earthControlsRef = useRef(null);

  const addLog = (msg) => {
    const time = new Date().toISOString().substring(11, 19);
    setTerminalLogs((prev) => [...prev.slice(-14), `[${time}] ${msg}`]);
  };

  const handleReset = () => {
    simState.current = {
      posX: 0,
      posZ: 0,
      posY: 0.5,
      heading: 0,
      targetX: 0,
      targetZ: 0,
      waypointQueue: [],
      speed: 0,
      battery: 100,
      status: 'EDL',
      obstaclesAvoided: 0,
      distanceTraveled: 0,
      stuck: false,
      reason: '',
      wheelSlip: 0,
      inSoftPit: false,
      detourSign: 1
    };
    setBattery(100);
    setSolarExposure(100);
    setLidarDistance(null);
    setStatus('EDL AERO-BRAKING');
    setShowSummaryModal(false);
    setSummaryMode('ROVER');
    edlStateRef.current = createInitialEDLState();
    setEdlHistory([{ t: 0, altitude: 16000, velocity: Math.hypot(20, -450, 10), fuel: 1200, heat: 0 }]);
    setMarsTelemetry({ posX: 0, posZ: 0, heading: 0, speed: 0, hazardDetected: false, obstaclesAvoided: 0, distanceTraveled: 0, wheelSlip: 0, inSoftPit: false });
    setEarthTelemetry({ posX: 0, posZ: 0, heading: 0, battery: 100, status: 'EDL', timestamp: '00:00:00', obstaclesAvoided: 0, distanceTraveled: 0 });

    const originY = getTerrainHeight(0, 0) + 0.5;
    if (marsRoverRef.current) marsRoverRef.current.position.set(0, originY, 0);
    if (earthRoverRef.current) earthRoverRef.current.position.set(0, originY, 0);

    addLog('SIMULATION RESET TO ORIGIN (0,0)');
  };

  // Setup 3D Viewports
  useEffect(() => {
    const marsContainer = marsMountRef.current;
    const earthContainer = earthMountRef.current;
    if (!marsContainer || !earthContainer) return;

    // MARS VIEWPORT
    const marsScene = new THREE.Scene();
    marsScene.background = new THREE.Color(0x09090b);
    marsScene.fog = new THREE.FogExp2(0x26120b, 0.005);

    const marsCam = new THREE.PerspectiveCamera(45, marsContainer.clientWidth / marsContainer.clientHeight, 0.1, 800);
    marsCam.position.set(0, 15, -25);

    const marsRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    marsRenderer.setSize(marsContainer.clientWidth, marsContainer.clientHeight);
    marsRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    marsRenderer.shadowMap.enabled = true;
    marsContainer.appendChild(marsRenderer.domElement);

    const marsControls = new OrbitControls(marsCam, marsRenderer.domElement);
    marsControls.enableDamping = true;
    marsControls.dampingFactor = 0.05;
    marsControls.maxPolarAngle = Math.PI / 2 - 0.02;
    marsControls.minDistance = 6;
    marsControls.maxDistance = 180;
    marsControls.target.set(0, getTerrainHeight(0, 0) + 2.8, 2.8);
    marsControlsRef.current = marsControls;

    // EARTH VIEWPORT
    const earthScene = new THREE.Scene();
    earthScene.background = new THREE.Color(0x09090b);
    earthScene.fog = new THREE.FogExp2(0x0f172a, 0.004);

    const earthCam = new THREE.PerspectiveCamera(45, earthContainer.clientWidth / earthContainer.clientHeight, 0.1, 800);
    // Keep Earth viewport orientation identical to Mars viewport: +X right, +Z forward.
    // This makes the same world (X,Z) coordinates appear in the same screen direction.
    earthCam.position.set(0, 20, -28);

    const earthRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    earthRenderer.setSize(earthContainer.clientWidth, earthContainer.clientHeight);
    earthRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    earthContainer.appendChild(earthRenderer.domElement);

    const earthControls = new OrbitControls(earthCam, earthRenderer.domElement);
    earthControls.enableDamping = true;
    earthControls.dampingFactor = 0.05;
    earthControls.maxPolarAngle = Math.PI / 2 - 0.02;
    earthControls.minDistance = 10;
    earthControls.maxDistance = 250;
    // Same initial look-at orientation as the Mars viewport.
    earthControls.target.set(0, 0.6, 0);
    earthControlsRef.current = earthControls;

    // Lighting
    const ambLight = new THREE.AmbientLight(0xffffff, 1.2);
    marsScene.add(ambLight.clone());
    earthScene.add(new THREE.AmbientLight(0xdbeafe, 1.4));

    const dirLight = new THREE.DirectionalLight(0xeab308, 2.2);
    dirLight.position.set(60, 120, -60);
    dirLight.castShadow = true;
    marsScene.add(dirLight);

    const earthDirLight = new THREE.DirectionalLight(0x60a5fa, 1.8);
    earthDirLight.position.set(60, 120, -60);
    earthScene.add(earthDirLight);

    // BLUE THEME GRID FOR EARTH VIEWPORT
    const earthGrid = new THREE.GridHelper(300, 100, 0x3b82f6, 0x1e293b);
    earthGrid.position.y = 0.08;
    earthScene.add(earthGrid);

    // Terrain Texture
    const terrainTexture = generateMarsTerrainTexture();
    terrainTexture.wrapS = THREE.RepeatWrapping;
    terrainTexture.wrapT = THREE.RepeatWrapping;
    terrainTexture.repeat.set(10, 10);

    const marsMat = new THREE.MeshStandardMaterial({
      map: terrainTexture,
      roughness: 0.95,
      metalness: 0.05
    });

    const terrainGeo = new THREE.PlaneGeometry(300, 300, 100, 100);
    terrainGeo.rotateX(-Math.PI / 2);

    // Displace terrain vertices to create hills, ridges and craters.
    const terrainPositions = terrainGeo.attributes.position;
    for (let i = 0; i < terrainPositions.count; i++) {
      const x = terrainPositions.getX(i);
      const z = terrainPositions.getZ(i);
      terrainPositions.setY(i, getTerrainHeight(x, z));
    }
    terrainPositions.needsUpdate = true;
    terrainGeo.computeVertexNormals();

    const marsTerrain = new THREE.Mesh(terrainGeo, marsMat);
    marsTerrain.receiveShadow = true;
    marsScene.add(marsTerrain);

    // BLUE TERRAIN WIREFRAME FOR EARTH
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x2563eb, wireframe: true, opacity: 0.2, transparent: true });
    const earthTerrain = new THREE.Mesh(terrainGeo, wireMat);
    earthScene.add(earthTerrain);

    // Hazard Rendering
    const lidarMeshes = [];
    obstacles.forEach((obs) => {
      let geo, mat, wireColor;
      if (obs.type === 'boulder') {
        geo = new THREE.DodecahedronGeometry(obs.radius, 1);
        mat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.9 });
        wireColor = 0x60a5fa;
      } else if (obs.type === 'sandtrap') {
        geo = new THREE.CylinderGeometry(obs.radius, obs.radius, 0.18, 32);
        mat = new THREE.MeshStandardMaterial({ color: 0x9a3412, roughness: 1.0 });
        wireColor = 0x3b82f6;
      } else {
        geo = new THREE.RingGeometry(obs.radius * 0.7, obs.radius, 32);
        geo.rotateX(-Math.PI / 2);
        mat = new THREE.MeshBasicMaterial({ color: 0x18181b, side: THREE.DoubleSide });
        wireColor = 0x1d4ed8;
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(obs.x, obs.type === 'boulder' ? obs.radius * 0.55 : -0.05, obs.z);
      mesh.castShadow = true;
      marsScene.add(mesh);

      const twinWire = new THREE.MeshBasicMaterial({ color: wireColor, wireframe: true });
      const twinMesh = new THREE.Mesh(geo, twinWire);
      twinMesh.position.copy(mesh.position);
      earthScene.add(twinMesh);
    });

    // SOLID ROVER BUILDER WITH WHITE CHASSIS
    function buildRoverMesh(isDigitalTwin = false) {
      const group = new THREE.Group();

      // CRISP WHITE ROVER CHASSIS
      const chassisGeo = new THREE.BoxGeometry(2.4, 0.8, 3.0);
      const chassisMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.2,
        roughness: 0.1
      });
      const chassis = new THREE.Mesh(chassisGeo, chassisMat);
      chassis.position.y = 0.85;
      chassis.castShadow = true;
      group.add(chassis);

      // Solar array panel
      const solarGeo = new THREE.BoxGeometry(2.8, 0.06, 3.2);
      const solarMat = new THREE.MeshStandardMaterial({ color: isDigitalTwin ? 0x1e3a8a : 0x18181b, roughness: 0.3 });
      const solar = new THREE.Mesh(solarGeo, solarMat);
      solar.position.set(0, 1.3, -0.1);
      group.add(solar);

      // Sensor Mast
      const mastGeo = new THREE.CylinderGeometry(0.1, 0.1, 1.4, 12);
      const mastMat = new THREE.MeshStandardMaterial({ color: 0xd4d4d8, metalness: 0.8, roughness: 0.2 });
      const mast = new THREE.Mesh(mastGeo, mastMat);
      mast.position.set(0, 1.6, 1.1);
      group.add(mast);

      // Camera Head
      const domeGeo = new THREE.SphereGeometry(0.3, 16, 16);
      const domeMat = new THREE.MeshBasicMaterial({ color: isDigitalTwin ? 0x3b82f6 : 0xeab308 });
      const dome = new THREE.Mesh(domeGeo, domeMat);
      dome.position.set(0, 2.3, 1.1);
      group.add(dome);

      // 6-wheel ROCKER-BOGIE suspension
      const wheels = [];
      const rockerParts = [];
      const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 20);
      wheelGeo.rotateZ(Math.PI / 2);
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.6 });
      const armMat = new THREE.MeshStandardMaterial({
        color: 0xd4d4d8,
        metalness: 0.65,
        roughness: 0.3
      });

      const createSideSuspension = (xOffset) => {
        const side = new THREE.Group();

        // Pivoted rocker arm
        const rocker = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.16, 2.05),
          armMat
        );
        rocker.position.set(0, 0.0, 0.35);
        rocker.rotation.x = -0.15;
        side.add(rocker);

        // Rear bogie arm
        const bogie = new THREE.Mesh(
          new THREE.BoxGeometry(0.15, 0.15, 1.9),
          armMat
        );
        bogie.position.set(0, -0.05, -0.95);
        bogie.rotation.x = 0.42;
        side.add(bogie);

        // Central pivot
        const pivot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.15, 0.15, 0.5, 16),
          armMat
        );
        pivot.rotation.z = Math.PI / 2;
        pivot.position.set(0, 0, 0.35);
        side.add(pivot);

        const localWheelZ = [1.4, 0.0, -1.4];
        localWheelZ.forEach((z, index) => {
          const wheel = new THREE.Mesh(wheelGeo, wheelMat);
          wheel.position.set(0, -0.35, z);
          wheel.castShadow = true;
          side.add(wheel);
          wheels.push(wheel);

          // Front wheel is carried by rocker; middle/rear by bogie.
          if (index === 0) rocker.add(wheel);
          else bogie.add(wheel);
        });

        side.position.x = xOffset;
        group.add(side);

        return { side, rocker, bogie };
      };

      const leftSuspension = createSideSuspension(-1.35);
      const rightSuspension = createSideSuspension(1.35);

      rockerParts.push(leftSuspension);
      rockerParts.push(rightSuspension);

      return { group, wheels, rockerParts };
    }

    const marsRover = buildRoverMesh(false);
    marsScene.add(marsRover.group);
    marsRoverRef.current = marsRover.group;
    const originY = getTerrainHeight(0, 0) + 0.75;
    marsRover.group.position.set(0, originY, 0);
    // Enlarge the rover for readability in the split-screen view.
    marsRover.group.scale.setScalar(1.65);
    wheelsRef.current = marsRover.wheels;

    // High-visibility landing / rover-start marker at the true (0,0) coordinate.
    const spawnMarker = new THREE.Group();

    const spawnRing = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 3.6, 48),
      new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide
      })
    );
    spawnRing.rotation.x = -Math.PI / 2;
    spawnRing.position.y = originY - 0.62;
    spawnMarker.add(spawnRing);

    const spawnPole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3.5, 10),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    spawnPole.position.y = originY + 1.8;
    spawnMarker.add(spawnPole);

    const spawnBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    spawnBeacon.position.y = originY + 3.65;
    spawnMarker.add(spawnBeacon);

    marsScene.add(spawnMarker);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512;
    labelCanvas.height = 96;
    const labelCtx = labelCanvas.getContext('2d');
    labelCtx.clearRect(0, 0, 512, 96);
    labelCtx.fillStyle = 'rgba(9,9,11,0.88)';
    labelCtx.fillRect(0, 0, 512, 96);
    labelCtx.strokeStyle = '#22c55e';
    labelCtx.lineWidth = 4;
    labelCtx.strokeRect(2, 2, 508, 92);
    labelCtx.fillStyle = '#22c55e';
    labelCtx.font = 'bold 34px monospace';
    labelCtx.textAlign = 'center';
    labelCtx.textBaseline = 'middle';
    labelCtx.fillText('ROVER START • X 0.0 • Z 0.0', 256, 48);

    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture,
        transparent: true,
        depthTest: false
      })
    );
    labelSprite.scale.set(7.5, 1.4, 1);
    labelSprite.position.set(0, originY + 5.2, 0);
    marsScene.add(labelSprite);
    rockerPartsRef.current = marsRover.rockerParts;

    // VISIBLE EDL DESCENT VEHICLE
    // The physics state is numerical; this group makes the entry vehicle,
    // parachute and rocket plume visible in the Mars viewport.
    const edlGroup = new THREE.Group();

    const edlCapsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.35, 2.0, 6, 16),
      new THREE.MeshStandardMaterial({
        color: 0xe4e4e7,
        metalness: 0.55,
        roughness: 0.3
      })
    );
    edlCapsule.rotation.x = Math.PI / 2;
    edlGroup.add(edlCapsule);

    const heatShield = new THREE.Mesh(
      new THREE.CylinderGeometry(1.25, 1.45, 0.3, 24),
      new THREE.MeshStandardMaterial({
        color: 0x27272a,
        metalness: 0.2,
        roughness: 0.85
      })
    );
    heatShield.position.z = -0.85;
    heatShield.rotation.x = Math.PI / 2;
    edlGroup.add(heatShield);

    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(
        3.4, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2
      ),
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        emissive: 0x4a1800,
        emissiveIntensity: 0.25,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.82
      })
    );
    canopy.position.y = 3.6;
    canopy.visible = false;
    edlGroup.add(canopy);

    // Four simple suspension lines make parachute deployment obvious.
    const chuteLines = [];
    [[-1.8, 0], [1.8, 0], [0, -1.8], [0, 1.8]].forEach(([x, z]) => {
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, 3.2, z),
        new THREE.Vector3(0, 0.8, 0)
      ]);
      const line = new THREE.Line(
        lineGeometry,
        new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.75 })
      );
      line.visible = false;
      edlGroup.add(line);
      chuteLines.push(line);
    });

    const plumeMaterial = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.88
    });
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(1.15, 3.6, 16),
      plumeMaterial
    );
    plume.rotation.x = Math.PI;
    plume.position.y = -2.15;
    plume.visible = false;
    edlGroup.add(plume);

    const statusBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x22c55e })
    );
    statusBeacon.position.set(0, 1.4, 0);
    edlGroup.add(statusBeacon);

    marsScene.add(edlGroup);
    edlVisualRef.current = {
      group: edlGroup,
      capsule: edlCapsule,
      canopy,
      chuteLines,
      plume,
      statusBeacon
    };

    const earthRover = buildRoverMesh(true);
    earthScene.add(earthRover.group);
    earthRoverRef.current = earthRover.group;
    earthRover.group.position.set(0, getTerrainHeight(0, 0) + 0.5, 0);

    // Optical LiDAR Beams
    const rayGroup = new THREE.Group();
    const rayLines = [];
    const rayAngles = [-0.7, -0.35, 0, 0.35, 0.7];

    rayAngles.forEach((angle) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 2.3, 1.1),
        new THREE.Vector3(Math.sin(angle) * 14, 0.1, Math.cos(angle) * 14 + 1.1)
      ]);
      const mat = new THREE.LineBasicMaterial({ color: 0xeab308, transparent: true, opacity: 0.85 });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      rayGroup.add(line);
      rayLines.push(line);
    });

    marsRover.group.add(rayGroup);
    lidarRaysRef.current = rayLines;

    let animId;
    let prevMarsPos = new THREE.Vector3();
    let prevEarthPos = new THREE.Vector3();

    const animate = () => {
      animId = requestAnimationFrame(animate);

      if (marsRoverRef.current && marsControlsRef.current) {
        const currentPos = marsRoverRef.current.position;
        const delta = new THREE.Vector3().subVectors(currentPos, prevMarsPos);
        
        marsCam.position.add(delta);
        marsControlsRef.current.target.add(delta);
        prevMarsPos.copy(currentPos);
      }

      if (earthRoverRef.current && earthControlsRef.current) {
        const currentPos = earthRoverRef.current.position;
        const delta = new THREE.Vector3().subVectors(currentPos, prevEarthPos);

        earthCam.position.add(delta);
        earthControlsRef.current.target.add(delta);
        prevEarthPos.copy(currentPos);
      }

      // Animate the EDL vehicle from the same X/Z state used by the physics solver.
      if (edlVisualRef.current) {
        const e = edlStateRef.current;
        const v = edlVisualRef.current;

        if (e.phase !== 'LANDED') {
          // Compress physical altitude for the local 3D viewport so the vehicle
          // remains visible while preserving its relative altitude progression.
          const displayAltitude = 6 + e.altitude * 0.012;
          v.group.visible = true;
          v.group.position.set(e.x * 0.12, displayAltitude, e.z * 0.12);

          const parachuteActive = e.phase === 'PARACHUTE';
          const rocketActive = e.phase === 'POWERED DESCENT';

          v.canopy.visible = parachuteActive;
          v.chuteLines.forEach((line) => { line.visible = parachuteActive; });
          v.plume.visible = rocketActive;

          // Slight descent wobble only; no arbitrary horizontal drift.
          v.group.rotation.z = THREE.MathUtils.clamp(e.vx * 0.002, -0.18, 0.18);
          v.group.rotation.x = THREE.MathUtils.clamp(-e.vz * 0.002, -0.18, 0.18);

          const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.12;
          v.statusBeacon.scale.setScalar(pulse);
        } else {
          v.group.visible = false;
        }
      }

      marsControls.update();
      earthControls.update();
      marsRenderer.render(marsScene, marsCam);
      earthRenderer.render(earthScene, earthCam);
    };
    animate();

    const handleResize = () => {
      if (!marsContainer || !earthContainer) return;
      marsCam.aspect = marsContainer.clientWidth / marsContainer.clientHeight;
      marsCam.updateProjectionMatrix();
      marsRenderer.setSize(marsContainer.clientWidth, marsContainer.clientHeight);

      earthCam.aspect = earthContainer.clientWidth / earthContainer.clientHeight;
      earthCam.updateProjectionMatrix();
      earthRenderer.setSize(earthContainer.clientWidth, earthContainer.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
      marsRenderer.dispose();
      earthRenderer.dispose();
      if (marsContainer) marsContainer.innerHTML = '';
      if (earthContainer) earthContainer.innerHTML = '';
    };
  }, [obstacles]);

  // Transmit Command Pipeline
  const sendCommand = (customCmd = null) => {
    const rawCmd = customCmd || commandInput;
    if (!rawCmd.trim() || isTransmitting || simState.current.stuck) return;

    setIsTransmitting(true);
    setStatus('TRANSMITTING');
    setTransmitTimer(2);

    addLog(`UPLINK TRANSMISSION: "${rawCmd.toUpperCase()}"`);

    const parts = rawCmd.trim().toUpperCase().split(' ');
    const cmdType = parts[0];
    const args = parts[1] ? parts[1].split(',').map(Number) : [];

    let timer = 2;
    const interval = setInterval(() => {
      timer -= 1;
      setTransmitTimer(timer);

      if (timer <= 0) {
        clearInterval(interval);
        setIsTransmitting(false);

        if (cmdType === 'WAYPOINT' && args.length === 2) {
          simState.current.waypointQueue.push({ x: args[0], z: args[1] });
          addLog(`QUEUED WAYPOINT (${args[0]}, ${args[1]}). QUEUE LENGTH: ${simState.current.waypointQueue.length}`);

          if (
            simState.current.status === 'IDLE' ||
            simState.current.status === 'COMPLETED' ||
            simState.current.status === 'EDL'
          ) {
            const nextWp = simState.current.waypointQueue.shift();
            simState.current.targetX = nextWp.x;
            simState.current.targetZ = nextWp.z;
            simState.current.path = findAStarPath(
              { x: simState.current.posX, z: simState.current.posZ },
              nextWp,
              obstacles
            );
            simState.current.pathIndex = 0;
            simState.current.status = 'EXECUTING';
            setStatus('EXECUTING');
            addLog(`A* ROUTE COMPUTED — ${simState.current.path.length} NODES`);
          }
        } else if (cmdType === 'CHARGE' && edlStateRef.current.phase === 'LANDED') {
          simState.current.status = 'CHARGING';
          setStatus('CHARGING');
          addLog('SOLAR EXPOSURE LOCKED. DYNAMIC CHARGING INITIATED.');
        } else if (cmdType === 'CHARGE') {
          setStatus(`EDL ${edlStateRef.current.phase}`);
          addLog('CHARGE COMMAND HELD — WAITING FOR EDL TOUCHDOWN.');
        } else {
          setStatus('IDLE');
          addLog('ERROR: INVALID PROTOCOL SYNTAX.');
        }
      }
    }, 1000);
  };

  // Autonomous Physics + A* Navigation + LiDAR Sensor Engine
  useEffect(() => {
    const physicsLoop = setInterval(() => {
      const s = simState.current;
      if (s.stuck) return;

      const dt = 0.1;

      // EDL phase runs before ground-rover autonomy.
      const edl = edlStateRef.current;
      if (edl.phase !== 'LANDED') {
        const result = stepEDL(edl, dt);
        const atm = getMarsAtmosphere(edl.altitude);
        const speed = Math.hypot(edl.vx, edl.vy, edl.vz);

        if (result.phaseChanged) {
          if (result.newPhase === 'PARACHUTE') {
            addLog(
              `EDL TRIGGER: PARACHUTE DEPLOYED — ALT ${edl.altitude.toFixed(0)}m / P ${result.atmosphere.pressure.toFixed(0)}Pa`
            );
          } else if (result.newPhase === 'POWERED DESCENT') {
            addLog(
              `EDL TRIGGER: ROCKET IGNITION — ALT ${edl.altitude.toFixed(0)}m / P ${result.atmosphere.pressure.toFixed(0)}Pa`
            );
          }
        }

        if (
          s.status !== 'EXECUTING' &&
          s.status !== 'REROUTING' &&
          s.status !== 'CHARGING'
        ) {
          setStatus(`EDL ${edl.phase}`);
        }
        setEdlTelemetry({
          phase: edl.phase,
          altitude: edl.altitude,
          velocity: speed,
          density: atm.density,
          pressure: atm.pressure,
          fuel: edl.fuel,
          heatFlux: edl.heatFlux,
          gForce: edl.gForce,
          maxGForce: edl.maxGForce,
          maxHeatFlux: edl.maxHeatFlux,
          landingSpeed: edl.touchdownSpeed,
          landingAccuracy: edl.touchdownAccuracy,
          landingG: edl.touchdownG,
          landingVerified: edl.landingVerified,
          parachuteDeployed: edl.parachuteDeployed,
          rocketsIgnited: edl.rocketsIgnited
        });

        if (edl.time % 0.2 < dt || result.touchdown) {
          setEdlHistory((prev) => [
            ...prev,
            {
              t: edl.time,
              altitude: edl.altitude,
              velocity: speed,
              fuel: edl.fuel,
              heat: edl.heatFlux
            }
          ].slice(-100));
        }

        if (result.touchdown) {
          // Preserve the rover's current autonomous ground position.
          // EDL touchdown is a separate subsystem; it must not teleport
          // or reset the rover.
          s.posY = getTerrainHeight(s.posX, s.posZ) + 0.5;
          if (marsRoverRef.current) {
            marsRoverRef.current.visible = true;
            marsRoverRef.current.scale.setScalar(1.65);
          }
          s.status = 'IDLE';

          setStatus(s.status === 'EXECUTING' ? 'EXECUTING' : 'LANDED');
          setSummaryMode('EDL');
          if (s.status !== 'EXECUTING') {
            setShowSummaryModal(true);
          }

          addLog(
            `TOUCHDOWN EVALUATION — V ${edl.touchdownSpeed.toFixed(2)}m/s / ACC ${edl.touchdownAccuracy.toFixed(1)}m / MAX G ${edl.maxGForce.toFixed(2)}G`
          );

          if (s.waypointQueue.length > 0) {
            const next = s.waypointQueue.shift();
            s.targetX = next.x;
            s.targetZ = next.z;
            s.path = findAStarPath({ x: 0, z: 0 }, next, obstacles);
            s.pathIndex = 0;
            s.status = 'EXECUTING';
            setStatus('EXECUTING');
            setShowSummaryModal(false);
          }
        }

        // EDL is intentionally non-blocking: the ground rover autonomy
        // can execute queued waypoints in parallel with the descent simulation.
        // Do not reset the rover to (0,0) every physics tick.
        if (marsRoverRef.current) {
          marsRoverRef.current.visible = true;
          marsRoverRef.current.scale.setScalar(1.65);
        }
      }

      // Dynamic solar exposure from rover panel orientation vs Sun vector.
      const sunVector = new THREE.Vector3(60, 120, -60).normalize();
      const panelNormal = new THREE.Vector3(0, 1, 0);

      if (marsRoverRef.current) {
        panelNormal.applyQuaternion(marsRoverRef.current.quaternion);
      }

      const exposure = Math.max(0, panelNormal.dot(sunVector));
      s.solarExposure = exposure;
      setSolarExposure(exposure * 100);

      // Solar Recharging — rate depends on actual simulated exposure.
      if (s.status === 'CHARGING') {
        const chargeRate = 3.0 * exposure;
        s.battery = Math.min(100, s.battery + chargeRate * dt);
        setBattery(s.battery);

        if (s.battery >= 100) {
          s.status = 'IDLE';
          setStatus('IDLE');
          addLog('SOLAR CHARGE COMPLETE — 100%. READY FOR QUEUED COMMANDS.');
        }
        return;
      }

      // Movement & Autonomy Logic
      if (s.status === 'EXECUTING' || s.status === 'REROUTING') {
        const dx = s.targetX - s.posX;
        const dz = s.targetZ - s.posZ;
        const distToTarget = Math.sqrt(dx * dx + dz * dz);

        // Follow A* path node-by-node, always moving forward through the path.
        // The old logic could switch between a node and the waypoint near corners,
        // creating a circular "orbit" around the same location.
        if (s.path.length > 0 && s.pathIndex < s.path.length) {
          let node = s.path[s.pathIndex];

          // Consume every node already reached before selecting the steering target.
          while (
            s.pathIndex < s.path.length &&
            Math.hypot(s.posX - s.path[s.pathIndex].x, s.posZ - s.path[s.pathIndex].z)
              <= WAYPOINT_NODE_TOLERANCE
          ) {
            s.pathIndex += 1;
          }

          if (s.pathIndex < s.path.length) {
            node = s.path[s.pathIndex];
            s.targetX = node.x;
            s.targetZ = node.z;
          } else {
            // Path finished: snap to the actual waypoint instead of circling it.
            s.path = [];
            s.pathIndex = 0;
            s.posX = s.targetX;
            s.posZ = s.targetZ;

            if (s.waypointQueue.length > 0) {
              const next = s.waypointQueue.shift();
              s.targetX = next.x;
              s.targetZ = next.z;
              s.path = findAStarPath(
                { x: s.posX, z: s.posZ },
                next,
                obstacles
              );
              s.pathIndex = 0;
              addLog(`A* RECALCULATED — ${s.path.length} NODES TO (${next.x}, ${next.z})`);
            } else {
              s.status = 'COMPLETED';
              setStatus('COMPLETED');
              s.speed = 0;
              setShowSummaryModal(true);
              addLog(`MISSION SUCCESS: ALL WAYPOINTS REACHED AT (${s.posX.toFixed(1)}, ${s.posZ.toFixed(1)})`);
              return;
            }
          }
        } else if (distToTarget <= WAYPOINT_TOLERANCE) {
          s.posX = s.targetX;
          s.posZ = s.targetZ;
          s.speed = 0;

          if (s.waypointQueue.length > 0) {
            const next = s.waypointQueue.shift();
            s.targetX = next.x;
            s.targetZ = next.z;
            s.path = findAStarPath(
              { x: s.posX, z: s.posZ },
              next,
              obstacles
            );
            s.pathIndex = 0;
          } else {
            s.status = 'COMPLETED';
            setStatus('COMPLETED');
            setShowSummaryModal(true);
            addLog(`MISSION SUCCESS: ALL WAYPOINTS REACHED AT (${s.posX.toFixed(1)}, ${s.posZ.toFixed(1)})`);
            return;
          }
        }

        // Recompute the target vector after A* may have advanced to a new node.
        const targetDx = s.targetX - s.posX;
        const targetDz = s.targetZ - s.posZ;

        // A* provides global routing; the repulsion vector remains only a local
        // safety layer for unexpected proximity to a hazard.
        let targetAngle = Math.atan2(targetDx, targetDz);
        let hazardDetected = false;
        let inSoftPit = false;
        let baseSpeed = 2.6;

        let repX = 0;
        let repZ = 0;

        obstacles.forEach((obs) => {
          const obsDx = s.posX - obs.x;
          const obsDz = s.posZ - obs.z;
          const dist = Math.hypot(obsDx, obsDz);

          // 1. SOFT-PIT SAND TRAP PHYSICS
          if (obs.type === 'sandtrap' && dist < obs.radius) {
            inSoftPit = true;
            s.wheelSlip = 0.75;
            baseSpeed = 0.8;
            s.posY = Math.max(-0.2, s.posY - 0.08 * dt);

            if (s.battery < 15) {
              s.stuck = true;
              s.status = 'STUCK';
              s.reason = `WHEELS IMMOBILIZED IN ${obs.name.toUpperCase()}`;
              setStatus('STUCK');
              addLog(`CRITICAL FAILURE: ${s.reason}`);
            }
          }

          // 2. POTENTIAL FIELD REPULSION FOR BOULDERS & CRATERS
          const detectionRadius = obs.radius + 4.5;
          if (obs.type !== 'sandtrap' && dist < detectionRadius) {
            hazardDetected = true;

            const repForce = Math.pow((detectionRadius - dist) / detectionRadius, 2) * 1.6;
            repX += (obsDx / dist) * repForce;
            repZ += (obsDz / dist) * repForce;

            if (s.status !== 'REROUTING') {
              s.status = 'REROUTING';
              setStatus('REROUTING');
              s.obstaclesAvoided += 1;
              
              const cross = targetDx * (-obsDz) - targetDz * (-obsDx);
              s.detourSign = cross >= 0 ? 1 : -1;
              addLog(`LOCAL SAFETY LAYER: LiDAR/clearance detour around ${obs.name.toUpperCase()}`);
            }
          }
        });

        if (!inSoftPit) {
          // Keep the rover on the procedural terrain surface.
          s.posY = getTerrainHeight(s.posX, s.posZ) + 0.5;
          s.wheelSlip = 0.05;
        }
        s.inSoftPit = inSoftPit;

        // --- REAL THREE.JS RAYCASTER LiDAR ---
        const lidarOrigin = new THREE.Vector3(
          s.posX,
          s.posY + 1.8,
          s.posZ
        );

        let nearestLidar = 14;
        let rayHazard = false;

        const sweepAngles = [-0.9, -0.45, 0, 0.45, 0.9];

        sweepAngles.forEach((angle) => {
          const rayDirection = new THREE.Vector3(
            Math.sin(angle),
            -0.08,
            Math.cos(angle)
          );

          rayDirection.applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            s.heading
          );
          rayDirection.normalize();

          raycasterRef.current.set(lidarOrigin, rayDirection);

          const hits = raycasterRef.current.intersectObjects(
            lidarObjectsRef.current,
            true
          );

          if (hits.length && hits[0].distance < nearestLidar) {
            nearestLidar = hits[0].distance;
            rayHazard = true;
          }
        });

        if (rayHazard) {
          hazardDetected = true;
        }

        s.lidarDetected = rayHazard;
        setLidarDistance(nearestLidar < 14 ? nearestLidar : null);

        // A* owns the navigation direction. The local hazard vectors are used
        // only for detection/logging, not for continuous steering. This prevents
        // the rover from entering a left-right limit cycle and circling a point.

        const targetLength = Math.hypot(targetDx, targetDz);
        const pathDirX = targetLength > 0.0001 ? targetDx / targetLength : 0;
        const pathDirZ = targetLength > 0.0001 ? targetDz / targetLength : 1;

        const desiredHeading = Math.atan2(pathDirX, pathDirZ);

        // Smooth heading for visual realism; position still follows the A* vector.
        let angleDiff = desiredHeading - s.heading;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        s.heading += THREE.MathUtils.clamp(angleDiff, -0.18, 0.18);

        // Toggle Optical LiDAR Beam Visibility
        if (lidarRaysRef.current.length > 0) {
          lidarRaysRef.current.forEach((line) => {
            line.visible = hazardDetected;
          });
        }

        if (!hazardDetected && s.status === 'REROUTING') {
          s.status = 'EXECUTING';
          setStatus('EXECUTING');
        }

        // Apply Motion & Battery Depletion
        if (!s.stuck) {
          s.speed = baseSpeed;
          const requestedStep = s.speed * dt;

          // Move strictly toward the current A* node and clamp to the node.
          // This eliminates overshoot, which was a major source of circular motion.
          const remainingDistance = Math.hypot(
            s.targetX - s.posX,
            s.targetZ - s.posZ
          );
          const actualStep = Math.min(requestedStep, remainingDistance);

          if (remainingDistance > 0.0001 && actualStep > 0) {
            s.posX += pathDirX * actualStep;
            s.posZ += pathDirZ * actualStep;
            s.distanceTraveled += actualStep;
          }

          const baseDrain = inSoftPit ? 0.65 : 0.22;
          const solarAssist = s.solarExposure * 0.08;
          const batteryDrainRate = Math.max(0, baseDrain - solarAssist) * dt;
          s.battery = Math.max(0, s.battery - batteryDrainRate);
          setBattery(s.battery);

          if (s.battery <= 0) {
            s.stuck = true;
            s.status = 'POWER DEPLETED';
            s.reason = 'BATTERY DEPLETED TO 0% IN FIELD';
            setStatus('POWER DEPLETED');
            addLog(`CRITICAL FAILURE: ${s.reason}`);
          }
        }

        // Update Mars Rover Mesh
        if (marsRoverRef.current) {
          marsRoverRef.current.position.set(s.posX, s.posY, s.posZ);
          marsRoverRef.current.rotation.y = s.heading;

          // Chassis pitch follows the uneven terrain.
          const frontY = getTerrainHeight(s.posX, s.posZ - 1.4);
          const rearY = getTerrainHeight(s.posX, s.posZ + 1.4);
          const pitch = Math.atan2(frontY - rearY, 2.8);
          marsRoverRef.current.rotation.x = THREE.MathUtils.lerp(
            marsRoverRef.current.rotation.x,
            pitch * 0.65,
            0.15
          );

          // Rocker-bogie articulation reacts to front/rear terrain heights.
          if (rockerPartsRef.current.length) {
            const left = rockerPartsRef.current[0];
            const right = rockerPartsRef.current[1];

            const frontTerrain = getTerrainHeight(s.posX, s.posZ - 1.4);
            const midTerrain = getTerrainHeight(s.posX, s.posZ);
            const rearTerrain = getTerrainHeight(s.posX, s.posZ + 1.4);

            const rockerAngle = Math.atan2(
              frontTerrain - midTerrain,
              1.4
            );
            const bogieAngle = Math.atan2(
              rearTerrain - midTerrain,
              1.4
            );

            [left, right].forEach((side) => {
              side.rocker.rotation.x = THREE.MathUtils.lerp(
                side.rocker.rotation.x,
                rockerAngle,
                0.12
              );
              side.bogie.rotation.x = THREE.MathUtils.lerp(
                side.bogie.rotation.x,
                bogieAngle,
                0.12
              );
            });
          }

          const spinSpeed = inSoftPit ? 1.2 : 0.3;
          wheelsRef.current.forEach((w) => {
            w.rotation.x += spinSpeed;
          });
        }

        // Visual digital-twin position: Earth and Mars share the exact same ground-plane coordinates.
        // Ground plane is X/Z in Three.js; these correspond to the mission's horizontal X/Y map coordinates.
        if (earthRoverRef.current && marsRoverRef.current) {
          earthRoverRef.current.position.set(
            marsRoverRef.current.position.x,
            marsRoverRef.current.position.y,
            marsRoverRef.current.position.z
          );
          earthRoverRef.current.rotation.y = marsRoverRef.current.rotation.y;
          earthRoverRef.current.rotation.x = marsRoverRef.current.rotation.x;
        }

        // Update Telemetry
        setMarsTelemetry({
          posX: s.posX,
          posZ: s.posZ,
          heading: s.heading,
          speed: s.speed,
          hazardDetected,
          obstaclesAvoided: s.obstaclesAvoided,
          distanceTraveled: s.distanceTraveled,
          wheelSlip: s.wheelSlip,
          inSoftPit: s.inSoftPit,
          solarExposure: s.solarExposure * 100,
          lidarDistance: nearestLidar < 14 ? nearestLidar : null,
          pathNodes: s.path.length
        });
      }
    }, 100);

    return () => clearInterval(physicsLoop);
  }, [obstacles]);

  // Delayed Telemetry Sync to Earth Twin
  useEffect(() => {
    const delaySync = setInterval(() => {
      if (marsRoverRef.current && earthRoverRef.current) {
        earthRoverRef.current.position.copy(marsRoverRef.current.position);
        earthRoverRef.current.rotation.y = marsRoverRef.current.rotation.y;

        setEarthTelemetry({
          posX: simState.current.posX,
          posZ: simState.current.posZ,
          heading: simState.current.heading,
          battery: simState.current.battery,
          status: simState.current.status,
          timestamp: new Date().toLocaleTimeString(),
          obstaclesAvoided: simState.current.obstaclesAvoided,
          distanceTraveled: simState.current.distanceTraveled
        });
      }
    }, latencyMode === 'REAL' ? 20 * 60 * 1000 : 2000);

    return () => clearInterval(delaySync);
  }, [latencyMode]);

  return (
    <div className="w-screen h-screen bg-[#09090b] font-mono text-zinc-100 flex flex-col select-none overflow-hidden">
      
      {/* HUD Header Bar */}
      <header className="h-16 border-b border-zinc-800 bg-[#121215] px-6 flex items-center justify-between z-30">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-gradient-to-br from-zinc-700 to-zinc-900 border border-zinc-700 rounded-xl shadow-lg">
            <Cpu className="w-5 h-5 text-zinc-100" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-black tracking-wider text-white">MARS ROVER AUTONOMY DIGITAL TWIN</h1>
              <span className="px-2 py-0.5 text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold rounded-full">EARTH BLUE / MARS ORANGE</span>
            </div>
            <p className="text-[11px] text-zinc-400">Deep Space Network High-Fidelity EDL + Rover Autonomy Testbed</p>
          </div>
        </div>

        {/* HUD System Chips */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 bg-[#18181b] border border-zinc-800 px-3.5 py-1.5 rounded-xl">
            <span className="w-2 h-2 rounded-full bg-zinc-400 animate-ping"></span>
            <span className="text-zinc-400">DSN LAG: <strong className="text-zinc-200 font-bold">{latencyMode === 'REAL' ? '20 MIN (REAL)' : '2.0s (SIM)'}</strong></span>
          </div>

          <div className="flex items-center gap-2 bg-[#18181b] border border-zinc-800 px-3.5 py-1.5 rounded-xl">
            {battery < 25 ? (
              <BatteryCharging className="w-4 h-4 text-orange-500 animate-bounce" />
            ) : (
              <Battery className="w-4 h-4 text-zinc-200" />
            )}
            <span className="text-zinc-400">POWER: <strong className={battery < 25 ? 'text-orange-500 font-bold' : 'text-amber-500 font-bold'}>{battery.toFixed(0)}%</strong></span>
          </div>

          <button
            onClick={handleReset}
            className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 border border-zinc-700 rounded-xl text-zinc-200 transition flex items-center gap-2 font-bold text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5 text-zinc-300" /> RESET ENGINE
          </button>
        </div>
      </header>

      {/* Main Split Screen Viewports */}
      <div className="flex-1 flex relative overflow-hidden">
        
        {/* LEFT VIEWPORT: EARTH MISSION CONTROL */}
        <div className="w-1/2 h-full border-r border-zinc-800 relative flex flex-col bg-[#09090b]">
          <div className="absolute top-4 left-4 z-20 bg-[#121215]/90 backdrop-blur border border-blue-800/80 px-3.5 py-2 rounded-xl flex items-center gap-2.5 text-blue-400 text-xs font-bold shadow-xl">
            <Eye className="w-4 h-4 text-blue-400" />
            <span>EARTH MISSION CONTROL (DELAYED DIGITAL TWIN)</span>
          </div>

          <div ref={earthMountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

          {/* Earth Telemetry Overlay (Updated to White text like Mars View) */}
          <div className="absolute bottom-4 left-4 right-4 bg-[#121215]/95 backdrop-blur border border-blue-900/50 p-4 rounded-2xl shadow-2xl space-y-3 text-xs z-20">
            <div className="flex justify-between items-center border-b border-zinc-800 pb-2 text-white">
              <span className="flex items-center gap-1.5 font-bold"><Activity className="w-3.5 h-3.5 text-white" /> LAST SYNC: {earthTelemetry.timestamp}</span>
              <span className="text-white font-bold bg-blue-950/80 px-2.5 py-0.5 rounded border border-blue-800">
  TELEMETRY DELAYED BY {latencyMode === 'REAL' ? '20 MIN' : '2s'}
</span>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div className="bg-[#18181b] border border-blue-900/40 p-2 rounded-xl">
                <span className="text-[10px] text-zinc-400 block mb-0.5">ESTIMATED POS</span>
                <span className="text-white font-bold">{earthTelemetry.posX.toFixed(1)}, {earthTelemetry.posZ.toFixed(1)}</span>
              </div>
              <div className="bg-[#18181b] border border-blue-900/40 p-2 rounded-xl">
                <span className="text-[10px] text-zinc-400 block mb-0.5">POWER LEVEL</span>
                <span className="text-white font-bold">{earthTelemetry.battery.toFixed(0)}%</span>
              </div>
              <div className="bg-[#18181b] border border-blue-900/40 p-2 rounded-xl">
                <span className="text-[10px] text-zinc-400 block mb-0.5">ROVER STATE</span>
                <span className="text-white font-bold">{earthTelemetry.status}</span>
              </div>
              <div className="bg-[#18181b] border border-blue-900/40 p-2 rounded-xl">
                <span className="text-[10px] text-zinc-400 block mb-0.5">AVOIDED HAZARDS</span>
                <span className="text-white font-bold">{earthTelemetry.obstaclesAvoided}</span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT VIEWPORT: MARS REAL-TIME SIMULATION */}
        <div className="w-1/2 h-full relative flex flex-col bg-[#09090b]">
          <div className="absolute top-4 left-4 z-20 bg-[#121215]/90 backdrop-blur border border-orange-900/50 px-3.5 py-2 rounded-xl flex items-center gap-2.5 text-orange-500 text-xs font-bold shadow-xl">
            <Flame className="w-4 h-4 text-orange-500" />
            <span>MARS REAL-TIME SIMULATION (PHYSICS ENGINE)</span>
          </div>

          <div ref={marsMountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

          <div className="absolute bottom-4 right-4 z-20 bg-[#121215]/85 backdrop-blur border border-orange-900/50 px-3 py-2 rounded-xl shadow-xl">
            <div className="text-[9px] text-zinc-500 font-bold">AUTONOMY STATUS</div>
            <div className="text-[11px] text-orange-500 font-black">{status}</div>
          </div>




        </div>
      </div>

      {/* Flight Terminal Log & Uplink Control Footer */}
      <footer className="h-52 border-t border-zinc-800 bg-[#09090b] p-4 flex gap-4 z-30">
        
        {/* Uplink Command Control Box */}
        <div className="w-[31%] bg-[#121215] border border-zinc-800 rounded-2xl p-3.5 flex flex-col justify-between shadow-inner">
          <div>
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2 text-xs">
              <div className="flex items-center gap-2 text-zinc-200 font-bold">
                <Terminal className="w-4 h-4 text-blue-400" />
                <span>UPLINK BATCH TERMINAL</span>
              </div>
              <span className="text-[10px] text-zinc-400">SYNTAX: WAYPOINT X,Z | CHARGE</span>
            </div>

            {/* Presets */}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              <span className="text-[10px] text-zinc-400 font-bold">PRESETS:</span>
              <button 
                onClick={() => sendCommand('WAYPOINT 45,60')} 
                disabled={isTransmitting || simState.current.stuck}
                className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-[10px] rounded text-zinc-200 border border-zinc-700 active:scale-95 transition"
              >
                + (45,60)
              </button>
              <button 
                onClick={() => sendCommand('WAYPOINT -30,85')} 
                disabled={isTransmitting || simState.current.stuck}
                className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-[10px] rounded text-zinc-200 border border-zinc-700 active:scale-95 transition"
              >
                + (-30,85)
              </button>
              <button 
                onClick={() => sendCommand('WAYPOINT 80,-40')} 
                disabled={isTransmitting || simState.current.stuck}
                className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-[10px] rounded text-zinc-200 border border-zinc-700 active:scale-95 transition"
              >
                + (80,-40)
              </button>
              <button 
                onClick={() => sendCommand('CHARGE')} 
                disabled={isTransmitting || simState.current.stuck}
                className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-[10px] rounded text-amber-500 border border-amber-900/60 active:scale-95 transition"
              >
                + CHARGE
              </button>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              placeholder="Enter waypoint (e.g. WAYPOINT 100,-50)..."
              disabled={isTransmitting || simState.current.stuck}
              className="flex-1 bg-[#18181b] border border-zinc-800 rounded-xl px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-blue-500 transition"
            />
            <button
              onClick={() => sendCommand()}
              disabled={isTransmitting || simState.current.stuck}
              className="px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:from-zinc-800 disabled:to-zinc-800 text-white font-bold rounded-xl text-xs transition flex items-center gap-2 shadow-lg"
            >
              <Send className="w-3.5 h-3.5" />
              {isTransmitting ? `UPLINKING (${transmitTimer}s)` : 'TRANSMIT'}
            </button>
          </div>
        </div>

        {/* Dedicated EDL Telemetry Panel — kept OUT of the Mars viewport */}
        <div className="w-[34%] bg-[#121215] border border-orange-900/50 rounded-2xl p-3 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5 mb-2">
            <div className="flex items-center gap-2">
              <Flame className="w-3.5 h-3.5 text-orange-500" />
              <span className="text-[10px] font-black text-zinc-200">EDL TELEMETRY • ROVER AUTONOMY LIVE</span>
            </div>
            <span className="text-[9px] text-orange-500 font-bold">{edlTelemetry.phase}</span>
          </div>

          <div className="grid grid-cols-3 gap-1.5 mb-2">
            <div className="bg-[#18181b] border border-zinc-800 rounded-lg px-2 py-1.5">
              <span className="text-[8px] text-zinc-500 block">ALT</span>
              <span className="text-[10px] text-white font-bold">{edlTelemetry.altitude.toFixed(0)}m</span>
            </div>
            <div className="bg-[#18181b] border border-zinc-800 rounded-lg px-2 py-1.5">
              <span className="text-[8px] text-zinc-500 block">VEL</span>
              <span className="text-[10px] text-amber-500 font-bold">{edlTelemetry.velocity.toFixed(1)} m/s</span>
            </div>
            <div className="bg-[#18181b] border border-zinc-800 rounded-lg px-2 py-1.5">
              <span className="text-[8px] text-zinc-500 block">MAX G</span>
              <span className="text-[10px] text-orange-500 font-bold">{edlTelemetry.maxGForce.toFixed(2)}G</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 flex-1 min-h-0">
            <TelemetryGraph
              title="ALT / VEL"
              unit="m"
              values={edlHistory.map((p) => p.altitude)}
              secondaryValues={edlHistory.map((p) => p.velocity)}
              colorClass="text-orange-500"
            />
            <TelemetryGraph
              title="FUEL"
              unit="kg"
              values={edlHistory.map((p) => p.fuel)}
              colorClass="text-blue-400"
            />
            <TelemetryGraph
              title="HEAT"
              unit="kW/m²"
              values={edlHistory.map((p) => p.heat)}
              colorClass="text-red-400"
            />
          </div>
        </div>

        {/* Live DSN Terminal Flight Logs */}
        <div className="flex-1 bg-[#121215] border border-zinc-800 rounded-2xl p-3.5 flex flex-col font-mono text-[11px] overflow-hidden">
          <div className="text-zinc-400 border-b border-zinc-800 pb-1.5 mb-2 font-bold flex justify-between">
            <span>DEEP SPACE NETWORK FLIGHT LOGS</span>
            <span className="text-blue-400">LIVE FEED ACTIVE</span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1 text-zinc-300 pr-2">
            {terminalLogs.map((log, index) => (
              <div key={index} className="leading-tight">
                <span className="text-zinc-400">{log.substring(0, 10)}</span>
                <span className={log.includes('CRITICAL') ? 'text-orange-500 font-bold' : log.includes('DETOUR') ? 'text-amber-500' : 'text-zinc-200'}>
                  {log.substring(10)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Failure Box */}
        {simState.current.stuck && (
          <div className="w-[23%] bg-zinc-900 border border-orange-900/80 p-4 rounded-2xl flex items-center gap-3 text-zinc-200 text-xs font-bold shadow-2xl">
            <AlertTriangle className="w-8 h-8 text-orange-500 animate-bounce flex-shrink-0" />
            <div>
              <div className="text-orange-500 tracking-wider">CRITICAL MISSION FAILURE</div>
              <div className="text-[10px] text-zinc-400 font-normal mt-1 leading-normal">
                {simState.current.reason || 'Hardware failure detected.'}
              </div>
              <button 
                onClick={handleReset} 
                className="mt-2 px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] text-white border border-zinc-700"
              >
                RECOVERY RESET
              </button>
            </div>
          </div>
        )}

      </footer>

      {/* Mission performance summary modal */}
      {showSummaryModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-6">
          <div className="bg-[#121215] border border-orange-600/40 w-full max-w-md rounded-3xl p-6 shadow-2xl text-center space-y-5">
            {summaryMode === 'EDL' ? (
              <>
                <div className="w-14 h-14 bg-zinc-900 border border-orange-500/50 rounded-2xl flex items-center justify-center mx-auto text-orange-500">
                  <Flame className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-white tracking-wide">EDL TOUCHDOWN EVALUATION</h2>
                  <p className="text-xs text-zinc-400 mt-1">Aero-braking → parachute → powered descent complete.</p>
                </div>

                <div className="grid grid-cols-3 gap-2.5 text-left">
                  <div className="bg-[#18181b] border border-zinc-800 p-2.5 rounded-xl">
                    <span className="text-[9px] text-zinc-400 block">TOUCHDOWN V</span>
                    <span className="text-sm font-bold text-white">{edlTelemetry.landingSpeed.toFixed(2)} m/s</span>
                    <span className="text-[8px] text-zinc-500">&lt; 2.5 m/s</span>
                  </div>
                  <div className="bg-[#18181b] border border-zinc-800 p-2.5 rounded-xl">
                    <span className="text-[9px] text-zinc-400 block">ACCURACY</span>
                    <span className="text-sm font-bold text-white">{edlTelemetry.landingAccuracy.toFixed(1)} m</span>
                    <span className="text-[8px] text-zinc-500">&lt; 50 m</span>
                  </div>
                  <div className="bg-[#18181b] border border-zinc-800 p-2.5 rounded-xl">
                    <span className="text-[9px] text-zinc-400 block">PEAK G</span>
                    <span className="text-sm font-bold text-white">{edlTelemetry.maxGForce.toFixed(2)} G</span>
                    <span className="text-[8px] text-zinc-500">&lt; 5 G</span>
                  </div>
                </div>

                <div className={`rounded-xl border p-2.5 text-xs font-black ${
                  edlTelemetry.landingVerified
                    ? 'border-emerald-700/60 bg-emerald-950/20 text-emerald-400'
                    : 'border-orange-800/60 bg-orange-950/20 text-orange-400'
                }`}>
                  {edlTelemetry.landingVerified
                    ? 'EDL SUCCESS — TOUCHDOWN CRITERIA PASSED'
                    : 'EDL REVIEW — ONE OR MORE CRITERIA FAILED'}
                </div>

                <button
                  onClick={() => setShowSummaryModal(false)}
                  className="w-full py-3 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold rounded-xl text-xs transition shadow-lg flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" /> CONTINUE TO ROVER
                </button>
              </>
            ) : (
              <>
                <div className="w-16 h-16 bg-zinc-900 border border-blue-500/50 rounded-2xl flex items-center justify-center mx-auto text-blue-400">
                  <Award className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="text-lg font-black text-white tracking-wide">MISSION SUCCESSFUL</h2>
                  <p className="text-xs text-zinc-400 mt-1">All queued waypoints executed autonomously.</p>
                </div>

                <div className="grid grid-cols-3 gap-3 text-left">
                  <div className="bg-[#18181b] border border-zinc-800 p-3 rounded-xl">
                    <span className="text-[10px] text-zinc-400 block">DISTANCE</span>
                    <span className="text-sm font-bold text-white">{marsTelemetry.distanceTraveled.toFixed(1)}m</span>
                  </div>
                  <div className="bg-[#18181b] border border-zinc-800 p-3 rounded-xl">
                    <span className="text-[10px] text-zinc-400 block">AVOIDED</span>
                    <span className="text-sm font-bold text-blue-400">{marsTelemetry.obstaclesAvoided} hazards</span>
                  </div>
                  <div className="bg-[#18181b] border border-zinc-800 p-3 rounded-xl">
                    <span className="text-[10px] text-zinc-400 block">REMAINING</span>
                    <span className="text-sm font-bold text-zinc-200">{battery.toFixed(0)}% batt</span>
                  </div>
                </div>

                <button
                  onClick={() => setShowSummaryModal(false)}
                  className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold rounded-xl text-xs transition shadow-lg flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" /> CONTINUE EXPLORATION
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}