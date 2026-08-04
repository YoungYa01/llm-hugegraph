function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialPoint(node, index, width, height) {
  const hash = hashString(node.name);
  const angle = ((hash % 3600) / 3600) * Math.PI * 2 + index * 0.73;
  const radius = 70 + (hash % 190) + Math.sqrt(index + 1) * 16;
  const x = width / 2 + Math.cos(angle) * radius;
  const y = height / 2 + Math.sin(angle) * radius * 0.72;
  return { name: node.name, x, y, vx: 0, vy: 0, fx: null, fy: null, initialX: x, initialY: y };
}

const publicPosition = (point) => ({ x: point.x, y: point.y });

function applyCollisions(points, nodeRadius) {
  const minimumDistance = nodeRadius * 2 + 4;
  const cellSize = minimumDistance;
  const grid = new Map();
  points.forEach((point) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    const key = `${cellX}:${cellY}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(point);
  });

  let maxMovement = 0;
  points.forEach((point) => {
    const cellX = Math.floor(point.x / cellSize);
    const cellY = Math.floor(point.y / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nearby = grid.get(`${cellX + offsetX}:${cellY + offsetY}`) || [];
        nearby.forEach((other) => {
          if (point.name >= other.name) return;
          let deltaX = other.x - point.x;
          let deltaY = other.y - point.y;
          let distance = Math.hypot(deltaX, deltaY);
          if (distance >= minimumDistance) return;
          if (distance < 0.001) {
            deltaX = hashString(`${point.name}:${other.name}`) % 2 ? 1 : -1;
            deltaY = 0.5;
            distance = Math.hypot(deltaX, deltaY);
          }
          const overlap = minimumDistance - distance;
          const unitX = deltaX / distance;
          const unitY = deltaY / distance;
          const pointFixed = Number.isFinite(point.fx) && Number.isFinite(point.fy);
          const otherFixed = Number.isFinite(other.fx) && Number.isFinite(other.fy);
          if (pointFixed && otherFixed) return;
          const pointShare = otherFixed ? overlap : overlap / 2;
          const otherShare = pointFixed ? overlap : overlap / 2;
          if (!pointFixed) {
            point.x -= unitX * pointShare;
            point.y -= unitY * pointShare;
          }
          if (!otherFixed) {
            other.x += unitX * otherShare;
            other.y += unitY * otherShare;
          }
          maxMovement = Math.max(maxMovement, pointShare, otherShare);
        });
      }
    }
  });
  return maxMovement;
}

export function createForceLayout(nodes, edges, options = {}) {
  const width = Number(options.width) || 960;
  const height = Number(options.height) || 620;
  const nodeRadius = Number(options.nodeRadius) || 30;
  const linkDistance = Number(options.linkDistance) || 132;
  const points = new Map(nodes.map((node, index) => [node.name, initialPoint(node, index, width, height)]));
  const primaryChain = options.mode === "incident" && Array.isArray(options.primaryChain)
    ? options.primaryChain.filter((name) => points.has(name))
    : [];
  const chainTargets = new Map(primaryChain.map((name, index) => [
    name,
    {
      x: primaryChain.length === 1
        ? width / 2
        : 90 + ((width - 180) * index) / (primaryChain.length - 1),
      y: height / 2,
    },
  ]));
  const chainNames = new Set(primaryChain);
  let alpha = 1;

  const step = () => {
    (edges || []).forEach((edge) => {
      const source = points.get(edge.source);
      const target = points.get(edge.target);
      if (!source || !target || source === target) return;
      const deltaX = target.x - source.x;
      const deltaY = target.y - source.y;
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY));
      const force = (distance - linkDistance) * 0.035 * alpha;
      const forceX = (deltaX / distance) * force;
      const forceY = (deltaY / distance) * force;
      if (!Number.isFinite(source.fx)) {
        source.vx += forceX;
        source.vy += forceY;
      }
      if (!Number.isFinite(target.fx)) {
        target.vx -= forceX;
        target.vy -= forceY;
      }
    });

    let maxMovement = 0;
    points.forEach((point, name) => {
      if (Number.isFinite(point.fx) && Number.isFinite(point.fy)) {
        point.x = point.fx;
        point.y = point.fy;
        point.vx = 0;
        point.vy = 0;
        return;
      }
      const target = chainTargets.get(name);
      if (target) {
        point.vx += (target.x - point.x) * 0.08 * alpha;
        point.vy += (target.y - point.y) * 0.035 * alpha;
      } else if (primaryChain.length > 1 && !chainNames.has(name)) {
        const corridorRadius = 118;
        const corridorOffset = point.y - height / 2;
        if (Math.abs(corridorOffset) < corridorRadius) {
          const direction = corridorOffset === 0
            ? (hashString(name) % 2 ? 1 : -1)
            : Math.sign(corridorOffset);
          point.vy += direction * (corridorRadius - Math.abs(corridorOffset)) * 0.045 * alpha;
        }
      }
      point.vx += (width / 2 - point.x) * 0.0007 * alpha;
      point.vy += (height / 2 - point.y) * 0.0007 * alpha;
      point.vx *= 0.78;
      point.vy *= 0.78;
      point.x += point.vx;
      point.y += point.vy;
      if (![point.x, point.y, point.vx, point.vy].every(Number.isFinite)) {
        point.x = point.initialX;
        point.y = point.initialY;
        point.vx = 0;
        point.vy = 0;
        point.fx = null;
        point.fy = null;
      }
      maxMovement = Math.max(maxMovement, Math.abs(point.vx) + Math.abs(point.vy));
    });
    maxMovement = Math.max(maxMovement, applyCollisions([...points.values()], nodeRadius));
    alpha *= 0.94;
    return alpha < 0.015 && maxMovement < 0.08;
  };

  return {
    position(name) {
      const point = points.get(name);
      return point ? publicPosition(point) : null;
    },
    snapshot() {
      return nodes.map(({ name }) => ({ name, ...publicPosition(points.get(name)) }));
    },
    pin(name, x, y) {
      const point = points.get(name);
      if (!point) return;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        point.x = point.initialX;
        point.y = point.initialY;
        point.vx = 0;
        point.vy = 0;
        point.fx = null;
        point.fy = null;
        return;
      }
      point.x = x;
      point.y = y;
      point.fx = x;
      point.fy = y;
    },
    move(name, x, y) {
      this.pin(name, x, y);
    },
    clearPins() {
      points.forEach((point) => {
        point.fx = null;
        point.fy = null;
      });
    },
    reset() {
      alpha = 1;
      points.forEach((point) => {
        point.x = point.initialX;
        point.y = point.initialY;
        point.vx = 0;
        point.vy = 0;
        point.fx = null;
        point.fy = null;
      });
    },
    reheat() {
      alpha = 1;
      points.forEach((point) => {
        point.vx *= 0.2;
        point.vy *= 0.2;
      });
    },
    step,
    settle(limit = 240) {
      for (let index = 0; index < limit; index += 1) {
        if (step()) break;
      }
    },
  };
}
