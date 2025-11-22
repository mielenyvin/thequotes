// main.js

import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';

const bodies = [];
let physicsEnabled = false;
let nextBodyId = 1;
const bodyById = new Map();
let colorTransferEnabled = false;
let playPauseButton = null;


function registerBody(body) {
  body.id = nextBodyId++;
  bodyById.set(body.id, body);
  return body;
}

function addBodyEntry(body) {
  registerBody(body);
  body.isMagnetAnchored = false;
  bodies.push(body);
  return body;
}


let worldBoundsX = 4;
let worldBoundsY = 2.2;

// Global reference to current THREE.Scene

let sceneRef = null;
const CANVAS_BACKGROUND_COLOR = '#111111';
const BASE_LINEAR_DAMPING = 0.998;
const BASE_ANGULAR_DAMPING = 0.99;
const FLUID_LINEAR_VISCOSITY = 1.2; // higher → more drag per second
const FLUID_ANGULAR_VISCOSITY = 0.8;

// Color presets: exactly 10 colors for the whole composition.
const COLOR_PRESETS = [
  { kind: 'solid', color: '#cf4c46' },
  { kind: 'gradient', from: '#e0198dff', to: '#ffd24dff' },
  { kind: 'gradient', from: '#f36ff6ff', to: '#001d9cff' },
  { kind: 'solid', color: '#2e2e3c' },
  { kind: 'gradient', from: '#f60921', to: '#e021ba' },
  { kind: 'solid', color: '#e02623' },
  { kind: 'gradient', from: '#e3d403ff', to: '#1b0c7bff' },
  { kind: 'gradient', from: '#4694d2', to: '#1730a9ff' },
  { kind: 'gradient', from: '#722000ff', to: '#ffff00' },
  { kind: 'gradient', from: '#1b107eff', to: '#586cad' }
];

// Normalize hex colors like #rrggbbaa to #rrggbb.
function toOpaqueHex(col) {
  if (typeof col === 'string' && col.startsWith('#') && col.length === 9) {
    return col.slice(0, 7);
  }
  return col;
}

// --- Polygon math helpers (global scope) ---
function transformVerts(localVerts, posX, posY, rot) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const verts = [];
  for (const v of localVerts) {
    const x = v.x * cos - v.y * sin + posX;
    const y = v.x * sin + v.y * cos + posY;
    verts.push({ x, y });
  }
  return verts;
}

function getWorldVertices(body) {
  return transformVerts(
    body.localVerts,
    body.mesh.position.x,
    body.mesh.position.y,
    body.mesh.rotation.z
  );
}

function projectOntoAxis(verts, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of verts) {
    const p = v.x * axis.x + v.y * axis.y;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return { min, max };
}

function isSquareBody(body) {
  if (!body || body.shapeType !== 'rect' || !body.localVerts) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of body.localVerts) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return ratio > 0.9 && ratio < 1.1;
}

function isRectBody(body) {
  return !!body && body.shapeType === 'rect' && !isSquareBody(body);
}

function overlapIntervals(a, b) {
  return Math.min(a.max, b.max) - Math.max(a.min, b.min);
}

function polygonPolygonSAT(vertsA, vertsB) {
  let minOverlap = Infinity;
  let bestAxis = null;

  function checkAxes(verts1, verts2) {
    for (let i = 0; i < verts1.length; i++) {
      const j = (i + 1) % verts1.length;
      const edge = {
        x: verts1[j].x - verts1[i].x,
        y: verts1[j].y - verts1[i].y
      };
      let axis = { x: -edge.y, y: edge.x };
      const len = Math.hypot(axis.x, axis.y);
      if (len === 0) continue;
      axis.x /= len;
      axis.y /= len;

      const projA = projectOntoAxis(vertsA, axis);
      const projB = projectOntoAxis(vertsB, axis);
      const o = overlapIntervals(projA, projB);

      if (o <= 0) {
        return false;
      }

      if (o < minOverlap) {
        minOverlap = o;
        bestAxis = { x: axis.x, y: axis.y };
      }
    }
    return true;
  }

  if (!checkAxes(vertsA, vertsB)) return null;
  if (!checkAxes(vertsB, vertsA)) return null;

  return { normal: bestAxis, depth: minOverlap };
}


function normalizeAngle(angle) {
  const twoPi = Math.PI * 2;
  return ((angle + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

function gentlyNudgeBodyToward(body, target, maxStep = 0.1) {
  if (!body || !target || body === target) return false;
  const dx = target.mesh.position.x - body.mesh.position.x;
  const dy = target.mesh.position.y - body.mesh.position.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-5) return false;

  const dirX = dx / dist;
  const dirY = dy / dist;

  const radiusSelf = getSupportRadius(body, dirX, dirY);
  const radiusTarget = getSupportRadius(target, -dirX, -dirY);
  const idealDist = radiusSelf + radiusTarget;
  const desiredDist = idealDist - Math.min(radiusSelf, radiusTarget) * 0.05;
  const diff = dist - desiredDist;
  if (diff <= 0) return true;

  const step = Math.min(diff, maxStep);
  body.mesh.position.x += dirX * step;
  body.mesh.position.y += dirY * step;

  const clampR = body.boundingRadius || 0;
  body.mesh.position.x = Math.max(
    -worldBoundsX + clampR,
    Math.min(worldBoundsX - clampR, body.mesh.position.x)
  );
  body.mesh.position.y = Math.max(
    -worldBoundsY + clampR,
    Math.min(worldBoundsY - clampR, body.mesh.position.y)
  );

  if (body.velocity) {
    body.velocity.multiplyScalar(0.3);
  }
  return true;
}



// Support radius of a body along a given (normalized) direction.
// Возвращает расстояние от центра фигуры до самой "дальней" точки по направлению (dirX, dirY),
// с учётом текущего поворота и позиции.
function getSupportRadius(body, dirX, dirY) {
  const verts = getWorldVertices(body);
  const centerProj = body.mesh.position.x * dirX + body.mesh.position.y * dirY;
  let radius = 0;
  for (const v of verts) {
    const p = v.x * dirX + v.y * dirY;
    const d = Math.abs(p - centerProj);
    if (d > radius) radius = d;
  }
  return radius;
}


// Simple deterministic RNG (Mulberry32)
function createRng(seedStr) {
  // Convert string seed to 32-bit integer
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }

  return function mulberry32() {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setPhysicsEnabled(enabled) {
  physicsEnabled = enabled;

  // Обновляем иконку Play/Pause, если кнопка уже создана
  if (playPauseButton) {
    playPauseButton.textContent = physicsEnabled ? '⏸' : '▶';
  }
}

function applyPlayImpulse() {
  // Каждый раз, когда нажимается "Play", даём всем фигурам новый импульс.
  for (const body of bodies) {
    if (!body.velocity) continue;
    if (body.isDragged) continue;

    const angle = Math.random() * Math.PI * 2;
    const baseSpeed = 0.8 + Math.random() * 1.2;
    const speedScale = body.speedScale || 1;
    const speedVal = baseSpeed * speedScale;

    body.velocity.set(Math.cos(angle) * speedVal, Math.sin(angle) * speedVal);

    if (body.shapeType === 'rect' || body.shapeType === 'tri' || body.shapeType === 'circle') {
      const spinBase = 0.6;
      body.angularVelocity = (Math.random() - 0.5) * spinBase * speedScale;
    }
  }
}

function regenerateComposition(seed) {
  if (!sceneRef) {
    return;
  }

  // Create a new RNG for this seed
  const rng = createRng(seed);

  // Remove old shape meshes from the scene
  for (const body of bodies) {
    if (body.mesh && body.mesh.parent) {
      body.mesh.parent.remove(body.mesh);
    }
  }

  // Clear physics bodies and disable physics while we rebuild
  bodies.length = 0;
  setPhysicsEnabled(false);
  bodyById.clear();
  nextBodyId = 1;

  // Recreate shapes in the existing scene with the new RNG
  createShapes(rng, sceneRef);
}

function getSeed() {
  // Всегда генерируем новый seed при загрузке страницы,
  // без записи его в адресную строку.
  return Math.random().toString(36).slice(2, 10);
}

function createGradientTexture(colorStart, colorEnd) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Градиент идёт от левой стороны к правой, а не из угла в угол.
  const grad = ctx.createLinearGradient(0, 0, size, 0);
  grad.addColorStop(0, colorStart);
  grad.addColorStop(1, colorEnd);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createCornerGradientTexture(colorStart, colorEnd) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Градиент, который "исходит" из одного угла (радиальный из угла по диагонали).
  const grad = ctx.createRadialGradient(0, size, 0, 0, size, size);
  grad.addColorStop(0, colorStart);
  grad.addColorStop(1, colorEnd);

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createShapes(rng, scene) {
  const baseBoundsX = 4;
  const baseBoundsY = 2.2;
  // Фигуры всегда в "эталонном" масштабе, не уменьшаем их на маленьких экранах.
  // Если разместить все фигуры без пересечений нельзя, часть фигур будет пропущена в placeMesh.
  const scale = 1.0;

  function randomColor() {
    const h = rng();
    const s = 0.5 + rng() * 0.3;
    const l = 0.45 + rng() * 0.2;
    return new THREE.Color().setHSL(h, s, l);
  }

  function randomVelocity(speedScale = 1) {
    const angle = rng() * Math.PI * 2;
    const baseSpeed = (0.4 + rng() * 0.6) * 2; // ~2..5 units per second
    const speed = baseSpeed * speedScale;
    return new THREE.Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  // Копия списка индексов цветов для текущей композиции.
  // Каждый пресет будет использован не больше одного раза.
  let availablePresetIndices = COLOR_PRESETS.map((_, idx) => idx);

  function takePresetIndex() {
    if (availablePresetIndices.length === 0) {
      console.warn('No color presets left - this should not happen if shapes === presets');
      // На всякий случай возвращаем первый индекс,
      // но при нормальной работе сюда не попадаем.
      return 0;
    }
    const idx = Math.floor(rng() * availablePresetIndices.length);
    const [presetIndex] = availablePresetIndices.splice(idx, 1);
    return presetIndex;
  }

  // Старый pickPreset больше не нужен, но оставим на случай будущего использования
  function pickPreset(list) {
    if (!list || list.length === 0) return null;
    const idx = Math.floor(rng() * list.length);
    return list[idx];
  }


  function makeMaterialFromPreset(preset) {
    // Helper to create a solid MeshBasicMaterial with remembered baseColor
    function makeSolid(color) {
      const col = color instanceof THREE.Color ? color : new THREE.Color(color);
      const mat = new THREE.MeshBasicMaterial({ color: col });
      if (!mat.userData) mat.userData = {};
      mat.userData.baseColor = col.clone();
      return mat;
    }

    if (!preset) {
      // No preset: random HSL solid
      const col = randomColor();
      return makeSolid(col);
    }

    if (preset.kind === 'solid') {
      // Обрезаем возможную альфу #rrggbbaa -> #rrggbb
      const hex = toOpaqueHex(preset.color);
      return makeSolid(hex);
    }

    if (preset.kind === 'gradient') {
      const mat = new THREE.MeshBasicMaterial({
        map: createGradientTexture(preset.from, preset.to)
      });
      if (!mat.userData) mat.userData = {};
      // В качестве базового цвета берём начало градиента (обрезаем альфу).
      mat.userData.baseColor = new THREE.Color(toOpaqueHex(preset.from));
      return mat;
    }

    if (preset.kind === 'randomHsl') {
      const col = randomColor();
      return makeSolid(col);
    }

    // Fallback
    const col = randomColor();
    return makeSolid(col);
  }

  function placeMesh(mesh, boundingRadius, localVerts, shapeType, contactRadius, colorIndex) {
    if (contactRadius === undefined || contactRadius === null) {
      contactRadius = boundingRadius;
    }

    // First shape goes to the center if it fits
    if (bodies.length === 0) {
      const x = 0;
      const y = 0;

      if (
        x - boundingRadius < -worldBoundsX ||
        x + boundingRadius > worldBoundsX ||
        y - boundingRadius < -worldBoundsY ||
        y + boundingRadius > worldBoundsY
      ) {
        console.warn('First shape does not fit into world bounds');
        return false;
      }

      mesh.position.set(x, y, 0);
      const mass = boundingRadius * boundingRadius;
      addBodyEntry({
        mesh,
        localVerts,
        boundingRadius,
        contactRadius,
        mass,
        invMass: 1 / mass,
        velocity: new THREE.Vector2(0, 0),
        angularVelocity: 0,
        shapeType,
        colorIndex
      });
      return true;
    }

    // Special case: third circle must touch the first two circles simultaneously
    // *without* moving the first two. We try to find a point that is tangent
    // to both existing circles in their current positions. If такое положение
    // существует и помещается в экран, просто ставим туда третий круг.
    if (
      shapeType === 'circle' &&
      bodies.length === 2 &&
      bodies[0].shapeType === 'circle' &&
      bodies[1].shapeType === 'circle'
    ) {
      const a = bodies[0];
      const b = bodies[1];

      const ax = a.mesh.position.x;
      const ay = a.mesh.position.y;
      const bx = b.mesh.position.x;
      const by = b.mesh.position.y;

      const r1 = a.contactRadius;
      const r2 = b.contactRadius;
      const r3 = contactRadius;

      const dx = bx - ax;
      const dy = by - ay;
      const d = Math.hypot(dx, dy);

      if (d > 1e-6) {
        const RA = r1 + r3;
        const RB = r2 + r3;

        // Проверяем, существуют ли точки пересечения окружностей
        if (d <= RA + RB && d >= Math.abs(RA - RB)) {
          const ex = dx / d;
          const ey = dy / d;

          const aLen = (RA * RA - RB * RB + d * d) / (2 * d);
          const h2 = RA * RA - aLen * aLen;

          if (h2 >= 0) {
            const h = Math.sqrt(h2);
            const x0 = ax + ex * aLen;
            const y0 = ay + ey * aLen;

            // Две возможные точки; рассматриваем обе
            const candidatesCenters = [
              { x: x0 - ey * h, y: y0 + ex * h },
              { x: x0 + ey * h, y: y0 - ex * h }
            ];

            const marginLocal = 0.001;
            const eps1 = (r1 + r3) * 0.04;
            const eps2 = (r2 + r3) * 0.04;

            for (const c of candidatesCenters) {
              // Границы экрана с учётом радиуса третьего круга
              if (
                c.x - r3 < -worldBoundsX + marginLocal ||
                c.x + r3 > worldBoundsX - marginLocal ||
                c.y - r3 < -worldBoundsY + marginLocal ||
                c.y + r3 > worldBoundsY - marginLocal
              ) {
                continue;
              }

              // Проверяем, что мы действительно касаемся обоих кругов (с небольшим допуском)
              const d1 = Math.hypot(c.x - ax, c.y - ay);
              const d2 = Math.hypot(c.x - bx, c.y - by);
              const ideal1 = r1 + r3;
              const ideal2 = r2 + r3;

              if (Math.abs(d1 - ideal1) > eps1 || Math.abs(d2 - ideal2) > eps2) {
                continue;
              }

              // Всё ок: ставим третий круг сюда и не трогаем первые два
              mesh.position.set(c.x, c.y, 0);
              const mass = boundingRadius * boundingRadius;
              addBodyEntry({
                mesh,
                localVerts,
                boundingRadius,
                contactRadius,
                mass,
                invMass: 1 / mass,
                velocity: new THREE.Vector2(0, 0),
                angularVelocity: 0,
                shapeType,
                colorIndex
              });
              return true;
            }
          }
        }
      }
      // Если подходящей точки нет, переходим к общей логике ниже.
    }

    const margin = 0.001;
    const contactToleranceFactor = 0.03; // how close radii must be to count as a contact

    function evaluateCandidate(x, y) {
      // Transform candidate vertices into world space with current rotation
      const candidateVerts = transformVerts(localVerts, x, y, mesh.rotation.z);

      // Bounds check by vertices
      for (const v of candidateVerts) {
        if (
          v.x < -worldBoundsX + margin ||
          v.x > worldBoundsX - margin ||
          v.y < -worldBoundsY + margin ||
          v.y > worldBoundsY - margin
        ) {
          return null;
        }
      }

      // Intersection test with all existing bodies
      for (const body of bodies) {
        // Special case: circle–circle placement.
        // We treat them as perfect circles by center distance and allow a tiny overlap tolerance,
        // so что бы третий круг мог касаться сразу первого и второго.
        if (shapeType === 'circle' && body.shapeType === 'circle') {
          const dx = body.mesh.position.x - x;
          const dy = body.mesh.position.y - y;
          const d = Math.hypot(dx, dy);
          const ideal = body.contactRadius + contactRadius;
          const eps = ideal * 0.03; // allow ~3% tolerance
          // Too much intersection – отвергаем
          if (d < ideal - eps) {
            return null;
          }
          // Если чуть-чуть ближе/дальше – допускаем, SAT-проверку для кругов пропускаем
          continue;
        }

        // General case: SAT for arbitrary convex polygons,
        // но с небольшим допуском по глубине пересечения.
        const bodyVerts = getWorldVertices(body);
        const result = polygonPolygonSAT(bodyVerts, candidateVerts);
        if (result && result.depth > 0.002) {
          return null;
        }
      }

      // Compute how many bodies we are tangent to and how good the fit is
      let contacts = 0;
      let minCenterDist = Infinity;
      let minGap = Infinity;

      for (const body of bodies) {
        const dx = body.mesh.position.x - x;
        const dy = body.mesh.position.y - y;
        const d = Math.hypot(dx, dy);

        if (d < minCenterDist) {
          minCenterDist = d;
        }

        const idealContact = body.contactRadius + contactRadius;
        const gapAbs = Math.abs(d - idealContact);

        // Count as contact if distance is close to ideal contact distance
        if (gapAbs <= idealContact * contactToleranceFactor) {
          contacts++;
        }

        if (gapAbs < minGap) {
          minGap = gapAbs;
        }
      }

      const idealGap = 0.0003;
      const gapScore = Math.abs(minGap - idealGap);
      const candidateScore = gapScore + minCenterDist * 0.02;

      return {
        x,
        y,
        contacts,
        score: candidateScore
      };
    }

    const candidates = [];

    // 1) Prefer positions where the new shape is tangent to TWO existing shapes
    if (bodies.length >= 2) {
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];

          const ax = a.mesh.position.x;
          const ay = a.mesh.position.y;
          const bx = b.mesh.position.x;
          const by = b.mesh.position.y;

          const dx = bx - ax;
          const dy = by - ay;
          const d = Math.hypot(dx, dy);
          if (d === 0) continue;

          const RA = a.contactRadius + contactRadius;
          const RB = b.contactRadius + contactRadius;

          // Circle-circle intersection check
          if (d > RA + RB || d < Math.abs(RA - RB)) {
            continue;
          }

          // Compute intersection points of two circles
          const ex = dx / d;
          const ey = dy / d;

          const aLen = (RA * RA - RB * RB + d * d) / (2 * d);
          const h2 = RA * RA - aLen * aLen;
          if (h2 < 0) continue;
          const h = Math.sqrt(h2);

          const x0 = ax + ex * aLen;
          const y0 = ay + ey * aLen;

          const rx = -ey * h;
          const ry = ex * h;

          const p1 = evaluateCandidate(x0 + rx, y0 + ry);
          if (p1) {
            candidates.push(p1);
          }
          const p2 = evaluateCandidate(x0 - rx, y0 - ry);
          if (p2) {
            candidates.push(p2);
          }
        }
      }
    }

    // 2) Fallback: positions tangent to ONE existing shape (on a circle around it)
    if (candidates.length === 0) {
      const samplesPerBody = 96;
      for (const body of bodies) {
        const centerX = body.mesh.position.x;
        const centerY = body.mesh.position.y;
        const R = body.contactRadius + contactRadius;

        for (let k = 0; k < samplesPerBody; k++) {
          const angle = (2 * Math.PI * k) / samplesPerBody;
          const x = centerX + Math.cos(angle) * R;
          const y = centerY + Math.sin(angle) * R;
          const candidate = evaluateCandidate(x, y);
          if (candidate) {
            candidates.push(candidate);
          }
        }
      }
    }

    // 3) Last-resort fallback: dense grid search (may not give perfect tangency,
    // but still tries to pack shapes tightly if no tangent position exists)
    if (candidates.length === 0) {
      const step = contactRadius * 0.6;
      for (let y = -worldBoundsY + contactRadius; y <= worldBoundsY - contactRadius; y += step) {
        for (let x = -worldBoundsX + contactRadius; x <= worldBoundsX - contactRadius; x += step) {
          const candidate = evaluateCandidate(x, y);
          if (candidate) {
            candidates.push(candidate);
          }
        }
      }
    }

    if (candidates.length === 0) {
      console.warn('No space left for this shape');
      return false;
    }

    // Choose best candidate: maximize number of contacts first, then minimize score
    let maxContacts = 0;
    for (const c of candidates) {
      if (c.contacts > maxContacts) {
        maxContacts = c.contacts;
      }
    }

    let requiredContacts = 1;
    if (bodies.length >= 2 && maxContacts >= 2) {
      requiredContacts = 2;
    }

    let bestCandidate = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      if (c.contacts < requiredContacts) continue;
      if (c.score < bestScore) {
        bestScore = c.score;
        bestCandidate = c;
      }
    }

    // If for some reason nothing matched requiredContacts, fall back to any best
    if (!bestCandidate) {
      for (const c of candidates) {
        if (c.score < bestScore) {
          bestScore = c.score;
          bestCandidate = c;
        }
      }
    }

    if (!bestCandidate) {
      console.warn('No space left for this shape (after filtering)');
      return false;
    }

    mesh.position.set(bestCandidate.x, bestCandidate.y, 0);
    const mass = boundingRadius * boundingRadius;
      addBodyEntry({
        mesh,
        localVerts,
        boundingRadius,
        contactRadius,
      mass,
      invMass: 1 / mass,
      velocity: new THREE.Vector2(0, 0),
      angularVelocity: 0,
      shapeType,
      colorIndex
    });
    return true;
  }

  function addCircle(radius) {
    const physicalRadius = radius * scale;
    const geo = new THREE.CircleGeometry(physicalRadius, 64);
    // Берём один из доступных пресетов и убираем его из пула
    const presetIndex = takePresetIndex();
    const preset = COLOR_PRESETS[presetIndex];
    // Для кругов снова разрешаем любые материалы из пресета, включая градиенты.
    const mat = makeMaterialFromPreset(preset);

    const mesh = new THREE.Mesh(geo, mat);

    // Аппроксимация круга выпуклым многоугольником
    const segments = 20;
    const localVerts = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      localVerts.push({
        x: Math.cos(angle) * physicalRadius,
        y: Math.sin(angle) * physicalRadius
      });
    }
    const boundingRadius = physicalRadius;
    const contactRadius = boundingRadius;

    const success = placeMesh(mesh, boundingRadius, localVerts, 'circle', contactRadius, presetIndex);
    if (!success) {
      console.warn('Could not place circle');
      return;
    }
    scene.add(mesh);
  }

  function addRect(width, height, isSquare = false) {
    const physicalWidth = width * scale;
    const physicalHeight = height * scale;
    const geo = new THREE.PlaneGeometry(physicalWidth, physicalHeight);

    const presetIndex = takePresetIndex();
    const preset = COLOR_PRESETS[presetIndex];
    const mat = makeMaterialFromPreset(preset);
    const mesh = new THREE.Mesh(geo, mat);

    // Вершины прямоугольника в локальных координатах
    const hw = physicalWidth * 0.5;
    const hh = physicalHeight * 0.5;
    const localVerts = [
      { x: -hw, y: -hh },
      { x: hw,  y: -hh },
      { x: hw,  y: hh },
      { x: -hw, y: hh }
    ];

    let boundingRadius = 0;
    for (const v of localVerts) {
      const r = Math.hypot(v.x, v.y);
      if (r > boundingRadius) boundingRadius = r;
    }
    const minHalfExtent = Math.min(hw, hh);
    // Используем более «интерьерный» радиус для всех прямоугольников и квадратов,
    // чтобы при размещении они не просто касались по диагонали баундинг-окружностей,
    // а стремились примыкать гранями — как будто «примагничиваются».
    const contactRadius = minHalfExtent * 0.7;

    const maxAttempts = 12;
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Пробуем разные повороты, чтобы найти конфигурацию,
      // где прямоугольник плотно «примагничивается» сразу к нескольким фигурам.
      mesh.rotation.z = rng() * Math.PI * 2;
      if (placeMesh(mesh, boundingRadius, localVerts, 'rect', contactRadius, presetIndex)) {
        placed = true;
        break;
      }
    }

    if (!placed) {
      console.warn('Could not place rect');
      return;
    }

    scene.add(mesh);
  }

  function addTriangle(size) {
    const physicalSize = size * scale;

    // Локальные вершины равностороннего треугольника
    const localVerts = [
      { x: 0, y: physicalSize }, // "угол-источник" градиента
      { x: -physicalSize * 0.866, y: -physicalSize * 0.5 },
      { x: physicalSize * 0.866,  y: -physicalSize * 0.5 }
    ];

    // Геометрия треугольника как один примитив из 3 вершин
    const vertices = new Float32Array([
      localVerts[0].x, localVerts[0].y, 0,
      localVerts[1].x, localVerts[1].y, 0,
      localVerts[2].x, localVerts[2].y, 0
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.computeVertexNormals();

    // Берём пресет из общего пула без повторов
    const presetIndex = takePresetIndex();
    const preset = COLOR_PRESETS[presetIndex];

    // Для треугольников ВСЕГДА используем градиент,
    // который исходит из одного угла (первой вершины).
    let fromColor;
    let toColor;

    if (preset && preset.kind === 'gradient') {
      fromColor = preset.from;
      toColor = preset.to;
    } else if (preset && preset.kind === 'solid') {
      // Строим градиент на основе одного цвета: второй немного темнее/светлее.
      const base = new THREE.Color(preset.color);
      const c1 = base.clone();
      const c2 = base.clone();
      c2.offsetHSL(0, 0, -0.15);
      fromColor = '#' + c1.getHexString();
      toColor = '#' + c2.getHexString();
    } else {
      // Любые другие варианты (randomHsl и т.п.) — случайный HSL-градиент.
      const c1 = randomColor();
      const c2 = c1.clone();
      c2.offsetHSL(0, 0, -0.18);
      fromColor = '#' + c1.getHexString();
      toColor = '#' + c2.getHexString();
    }

    // Normalize 8-char #rrggbbaa colors to #rrggbb before creating THREE.Color
    fromColor = toOpaqueHex(fromColor);
    toColor = toOpaqueHex(toColor);
    const cStart = new THREE.Color(fromColor);
    const cEnd = new THREE.Color(toColor);
    const cMid = cStart.clone().lerp(cEnd, 0.5);

    // Градиент идёт от первой вершины (источник) к противоположной стороне,
    // при этом только один угол имеет чистый "конечный" цвет.
    const colors = new Float32Array([
      cStart.r, cStart.g, cStart.b, // вершина-источник
      cMid.r,   cMid.g,   cMid.b,   // промежуточный цвет
      cEnd.r,   cEnd.g,   cEnd.b    // только один угол с чистым конечным цветом
    ]);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    if (!mat.userData) mat.userData = {};
    // Базовый цвет для "передачи" считаем цветом источника градиента
    mat.userData.baseColor = cStart.clone();
    const mesh = new THREE.Mesh(geo, mat);

    let boundingRadius = 0;
    for (const v of localVerts) {
      const r = Math.hypot(v.x, v.y);
      if (r > boundingRadius) boundingRadius = r;
    }
    // Для треугольника берём слегка уменьшенный контактный радиус,
    // чтобы он мог плотнее «прижиматься» к другим фигурам, а пересечения
    // всё равно отсекаются SAT-проверкой.
    const contactRadius = boundingRadius * 0.6;

    // Делаем несколько попыток с разными поворотами, чтобы треугольник
    // почти всегда находил свободное место, если оно визуально есть.
    const maxAttempts = 10;
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      mesh.rotation.z = rng() * Math.PI * 2;
      if (placeMesh(mesh, boundingRadius, localVerts, 'tri', contactRadius, presetIndex)) {
        placed = true;
        break;
      }
    }

    if (!placed) {
      console.warn('Could not place triangle');
      return;
    }

    scene.add(mesh);
  }

  function addSquare(size) {
    addRect(size, size, true);
  }

  // Сначала добавляем более маленькие фигуры, затем крупные,
  // чтобы при нехватке места в первую очередь сохранялись маленькие.

  // Малые круг и квадрат
  addCircle(0.3);
  addSquare(0.3);

  // Малый треугольник
  addTriangle(0.3);

  // Более «лёгкий» по площади прямоугольник (1.8 * 0.25 = 0.45)
  addRect(1, 0.2);  // очень тонкий и длинный

  // Средние фигуры
  addCircle(0.65);
  addSquare(0.8);

  // Более «тяжёлый» прямоугольник (1.4 * 0.5 = 0.7)
  addRect(1, 0.4); 

  // Крупные фигуры
  addTriangle(1);
  addCircle(0.8);
  addSquare(1.2);

  // После того как все фигуры созданы и "примагничены" placeMesh,
  // сразу запускаем физику и даём им стартовое движение.
  setPhysicsEnabled(true);

  for (const body of bodies) {
    const r = body.boundingRadius;
    const sizeNorm = Math.max(0.3, r);
    const speedScale = 1.8 / (0.6 + sizeNorm);
    body.speedScale = speedScale;

    if (!body.velocity || (body.velocity.x === 0 && body.velocity.y === 0)) {
      body.velocity = randomVelocity(speedScale);
    }

    const spinBase =
      body.shapeType === 'rect' ||
      body.shapeType === 'tri' ||
      body.shapeType === 'circle'
        ? 0.8
        : 0.4;
    const spinScale = speedScale * 1.1;
    body.angularVelocity = (rng() - 0.5) * spinBase * spinScale;
  }
}
// Helper: apply color preset to an existing body (by colorIndex)
function applyColorPresetToBody(body) {
  const presetIndex = body.colorIndex;
  if (presetIndex === undefined || presetIndex === null) return;
  const preset = COLOR_PRESETS[presetIndex];
  if (!preset) return;

  // Треугольники рисуем своим градиентом "из угла".
  if (body.shapeType === 'tri') {
    let fromColor;
    let toColor;

    if (preset.kind === 'gradient') {
      fromColor = preset.from;
      toColor = preset.to;
    } else if (preset.kind === 'solid') {
      const base = new THREE.Color(preset.color);
      const c1 = base.clone();
      const c2 = base.clone();
      c2.offsetHSL(0, 0, -0.15);
      fromColor = '#' + c1.getHexString();
      toColor = '#' + c2.getHexString();
    } else {
      // fallback, не должен использоваться с текущим набором пресетов
      fromColor = '#ffffff';
      toColor = '#000000';
    }

    fromColor = toOpaqueHex(fromColor);
    toColor = toOpaqueHex(toColor);
    const cStart = new THREE.Color(fromColor);
    const cEnd = new THREE.Color(toColor);
    const cMid = cStart.clone().lerp(cEnd, 0.5);

    const colors = new Float32Array([
      cStart.r, cStart.g, cStart.b,
      cMid.r,   cMid.g,   cMid.b,
      cEnd.r,   cEnd.g,   cEnd.b
    ]);

    const geo = body.mesh.geometry;
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    mat.userData = { baseColor: cStart.clone() };
    body.mesh.material = mat;
    return;
  }

  // Для кругов и прямоугольников вручную создаём материал по пресету
  let mat;
  if (preset.kind === 'solid') {
    const hex = toOpaqueHex(preset.color);
    const col = new THREE.Color(hex);
    mat = new THREE.MeshBasicMaterial({ color: col });
    mat.userData = { baseColor: col.clone() };
  } else if (preset.kind === 'gradient') {
    const tex = createGradientTexture(preset.from, preset.to);
    mat = new THREE.MeshBasicMaterial({ map: tex });
    mat.userData = { baseColor: new THREE.Color(toOpaqueHex(preset.from)) };
  } else {
    // Fallback: простой белый цвет, на текущем наборе пресетов сюда попадать не должны.
    const col = new THREE.Color('#ffffff');
    mat = new THREE.MeshBasicMaterial({ color: col });
    mat.userData = { baseColor: col.clone() };
  }
  body.mesh.material = mat;
}

  function createScene(seed) {
  function transferColorOnCollision(a, b) {
    // При столкновении фигуры ОБМЕНИВАЮТСЯ своими цветами (пресетами),
    // так что общее количество цветов остаётся тем же (10).
    if (a.colorIndex === undefined || b.colorIndex === undefined) return;
    const tmp = a.colorIndex;
    a.colorIndex = b.colorIndex;
    b.colorIndex = tmp;

    applyColorPresetToBody(a);
    applyColorPresetToBody(b);
  }
  const canvas = document.getElementById('app');
  // Disable text selection and touch callouts on the canvas (mobile Safari etc.)
  if (canvas && canvas.style) {
    canvas.style.userSelect = 'none';
    canvas.style.webkitUserSelect = 'none';
    canvas.style.MozUserSelect = 'none';
    canvas.style.msUserSelect = 'none';
    canvas.style.webkitTouchCallout = 'none';
    canvas.style.WebkitTapHighlightColor = 'transparent';
  }
  // --- Pointer drag interaction state and helpers ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const dragIntersect = new THREE.Vector3();
  let draggedBody = null;
  let lastDragPos = null;

  function screenToNdc(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickBodyAt(clientX, clientY) {
    screenToNdc(clientX, clientY);
    raycaster.setFromCamera(pointer, camera);
    const meshes = bodies.map(b => b.mesh);
    const intersects = raycaster.intersectObjects(meshes, false);
    if (!intersects.length) return null;
    const mesh = intersects[0].object;
    for (const body of bodies) {
      if (body.mesh === mesh) return { body, point: intersects[0].point.clone() };
    }
    return null;
  }

  function clampBodyToWorld(body) {
    const r = body.boundingRadius || 0;
    body.mesh.position.x = Math.max(
      -worldBoundsX + r,
      Math.min(worldBoundsX - r, body.mesh.position.x)
    );
    body.mesh.position.y = Math.max(
      -worldBoundsY + r,
      Math.min(worldBoundsY - r, body.mesh.position.y)
    );
  }
  const rng = createRng(seed);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Явно задаём цвет и непрозрачность фона, чтобы при сохранении не было прозрачности
  renderer.setClearColor(CANVAS_BACKGROUND_COLOR, 1);

  const scene = new THREE.Scene();
  sceneRef = scene;
  scene.background = new THREE.Color(CANVAS_BACKGROUND_COLOR);

  const camera = new THREE.PerspectiveCamera(
    35,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 7);
  camera.lookAt(0, 0, 0);

  function updateWorldBounds() {
    // вычисляем видимую область в мировых координатах и даём немного отступа
    const vFov = (camera.fov * Math.PI) / 180;
    const halfHeight = Math.tan(vFov / 2) * camera.position.z;
    const halfWidth = halfHeight * camera.aspect;
    worldBoundsX = halfWidth * 1.0;
    worldBoundsY = halfHeight * 1.0;
  }

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(3, 5, 2);
  scene.add(dirLight);

  const rimLight = new THREE.DirectionalLight(0xffb3a7, 0.4);
  rimLight.position.set(-4, 3, -2);
  scene.add(rimLight);

  updateWorldBounds();
  createShapes(rng, scene);

  // --- Pointer drag event listeners ---
  const shapeTouchIds = new Set();
  const canvasTouchInfo = new Map();
  const UPWARD_SCROLL_THRESHOLD = 1;

  function beginTouchBlock(event) {
    if (!event.changedTouches || !event.changedTouches.length) return false;
    let shouldPrevent = false;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      const pick = pickBodyAt(touch.clientX, touch.clientY);
      if (pick) {
        shapeTouchIds.add(touch.identifier);
        shouldPrevent = true;
      }
    }

    return shouldPrevent;
  }

  function trackCanvasTouchStart(event) {
    if (!event.changedTouches) return;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (shapeTouchIds.has(touch.identifier)) {
        canvasTouchInfo.delete(touch.identifier);
        continue;
      }
      canvasTouchInfo.set(touch.identifier, { startY: touch.clientY });
    }
  }

  function preventUpwardCanvasPan(event) {
    if (!event.changedTouches) return;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (shapeTouchIds.has(touch.identifier)) continue;
      let info = canvasTouchInfo.get(touch.identifier);
      if (!info) {
        info = { startY: touch.clientY };
        canvasTouchInfo.set(touch.identifier, info);
      }
      const deltaY = touch.clientY - info.startY;
      if (deltaY < -UPWARD_SCROLL_THRESHOLD) {
        event.preventDefault();
        return;
      }
    }
  }

  function clearCanvasTouch(event) {
    if (!event.changedTouches) return;
    for (let i = 0; i < event.changedTouches.length; i++) {
      canvasTouchInfo.delete(event.changedTouches[i].identifier);
    }
  }

  function onTouchStart(event) {
    const blocked = beginTouchBlock(event);
    trackCanvasTouchStart(event);
    if (blocked) {
      event.preventDefault();
    }
  }

  function onTouchMove(event) {
    if (!event.changedTouches) return;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (shapeTouchIds.has(touch.identifier)) {
        event.preventDefault();
        return;
      }
    }
    preventUpwardCanvasPan(event);
  }

  function onTouchEnd(event) {
    if (!event.changedTouches) return;
    let hadShapeTouch = false;
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (shapeTouchIds.delete(touch.identifier)) {
        hadShapeTouch = true;
      }
    }
    clearCanvasTouch(event);
    if (hadShapeTouch) {
      event.preventDefault();
    }
  }

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  function onPointerDown(event) {
    const pick = pickBodyAt(event.clientX, event.clientY);
    if (!pick) return;

    event.preventDefault();

    draggedBody = pick.body;
    draggedBody.isDragged = true;
    if (draggedBody.velocity) {
      draggedBody.velocity.set(0, 0);
    }
    draggedBody.angularVelocity = 0;

    // Настраиваем плоскость перетаскивания (z=0 смотрит к камере)
    dragPlane.setFromNormalAndCoplanarPoint(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 0)
    );

    screenToNdc(event.clientX, event.clientY);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(dragPlane, dragIntersect)) {
      lastDragPos = dragIntersect.clone();
      const offset = dragIntersect.clone().sub(draggedBody.mesh.position);
      draggedBody._dragOffset = offset;
    }

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (e) {
      // ignore if not supported
    }
  }

  function onPointerMove(event) {
    if (!draggedBody) return;
    event.preventDefault();

    screenToNdc(event.clientX, event.clientY);
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, dragIntersect)) return;

    const offset = draggedBody._dragOffset || new THREE.Vector3();
    const newPos = dragIntersect.clone().sub(offset);

    if (lastDragPos && draggedBody.velocity) {
      // Оценка скорости движения пальца, но с заметно меньшим "ударом", чем у естественных столкновений
      const dx = newPos.x - lastDragPos.x;
      const dy = newPos.y - lastDragPos.y;
      const dragScale = 2; // существенно меньше, чем было (60), даёт более мягкий импульс
      let vx = dx * dragScale;
      let vy = dy * dragScale;

      // Дополнительно ограничиваем максимальную скорость от "броска" перетаскиванием
      const maxDragSpeed = 3.5;
      const len = Math.hypot(vx, vy);
      if (len > maxDragSpeed && len > 0) {
        const k = maxDragSpeed / len;
        vx *= k;
        vy *= k;
      }

      draggedBody.velocity.set(vx, vy);
    }

    draggedBody.mesh.position.copy(newPos);
    clampBodyToWorld(draggedBody);
    lastDragPos = newPos.clone();
  }

  function endDrag(event) {
    if (!draggedBody) return;
    event && event.preventDefault();
    draggedBody.isDragged = false;
    delete draggedBody._dragOffset;
    draggedBody = null;
    lastDragPos = null;
  }

  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('pointermove', onPointerMove, { passive: false });
  canvas.addEventListener('pointerup', endDrag, { passive: false });
  canvas.addEventListener('pointercancel', endDrag, { passive: false });

  // Simple animation
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateWorldBounds();
  }
  window.addEventListener('resize', onResize);

  let lastTime = null;
  let accumulator = 0;

  // (Deleted duplicate polygon helpers)

  function updatePhysics(dt) {
    const globalSpeedFactor = 1;
    if (!physicsEnabled) {
      return;
    }


    // Move bodies
    for (const body of bodies) {
      if (body.isDragged) {
        // Положение задаётся пальцем, только слегка гасим скорость
        if (body.velocity) {
          body.velocity.multiplyScalar(0.9);
        }
        continue;
      }
      // Integrate rotation
      if (body.angularVelocity) {
        body.mesh.rotation.z += body.angularVelocity * dt * globalSpeedFactor;
        const angDrag =
          BASE_ANGULAR_DAMPING * Math.exp(-FLUID_ANGULAR_VISCOSITY * dt);
        body.angularVelocity *= angDrag;
      }

      const linearDrag =
        BASE_LINEAR_DAMPING * Math.exp(-FLUID_LINEAR_VISCOSITY * dt);
      body.velocity.multiplyScalar(linearDrag);

      // Обновляем позицию и отскоки от стен
      body.mesh.position.x += body.velocity.x * dt * globalSpeedFactor;
      body.mesh.position.y += body.velocity.y * dt * globalSpeedFactor;

      // Wall collisions (по круговому баундингу и текущим мировым границам)
      const r = body.boundingRadius;
      const bx = worldBoundsX;
      const by = worldBoundsY;

      if (body.mesh.position.x - r < -bx) {
        body.mesh.position.x = -bx + r;
        body.velocity.x *= -1;
      } else if (body.mesh.position.x + r > bx) {
        body.mesh.position.x = bx - r;
        body.velocity.x *= -1;
      }

      if (body.mesh.position.y - r < -by) {
        body.mesh.position.y = -by + r;
        body.velocity.y *= -1;
      } else if (body.mesh.position.y + r > by) {
        body.mesh.position.y = by - r;
        body.velocity.y *= -1;
      }
    }

    // Body–body collisions (SAT for выпуклые многоугольники, equal mass)
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];


        const vertsA = getWorldVertices(a);
        const vertsB = getWorldVertices(b);
        const result = polygonPolygonSAT(vertsA, vertsB);

        if (!result) continue;

        let { normal, depth } = result;

        // Убедимся, что нормаль направлена от A к B
        const cxA = a.mesh.position.x;
        const cyA = a.mesh.position.y;
        const cxB = b.mesh.position.x;
        const cyB = b.mesh.position.y;
        const centerDirX = cxB - cxA;
        const centerDirY = cyB - cyA;
        if (centerDirX * normal.x + centerDirY * normal.y < 0) {
          normal.x *= -1;
          normal.y *= -1;
        }

        // Раздвигаем тела с учётом массы: лёгкие смещаются сильнее, тяжёлые — меньше
        const invMassA = a.isDragged ? 0 : a.invMass;
        const invMassB = b.isDragged ? 0 : b.invMass;
        const invMassSum = invMassA + invMassB;
        if (invMassSum === 0) {
          continue;
        }
        const correctionA = depth * (invMassA / invMassSum);
        const correctionB = depth * (invMassB / invMassSum);
        a.mesh.position.x -= normal.x * correctionA;
        a.mesh.position.y -= normal.y * correctionA;
        b.mesh.position.x += normal.x * correctionB;
        b.mesh.position.y += normal.y * correctionB;

        // Отражаем скорости по нормали (упругое столкновение)
        const rvx = b.velocity.x - a.velocity.x;
        const rvy = b.velocity.y - a.velocity.y;
        const velAlongNormal = rvx * normal.x + rvy * normal.y;

        if (velAlongNormal < 0) {
          const restitution = 1.0;
          const invMassA2 = a.isDragged ? 0 : a.invMass;
          const invMassB2 = b.isDragged ? 0 : b.invMass;
          const invMassSum2 = invMassA2 + invMassB2;
          if (invMassSum2 === 0) {
            continue;
          }

          const jImpulse = -(1 + restitution) * velAlongNormal / invMassSum2;

          const impulseX = jImpulse * normal.x;
          const impulseY = jImpulse * normal.y;

          a.velocity.x -= impulseX * invMassA2;
          a.velocity.y -= impulseY * invMassA2;
          b.velocity.x += impulseX * invMassB2;
          b.velocity.y += impulseY * invMassB2;

          // Добавляем вращение при столкновении (всегда одинаково)
          const velTangent = rvx * -normal.y + rvy * normal.x;
          const baseSpinFactor = 0.18;
          const spinFactorA = baseSpinFactor * (a.speedScale || 1);
          const spinFactorB = baseSpinFactor * (b.speedScale || 1);
          const maxAngVel = 4.0;

          if (a.shapeType === 'rect' || a.shapeType === 'tri' || a.shapeType === 'circle') {
            a.angularVelocity -= velTangent * spinFactorA;
            if (a.angularVelocity > maxAngVel) a.angularVelocity = maxAngVel;
            if (a.angularVelocity < -maxAngVel) a.angularVelocity = -maxAngVel;
          }
          if (b.shapeType === 'rect' || b.shapeType === 'tri' || b.shapeType === 'circle') {
            b.angularVelocity += velTangent * spinFactorB;
            if (b.angularVelocity > maxAngVel) b.angularVelocity = maxAngVel;
            if (b.angularVelocity < -maxAngVel) b.angularVelocity = -maxAngVel;
          }
          // Передаём цвет от одной фигуры другой при столкновении (если включено)
          if (colorTransferEnabled) {
            transferColorOnCollision(a, b);
          }
        }
      }
    }

    // После интеграции и столкновений проверяем, движется ли ещё что‑нибудь.
    let anyMoving = false;
    const linearEps = 0.02;
    const angularEps = 0.4;

    for (const body of bodies) {
      if (body.isDragged) {
        anyMoving = true;
        break;
      }
      const speed = Math.hypot(body.velocity.x, body.velocity.y);
      const angSpeed = Math.abs(body.angularVelocity || 0);
      if (speed > linearEps || angSpeed > angularEps) {
        anyMoving = true;
        break;
      }
    }

    // Если все фигуры остановились — автоматически ставим "паузу"
    if (!anyMoving) {
      setPhysicsEnabled(false);
    }
  }

  function animate(time) {
    if (lastTime === null) {
      lastTime = time;
    }
    let dt = (time - lastTime) / 1000; // seconds
    lastTime = time;

    // Clamp dt to avoid huge jumps (e.g. tab switched)
    dt = Math.min(dt, 0.05);

    // Fixed small physics step to reduce tunneling at high speeds
    const fixedStep = 0.01;
    accumulator += dt;

    while (accumulator >= fixedStep) {
      updatePhysics(fixedStep);
      accumulator -= fixedStep;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

// Helper to save the current canvas as an image
function saveCurrentCanvas() {
  const sourceCanvas = document.getElementById('app');
  if (!sourceCanvas) {
    console.warn('Canvas element #app not found');
    return;
  }

  // Создаём отдельный канвас, чтобы добавить однородную рамку нужного цвета.
  const borderSize = 100;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = sourceCanvas.width + borderSize * 2;
  exportCanvas.height = sourceCanvas.height + borderSize * 2;
  const exportCtx = exportCanvas.getContext('2d');

  if (!exportCtx) {
    console.warn('Unable to obtain 2D context for export canvas');
    return;
  }

  exportCtx.fillStyle = CANVAS_BACKGROUND_COLOR;
  exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  exportCtx.drawImage(sourceCanvas, borderSize, borderSize);

  const filenameTimestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `thequot-es-${filenameTimestamp}.png`;

  // Простое определение iOS (iPhone / iPad / iPod)
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

  try {
    if (isIOS && navigator.share) {
      // На iOS открываем системный share sheet с файлом PNG.
      // В нём есть пункт "Сохранить изображение", который кладёт картинку в Фотоплёнку.
      exportCanvas.toBlob(async (blob) => {
        if (!blob) {
          console.warn('Failed to create blob from canvas');
          return;
        }

        const file = new File([blob], filename, { type: 'image/png' });

        try {
          await navigator.share({
            files: [file],
            title: 'thequot.es',
            text: 'Generated artwork from thequot.es'
          });
          // Если пользователь выбрал "Сохранить изображение",
          // iOS положит файл в Фото / Фотоплёнку.
          return;
        } catch (err) {
          console.warn('navigator.share failed on iOS, falling back to direct download:', err);
          const dataUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = dataUrl;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(dataUrl);
        }
      }, 'image/png');
      return;
    }

    // Для десктопов и остальных устройств — обычное скачивание файла
    const dataUrl = exportCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (e) {
    console.error('Failed to save canvas as image:', e);
  }
}

// Глобально отключаем даблклик‑зум на мобильных (iOS Safari и др.)
if (typeof document !== 'undefined') {
  document.addEventListener(
    'dblclick',
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );
}

function createRefreshButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '↻';
  btn.setAttribute('aria-label', 'Refresh composition');

  // Compact circular button in the bottom-right corner,
  // larger on any small screen (по меньшей стороне окна).
  const minSide = Math.min(window.innerWidth, window.innerHeight);
  const isSmallScreen = minSide <= 1040;

  // Общая панель для всех кнопок управления в один ряд снизу
  let controlsBar = document.getElementById('controls-bar');
  if (!controlsBar) {
    controlsBar = document.createElement('div');
    controlsBar.id = 'controls-bar';
    controlsBar.style.position = 'fixed';
    controlsBar.style.left = '50%';
    controlsBar.style.transform = 'translateX(-50%)';
    controlsBar.style.bottom = isSmallScreen ? '20px' : '16px';
    controlsBar.style.display = 'flex';
    controlsBar.style.gap = isSmallScreen ? '18px' : '10px';
    controlsBar.style.alignItems = 'center';
    controlsBar.style.justifyContent = 'center';
    controlsBar.style.zIndex = '10';
    // Hint to browser that this is a controls bar, not a zoom target
    controlsBar.style.touchAction = 'manipulation';
    document.body.appendChild(controlsBar);
    // Disable text selection and touch callouts on the controls bar
    controlsBar.style.userSelect = 'none';
    controlsBar.style.webkitUserSelect = 'none';
    controlsBar.style.MozUserSelect = 'none';
    controlsBar.style.msUserSelect = 'none';
    controlsBar.style.webkitTouchCallout = 'none';
    controlsBar.style.WebkitTapHighlightColor = 'transparent';
  }

  btn.style.position = 'relative';
  btn.style.width = isSmallScreen ? '80px' : '32px';
  btn.style.height = isSmallScreen ? '80px' : '32px';
  btn.style.borderRadius = '50%';
  btn.style.border = 'none';
  btn.style.padding = '0';
  btn.style.display = 'flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.fontSize = isSmallScreen ? '24px' : '18px';
  btn.style.lineHeight = isSmallScreen ? '52px' : '32px';
  btn.style.cursor = 'pointer';
  btn.style.background = 'rgba(255,255,255,0.12)';
  btn.style.color = '#ffffff';
  btn.style.backdropFilter = 'blur(8px)';
  btn.style.touchAction = 'manipulation';

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(255,255,255,0.22)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(255,255,255,0.12)';
  });

  btn.addEventListener('click', () => {
    const newSeed = getSeed();
    regenerateComposition(newSeed);
  });


  // --- Save canvas button ---
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '💾';
  saveBtn.setAttribute('aria-label', 'Save current image');

  saveBtn.style.position = 'relative';
  saveBtn.style.width = isSmallScreen ? '80px' : '32px';
  saveBtn.style.height = isSmallScreen ? '80px' : '32px';
  saveBtn.style.borderRadius = '50%';
  saveBtn.style.border = 'none';
  saveBtn.style.padding = '0';
  saveBtn.style.display = 'flex';
  saveBtn.style.alignItems = 'center';
  saveBtn.style.justifyContent = 'center';
  saveBtn.style.fontSize = isSmallScreen ? '24px' : '18px';
  saveBtn.style.lineHeight = isSmallScreen ? '52px' : '32px';
  saveBtn.style.cursor = 'pointer';
  saveBtn.style.background = 'rgba(255,255,255,0.12)';
  saveBtn.style.color = '#ffffff';
  saveBtn.style.backdropFilter = 'blur(8px)';
  saveBtn.style.touchAction = 'manipulation';

  saveBtn.addEventListener('mouseenter', () => {
    saveBtn.style.background = 'rgba(255,255,255,0.22)';
  });
  saveBtn.addEventListener('mouseleave', () => {
    saveBtn.style.background = 'rgba(255,255,255,0.12)';
  });

  saveBtn.addEventListener('click', () => {
    saveCurrentCanvas();
  });


  // --- Play / Pause toggle button ---
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playPauseButton = playBtn;
  // Иконка зависит от текущего состояния физики
  playBtn.textContent = physicsEnabled ? '⏸' : '▶';
  playBtn.setAttribute('aria-label', 'Play / Pause animation');

  playBtn.style.position = 'relative';
  playBtn.style.width = isSmallScreen ? '80px' : '32px';
  playBtn.style.height = isSmallScreen ? '80px' : '32px';
  playBtn.style.borderRadius = '50%';
  playBtn.style.border = 'none';
  playBtn.style.padding = '0';
  playBtn.style.display = 'flex';
  playBtn.style.alignItems = 'center';
  playBtn.style.justifyContent = 'center';
  playBtn.style.fontSize = isSmallScreen ? '24px' : '18px';
  playBtn.style.lineHeight = isSmallScreen ? '52px' : '32px';
  playBtn.style.cursor = 'pointer';
  playBtn.style.background = 'rgba(255,255,255,0.12)';
  playBtn.style.color = '#ffffff';
  playBtn.style.backdropFilter = 'blur(8px)';
  playBtn.style.touchAction = 'manipulation';

  playBtn.addEventListener('mouseenter', () => {
    playBtn.style.background = 'rgba(255,255,255,0.22)';
  });
  playBtn.addEventListener('mouseleave', () => {
    playBtn.style.background = 'rgba(255,255,255,0.12)';
  });

  playBtn.addEventListener('click', () => {
    const willEnable = !physicsEnabled;
    setPhysicsEnabled(willEnable);
    // Если мы переходим в режим Play, даём всем фигурам импульс.
    if (willEnable) {
      applyPlayImpulse();
    }
  });

  // Сохраняем ссылку на кнопку Play/Pause, чтобы другие контролы могли менять её иконку.



  // --- Color transfer ON/OFF toggle button ---
  const colorBtn = document.createElement('button');
  colorBtn.type = 'button';
  colorBtn.textContent = '◩'; // OFF state icon
  colorBtn.setAttribute('aria-label', 'Toggle color swapping on collisions');

  colorBtn.style.position = 'relative';
  colorBtn.style.width = isSmallScreen ? '80px' : '32px';
  colorBtn.style.height = isSmallScreen ? '80px' : '32px';
  colorBtn.style.borderRadius = '50%';
  colorBtn.style.border = 'none';
  colorBtn.style.padding = '0';
  colorBtn.style.display = 'flex';
  colorBtn.style.alignItems = 'center';
  colorBtn.style.justifyContent = 'center';
  colorBtn.style.fontSize = isSmallScreen ? '26px' : '18px';
  colorBtn.style.lineHeight = isSmallScreen ? '52px' : '32px';
  colorBtn.style.cursor = 'pointer';
  colorBtn.style.background = 'rgba(255,255,255,0.12)';
  colorBtn.style.color = '#ffffff';
  colorBtn.style.backdropFilter = 'blur(8px)';
  colorBtn.style.touchAction = 'manipulation';

  function updateColorButtonVisual() {
    // По умолчанию переключение OFF: более тёмный фон.
    colorBtn.style.background = colorTransferEnabled
      ? 'rgba(255,255,255,0.32)'
      : 'rgba(255,255,255,0.12)';
  }

  colorBtn.addEventListener('mouseenter', () => {
    const baseAlpha = colorTransferEnabled ? 0.42 : 0.22;
    colorBtn.style.background = `rgba(255,255,255,${baseAlpha})`;
  });

  colorBtn.addEventListener('mouseleave', () => {
    updateColorButtonVisual();
  });

  colorBtn.addEventListener('click', () => {
    colorTransferEnabled = !colorTransferEnabled;
    // OFF → ◩, ON → ◪
    colorBtn.textContent = colorTransferEnabled ? '◪' : '◩';
    updateColorButtonVisual();
  });

  // Инициализируем визуал согласно значению по умолчанию (OFF)
  updateColorButtonVisual();
  colorBtn.textContent = '◩';

  // Disable text selection and touch callouts on all control buttons
  [btn, saveBtn, playBtn, colorBtn].forEach(el => {
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.MozUserSelect = 'none';
    el.style.msUserSelect = 'none';
    el.style.webkitTouchCallout = 'none';
    el.style.WebkitTapHighlightColor = 'transparent';
  });
  // Append buttons in desired order: Play, Refresh, Color, Save
  controlsBar.appendChild(playBtn);
  controlsBar.appendChild(btn);
  controlsBar.appendChild(colorBtn);
  controlsBar.appendChild(saveBtn);
}

(function main() {
  const seed = getSeed();
  createScene(seed);
  createRefreshButton();
})();
